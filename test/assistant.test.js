const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

process.env.PORT = '0';
process.env.GEMINI_API_KEY_1 = 'test-gemini-key-1';
process.env.GEMINI_API_KEY_2 = 'test-gemini-key-2';
process.env.GEMINI_API_KEY_3 = 'test-gemini-key-3';
process.env.GEMINI_API_KEY_4 = 'test-gemini-key-4';
process.env.GEMINI_MODEL = 'gemini-2.5-flash';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'sb_publishable_test-key';
process.env.APP_TIME_ZONE = 'Europe/Lisbon';
process.env.GEMINI_TIMEOUT_MS = '1000';
process.env.OPENROUTER_API_KEY = '';
delete process.env.OPENROUTER_MODELS;

const userId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const pendingId = '00000000-0000-4000-8000-000000000003';
const ritaId = '00000000-0000-4000-8000-000000000004';
const carlosId = '00000000-0000-4000-8000-000000000005';
const employees = [
  { id: ritaId, workspace_id: workspaceId, name: 'Rita Sousa', role: 'Pizzaiola', status: 'active', sort_order: 0 },
  { id: carlosId, workspace_id: workspaceId, name: 'Carlos Silva', role: 'Atendimento', status: 'active', sort_order: 1 }
];
const scheduleEntries = [];
const calls = [];
let aiResponses = [];
let openRouterResponses = [];
let aiFailureStatus = 0;
let aiFailureStatuses = [];
const geminiKeysUsed = [];
let pendingRecord = null;
let scheduleMonth = null;
let createExpiredPending = false;
let scheduleInsertFailure = false;
let server;
let baseUrl;

function geminiResponse(parts) {
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
}

function enqueueText(text) {
  aiResponses.push(geminiResponse([{ text }]));
}

function enqueueCall(name, args) {
  aiResponses.push(geminiResponse([{ functionCall: { name, args } }]));
}

function makeJson(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'openrouter.ai') {
    const headers = new Headers(options.headers);
    calls.push({
      service: 'openrouter',
      body: JSON.parse(options.body),
      authorization: headers.get('authorization')
    });
    const response = openRouterResponses.shift();
    assert.ok(response, 'expected a queued OpenRouter response');
    return makeJson(response.body, response.status || 200);
  }
  if (url.hostname === 'generativelanguage.googleapis.com') {
    calls.push({ service: 'gemini', body: JSON.parse(options.body) });
    const requestHeaders = new Headers(options.headers);
    geminiKeysUsed.push(requestHeaders.get('x-goog-api-key') || url.searchParams.get('key'));
    const status = aiFailureStatuses.length ? aiFailureStatuses.shift() : aiFailureStatus;
    if (status) {
      aiFailureStatus = 0;
      return makeJson({ error: { message: 'test failure' } }, status);
    }
    const response = aiResponses.shift();
    assert.ok(response, 'expected a queued Gemini response');
    return makeJson(response);
  }

  assert.equal(url.hostname, 'supabase.test');
  calls.push({ service: 'supabase', method: options.method || 'GET', path: url.pathname + url.search, body: options.body ? JSON.parse(options.body) : null });
  if (url.pathname === '/auth/v1/user') return makeJson({ id: userId });
  if (url.pathname === '/rest/v1/workspaces') return makeJson([{ id: workspaceId, owner_id: userId }]);

  if (url.pathname === '/rest/v1/employees') {
    if (options.method === 'POST') {
      const employee = JSON.parse(options.body);
      employees.push({ ...employee, id: '00000000-0000-4000-8000-000000000006' });
      return makeJson(null, 201);
    }
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body);
      const id = url.searchParams.get('id').slice(3);
      const employee = employees.find(item => item.id === id);
      if (employee) Object.assign(employee, patch);
      return makeJson(null, 204);
    }
    if (options.method === 'DELETE') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const employeeIndex = employees.findIndex(item => item.id === id && item.workspace_id === workspaceId);
      if (employeeIndex >= 0) {
        employees.splice(employeeIndex, 1);
        for (let i = scheduleEntries.length - 1; i >= 0; i--) {
          if (scheduleEntries[i].employee_id === id) scheduleEntries.splice(i, 1);
        }
      }
      return makeJson(null, 204);
    }
    const status = (url.searchParams.get('status') || '').replace(/^eq\./, '');
    return makeJson(employees.filter(item => item.workspace_id === workspaceId && (!status || item.status === status)));
  }

  if (url.pathname === '/rest/v1/ai_action_log') {
    if (options.method === 'POST') {
      pendingRecord = {
        id: pendingId,
        action: JSON.parse(options.body).action,
        status: 'pending',
        structured_command: JSON.parse(options.body).structured_command,
        created_at: new Date(Date.now() - (createExpiredPending ? 16 * 60 * 1000 : 0)).toISOString()
      };
      createExpiredPending = false;
      return makeJson([{ id: pendingId, created_at: pendingRecord.created_at }], 201);
    }
    if (options.method === 'PATCH') {
      Object.assign(pendingRecord, JSON.parse(options.body));
      return makeJson([{ id: pendingRecord.id }]);
    }
    return makeJson(pendingRecord?.status === 'pending' ? [pendingRecord] : []);
  }

  if (url.pathname === '/rest/v1/schedule_months') {
    if (options.method === 'POST') {
      scheduleMonth = { id: '00000000-0000-4000-8000-000000000007', ...JSON.parse(options.body) };
      return makeJson([scheduleMonth], 201);
    }
    if (options.method === 'PATCH') {
      Object.assign(scheduleMonth, JSON.parse(options.body));
      return makeJson(null, 204);
    }
    return makeJson(scheduleMonth ? [scheduleMonth] : []);
  }

  if (url.pathname === '/rest/v1/workspace_settings') return makeJson([{ monthly_days_off: 7 }]);
  if (url.pathname === '/rest/v1/schedule_entries') {
    if (options.method === 'POST') {
      if (scheduleInsertFailure) {
        scheduleInsertFailure = false;
        return makeJson({
          code: '42501',
          message: 'new row violates row-level security policy',
          details: 'test policy rejection',
          hint: 'test RLS policy'
        }, 403);
      }
      const rows = JSON.parse(options.body);
      for (const row of (Array.isArray(rows) ? rows : [rows])) {
        const existingIndex = scheduleEntries.findIndex(entry => entry.schedule_month_id === row.schedule_month_id
          && entry.employee_id === row.employee_id && entry.work_date === row.work_date);
        if (existingIndex < 0) scheduleEntries.push(row);
        else scheduleEntries[existingIndex] = row;
      }
      return makeJson(null, 201);
    }
    const scheduleId = (url.searchParams.get('schedule_month_id') || '').replace(/^eq\./, '');
    const employeeId = (url.searchParams.get('employee_id') || '').replace(/^eq\./, '');
    return makeJson(scheduleEntries.filter(entry => (!scheduleId || entry.schedule_month_id === scheduleId)
      && (!employeeId || entry.employee_id === employeeId)));
  }
  return makeJson({ error: 'unmocked endpoint' }, 404);
};

const application = require('../server.js');
server = application.server;

before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function request(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const outgoing = http.request(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        ...headers
      }
    }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: content ? JSON.parse(content) : null
      }));
    });
    outgoing.on('error', reject);
    outgoing.end(data);
  });
}

function requestRaw(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, content }));
    }).on('error', reject);
  });
}

const sessionHeaders = {
  Authorization: 'Bearer test-user-access-token',
  'X-Workspace-Id': workspaceId
};

test('assistant chat, safe navigation, queries and confirmed writes', async t => {
  await t.test('rejects Supabase secret keys and accepts supported public key formats', () => {
    assert.equal(application.isPublicSupabaseKey('sb_publishable_example'), true);
    assert.equal(application.isPublicSupabaseKey('sb_secret_example'), false);
    const anonJwt = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`;
    const serviceJwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
    assert.equal(application.isPublicSupabaseKey(anonJwt), true);
    assert.equal(application.isPublicSupabaseKey(serviceJwt), false);
  });

  await t.test('only returns a publishable Supabase key to the browser', async () => {
    const config = await request('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.supabaseAnonKey, 'sb_publishable_test-key');
  });

  await t.test('serves only public assets and never exposes server or environment files', async () => {
    const html = await requestRaw('/');
    assert.equal(html.status, 200);
    const client = await requestRaw('/app.js');
    assert.equal(client.status, 200);
    for (const path of ['/server.js', '/.env', '/.env.example', '/package.json', '/supabase-schema.sql', '/test/assistant.test.js']) {
      const response = await requestRaw(path);
      assert.equal(response.status, 404, `${path} must not be publicly served`);
      assert.equal(response.content, 'Not found');
    }
  });

  await t.test('rejects assistant API calls without an authenticated session', async () => {
    const response = await request('/api/chat', { message: 'mostra a equipa', history: [], month: 9, year: 2026 });
    assert.equal(response.status, 401);
  });

  await t.test('returns natural non-repeated casual text without an action', async () => {
    enqueueText('Bom dia! Espero que o teu dia esteja a correr bem.');
    const response = await request('/api/chat', { message: 'bom dia', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.body.message, 'Bom dia! Espero que o teu dia esteja a correr bem.');
    assert.equal(response.body.action, null);
    assert.equal(response.body.pendingOperation, null);
    enqueueText('Olá! Em que posso ajudar hoje?');
    const nextResponse = await request('/api/chat', { message: 'olá', history: [{ role: 'user', text: 'bom dia' }], month: 9, year: 2026 }, sessionHeaders);
    assert.notEqual(nextResponse.body.message, response.body.message);
  });

  await t.test('sanitizes navigation and search into the real UI allowlist', async () => {
    enqueueCall('assistant_ui_action', { type: 'navigate', tab: 'team' });
    const team = await request('/api/chat', { message: 'abre a equipa', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(team.body.action, { type: 'navigate', tab: 'team' });

    enqueueCall('assistant_ui_action', { type: 'navigate', tab: 'schedule' });
    const schedule = await request('/api/chat', { message: 'vai para horários', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(schedule.body.action, { type: 'navigate', tab: 'schedule' });

    enqueueCall('assistant_ui_action', { type: 'search_employee', query: 'Rita' });
    const search = await request('/api/chat', { message: 'procura a Rita', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(search.body.action, { type: 'search_employee', query: 'Rita' });

    enqueueCall('assistant_ui_action', { type: 'navigate', tab: 'document.cookie' });
    const blocked = await request('/api/chat', { message: 'abre isto', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(blocked.body.action, null);

    enqueueCall('assistant_ui_action', { type: 'set_team_filters', query: 'Rita', shift: 'evening', role: 'Pizzaiola' });
    const filters = await request('/api/chat', { message: 'filtra a equipa', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(filters.body.action, {
      type: 'set_team_filters',
      query: 'Rita',
      shift: 'evening',
      role: 'Pizzaiola'
    });

    {
      const previousKey = process.env.OPENROUTER_API_KEY;
      const previousModels = process.env.OPENROUTER_MODELS;
      process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
      process.env.OPENROUTER_MODELS = '["google/gemini-2.0-flash-001","openai/gpt-4o-mini"]';
      openRouterResponses.push({
        body: {
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'assistant_ui_action',
                  arguments: JSON.stringify({ type: 'navigate', tab: 'schedule' })
                }
              }]
            }
          }]
        }
      });
      try {
        const response = await request('/api/chat', { message: 'abre os horários', history: [], month: 9, year: 2026 }, sessionHeaders);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.action, { type: 'navigate', tab: 'schedule' });
        const providerCall = calls.findLast(call => call.service === 'openrouter');
        assert.equal(providerCall.authorization, 'Bearer test-openrouter-key');
        assert.deepEqual(providerCall.body.models, ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini']);
        assert.equal(providerCall.body.max_tokens, 1000);
        assert.equal(providerCall.body.tools[0].function.parameters.type, 'object');
      } finally {
        if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = previousKey;
        if (previousModels === undefined) delete process.env.OPENROUTER_MODELS;
        else process.env.OPENROUTER_MODELS = previousModels;
      }
    }

    enqueueCall('assistant_ui_action', { type: 'edit_employee', employee_name: 'Rita Sousa' });
    const edit = await request('/api/chat', { message: 'edita a Rita', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(edit.body.action, { type: 'open_edit_employee', employeeId: ritaId });

    enqueueCall('assistant_ui_action', { type: 'show_schedule_month', month: 12, year: 2026 });
    const month = await request('/api/chat', { message: 'abre dezembro', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(month.body.action, { type: 'show_schedule_month', month: 12, year: 2026 });

    enqueueCall('assistant_ui_action', { type: 'export_schedule', format: 'pdf' });
    const exportPdf = await request('/api/chat', { message: 'exporta a escala em pdf', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.deepEqual(exportPdf.body.action, { type: 'export_schedule', format: 'pdf' });

    enqueueCall('assistant_ui_action', { type: 'set_team_filters', query: '', shift: 'morning', role: 'Nonexistent' });
    const invalidRole = await request('/api/chat', { message: 'filtra função inexistente', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(invalidRole.body.action, null);
    assert.match(invalidRole.body.message, /Não encontrei funcionários com a função/);
  });

  await t.test('answers factual queries from RLS-protected schedule data', async () => {
    scheduleMonth = null;
    enqueueCall('query_team_data', { query_type: 'employee_leave_stats', employee_name: 'Rita Sousa' });
    const response = await request('/api/chat', { message: 'quantas folgas tem a Rita?', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.match(response.body.message, /0\/7 folgas usadas · 7 restantes/);
    assert.equal(response.body.action, null);

    scheduleMonth = { id: '00000000-0000-4000-8000-000000000007', month_start: '2026-09-01', cleared: false };
    enqueueCall('query_team_data', { query_type: 'employee_leave_stats', employee_name: 'Rita Sousa' });
    const emptyStoredSchedule = await request('/api/chat', { message: 'quantas folgas tem a Rita?', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.match(emptyStoredSchedule.body.message, /0\/7 folgas usadas · 7 restantes/);

    scheduleMonth = null;
    enqueueCall('query_team_data', { query_type: 'uncovered_shifts' });
    const coverage = await request('/api/chat', { message: 'há turnos sem cobertura?', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.match(coverage.body.message, /menos de 3 pessoas num dos turnos/);
  });

  await t.test('stores a creation proposal and writes only after confirmation', async () => {
    const beforeCount = employees.length;
    enqueueCall('prepare_data_operation', { operation: 'create_employee', employee_name: 'Ana', role: 'Cozinha' });
    const prepared = await request('/api/chat', { message: 'cria a funcionária Ana', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.pendingOperation.type, 'create_employee');
    assert.equal(Object.hasOwn(prepared.body.pendingOperation, 'payload'), false);
    assert.equal(employees.length, beforeCount);
    const savedProposal = calls.findLast(call => call.service === 'supabase' && call.method === 'POST' && call.path.startsWith('/rest/v1/ai_action_log'));
    assert.equal(savedProposal.body.structured_command.name, 'Ana');

    const invalidConfirmation = await request('/api/confirm-operation', {
      pendingOperationId: prepared.body.pendingOperation.id,
      name: 'untrusted browser payload'
    }, sessionHeaders);
    assert.equal(invalidConfirmation.status, 400);
    assert.equal(employees.length, beforeCount);

    const confirmed = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(confirmed.status, 200);
    assert.equal(employees.some(employee => employee.name === 'Ana' && employee.status === 'active'), true);
    assert.equal(pendingRecord.status, 'completed');
  });

  await t.test('interprets tomorrow in Lisbon time and waits for confirmation before changing the schedule', async () => {
    scheduleMonth = null;
    scheduleEntries.splice(0, scheduleEntries.length);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const tomorrowDate = new Date(`${today}T00:00:00Z`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrow = tomorrowDate.toISOString().slice(0, 10);
    enqueueCall('prepare_data_operation', {
      operation: 'create_time_off',
      employee_name: 'Rita Sousa',
      date: tomorrow,
      shift: 'off'
    });
    const prepared = await request('/api/chat', { message: 'marca folga para a Rita amanhã', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(prepared.body.pendingOperation.type, 'update_shift_assignment');
    assert.match(prepared.body.pendingOperation.summary, new RegExp(tomorrow));
    assert.equal(scheduleEntries.length, 0);

    const confirmed = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(confirmed.status, 200);
    assert.match(confirmed.body.message, /1\/7 folgas usadas e 6 restantes/);
    assert.equal(scheduleEntries.some(entry => entry.employee_id === ritaId && entry.work_date === tomorrow && entry.shift === 'off'), true);

    enqueueCall('prepare_data_operation', {
      operation: 'create_time_off',
      employee_name: 'Rita Sousa',
      date: tomorrow,
      shift: 'off'
    });
    const duplicateProposal = await request('/api/chat', { message: 'marca folga para a Rita amanhã', history: [], month: 9, year: 2026 }, sessionHeaders);
    const duplicate = await request('/api/confirm-operation', { pendingOperationId: duplicateProposal.body.pendingOperation.id }, sessionHeaders);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'duplicate_time_off');
    assert.match(duplicate.body.message, /Já existe uma folga/);
  });

  await t.test('rechecks the monthly leave limit on confirmation', async () => {
    const year = new Date().getFullYear();
    const date = `${year}-09-27`;
    scheduleMonth = { id: '00000000-0000-4000-8000-000000000007', month_start: `${year}-09-01`, cleared: false };
    scheduleEntries.splice(0, scheduleEntries.length, ...Array.from({ length: 7 }, (_, index) => ({
      schedule_month_id: scheduleMonth.id,
      employee_id: ritaId,
      work_date: `${year}-09-${String(index + 1).padStart(2, '0')}`,
      shift: 'off'
    })));
    enqueueCall('prepare_data_operation', {
      operation: 'create_time_off',
      employee_name: 'Rita Sousa',
      date,
      shift: 'off'
    });
    const prepared = await request('/api/chat', { message: 'marca folga para a Rita no dia 27', history: [], month: 9, year: 2026 }, sessionHeaders);
    const before = scheduleEntries.length;
    const response = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'monthly_leave_limit');
    assert.equal(scheduleEntries.length, before);
  });

  await t.test('keeps pending leave operation after RLS failure and chat remains available', async () => {
    scheduleMonth = { id: '00000000-0000-4000-8000-000000000007', month_start: `${new Date().getFullYear()}-09-01`, cleared: false };
    scheduleEntries.splice(0, scheduleEntries.length);
    const year = new Date().getFullYear();
    const date = `${year}-09-28`;
    enqueueCall('prepare_data_operation', {
      operation: 'create_time_off',
      employee_name: 'Rita Sousa',
      date,
      shift: 'off'
    });
    const prepared = await request('/api/chat', { message: 'marca folga para a Rita no dia 28', history: [], month: 9, year }, sessionHeaders);
    scheduleInsertFailure = true;
    const failed = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(failed.status, 403);
    assert.equal(failed.body.code, 'rls_denied');
    assert.equal(failed.body.retryable, true);
    assert.equal(pendingRecord.status, 'pending');
    assert.equal(scheduleEntries.length, 0);

    enqueueText('Ainda estou disponível para ajudar.');
    const chatAfterFailure = await request('/api/chat', { message: 'olá', history: [], month: 9, year }, sessionHeaders);
    assert.equal(chatAfterFailure.status, 200);
    assert.equal(chatAfterFailure.body.message, 'Ainda estou disponível para ajudar.');

    const retried = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(retried.status, 200);
    assert.equal(scheduleEntries.length, 1);
  });

  await t.test('rejects expired pending operations with a clear response', async () => {
    createExpiredPending = true;
    enqueueCall('prepare_data_operation', { operation: 'delete_employee', employee_name: 'Carlos Silva' });
    const prepared = await request('/api/chat', { message: 'remove o Carlos', history: [], month: 9, year: 2026 }, sessionHeaders);
    const expired = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'operation_expired');
    assert.match(expired.body.message, /expirou/);
  });

  await t.test('permanent employee deletion requires confirmation and deletes schedule history', async () => {
    const carlos = employees.find(employee => employee.id === carlosId);
    const carlosCopy = { ...carlos };
    scheduleEntries.push({ employee_id: carlosId, work_date: '2026-09-01', shift: 'morning' });
    const historyCount = scheduleEntries.length;
    enqueueCall('prepare_data_operation', { operation: 'delete_employee', employee_name: 'Carlos Silva' });
    const prepared = await request('/api/chat', { message: 'remove o Carlos', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(prepared.body.pendingOperation.type, 'delete_employee');
    assert.ok(employees.some(employee => employee.id === carlosId));
    assert.equal(scheduleEntries.length, historyCount);
    const result = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(result.status, 200);
    assert.equal(employees.some(employee => employee.id === carlosId), false);
    assert.equal(scheduleEntries.some(entry => entry.employee_id === carlosId), false);
    assert.equal(calls.some(call => call.service === 'supabase' && call.method === 'DELETE'
      && call.path.startsWith(`/rest/v1/employees?id=eq.${carlosId}`)), true);
    employees.push(carlosCopy);
  });

  await t.test('generates a monthly schedule only after confirmation and preserves seven days off', async () => {
    scheduleEntries.length = 0;
    scheduleMonth = null;
    enqueueCall('prepare_data_operation', { operation: 'generate_schedule', month: 9, year: 2026, period: 'month' });
    const prepared = await request('/api/chat', { message: 'gera o horário deste mês', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(prepared.body.pendingOperation.type, 'generate_schedule');
    assert.equal(scheduleEntries.length, 0);
    const result = await request('/api/confirm-operation', { pendingOperationId: prepared.body.pendingOperation.id }, sessionHeaders);
    assert.equal(result.status, 200);
    assert.equal(scheduleMonth.generated, true);
    assert.equal(scheduleEntries.length, employees.filter(employee => employee.status === 'active').length * 30);
    const activeIds = new Set(employees.filter(employee => employee.status === 'active').map(employee => employee.id));
    activeIds.forEach(id => {
      assert.equal(scheduleEntries.filter(entry => entry.employee_id === id && entry.shift === 'off').length, 7);
    });
  });

  await t.test('distinguishes rejected Gemini credentials without exposing provider details', async () => {
    aiFailureStatuses = [401, 401, 401, 401];
    const response = await request('/api/chat', { message: 'olá', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(response.status, 503);
    assert.equal(response.body.message, 'As chaves Gemini configuradas foram recusadas. Verifica GEMINI_API_KEY_1 a GEMINI_API_KEY_4 no servidor.');
    assert.equal(response.body.action, null);
    assert.equal(response.body.pendingOperation, null);
    assert.doesNotMatch(JSON.stringify(response.body), /test-gemini-key|test-public-key|test failure/i);
  });

  await t.test('retries a transient Gemini overload and returns tool proposals normally', async () => {
    aiFailureStatuses = [503];
    enqueueCall('prepare_data_operation', {
      operation: 'create_employee',
      employee_name: 'Funcionário de Teste',
      role: 'Colaborador'
    });
    const response = await request('/api/chat', { message: 'cria o funcionário de teste', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.body.pendingOperation.type, 'create_employee');
    assert.equal(response.body.pendingOperation.summary.includes('Funcionário de Teste'), true);
    assert.equal(aiFailureStatuses.length, 0);
  });

  await t.test('starts successive requests with different Gemini keys', async () => {
    const start = geminiKeysUsed.length;
    enqueueText('Resposta um.');
    enqueueText('Resposta dois.');
    const first = await request('/api/chat', { message: 'olá', history: [], month: 9, year: 2026 }, sessionHeaders);
    const second = await request('/api/chat', { message: 'bom dia', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(geminiKeysUsed[start], geminiKeysUsed[start + 1]);
  });

  await t.test('rotates through alternate Gemini keys on HTTP 429', async () => {
    const start = geminiKeysUsed.length;
    aiFailureStatuses = [429];
    enqueueCall('prepare_data_operation', {
      operation: 'create_employee',
      employee_name: 'Ana de Teste',
      role: 'Colaboradora'
    });
    const response = await request('/api/chat', { message: 'cria a funcionária Ana de Teste', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.body.pendingOperation.type, 'create_employee');
    assert.equal(geminiKeysUsed.length - start, 2);
    assert.notEqual(geminiKeysUsed[start], geminiKeysUsed[start + 1]);
  });

  await t.test('reports quota unavailable after every configured Gemini key returns 429', async () => {
    aiFailureStatuses = [429, 429, 429, 429];
    const response = await request('/api/chat', { message: 'olá', history: [], month: 9, year: 2026 }, sessionHeaders);
    assert.equal(response.status, 503);
    assert.equal(response.body.message, 'O Gemini atingiu temporariamente o limite de pedidos. Aguarda um pouco e tenta novamente.');
    assert.equal(aiFailureStatuses.length, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /test-gemini-key/i);
  });
});
