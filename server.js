const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const PDFDocument = require('pdfkit');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiApiKeys = [...new Set([
  ...Object.keys(process.env)
    .map(name => {
      const match = name.match(/^GEMINI_API_KEY_(\d+)$/);
      return match ? { index: Number(match[1]), value: process.env[name] } : null;
    })
    .filter(entry => entry && Number.isSafeInteger(entry.index))
    .sort((left, right) => left.index - right.index)
    .map(entry => entry.value)
].map(key => String(key || '').trim()).filter(Boolean))];
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const appTimeZone = process.env.APP_TIME_ZONE || 'Europe/Lisbon';
const requestTimeoutMs = Math.max(1000, Math.min(60000, Number(process.env.GEMINI_TIMEOUT_MS) || 15000));
const geminiRetryDelayMs = 700;
const defaultOpenRouterModels = ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'];

function getOpenRouterModels() {
  const configured = String(process.env.OPENROUTER_MODELS || '').trim();
  if (!configured) return defaultOpenRouterModels;
  let models;
  try {
    models = JSON.parse(configured);
  } catch {
    throw new Error('OPENROUTER_MODELS must be a JSON array of model identifiers.');
  }
  if (!Array.isArray(models) || !models.length || models.length > 5
    || models.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9._/-]{2,100}$/i.test(name.trim()))
    || new Set(models.map(name => name.trim())).size !== models.length) {
    throw new Error('OPENROUTER_MODELS must contain 1 to 5 unique model identifiers.');
  }
  return models.map(name => name.trim());
}

let nextGeminiKeyIndex = 0;
const geminiClients = geminiApiKeys.map(apiKey => new GoogleGenerativeAI(apiKey));
const aiTools = [{
  functionDeclarations: [{
    name: 'assistant_ui_action',
    description: 'Executa apenas uma navegação interna permitida, pesquisa de funcionário ou abertura do formulário de criação. Nunca altera dados.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: {
          type: SchemaType.STRING,
          enum: ['navigate', 'search_employee', 'open_create_employee', 'edit_employee', 'set_team_filters', 'show_schedule_month', 'export_schedule']
        },
        tab: {
          type: SchemaType.STRING,
          enum: ['overview', 'schedule', 'team'],
          description: 'Aba real da aplicação.'
        },
        query: {
          type: SchemaType.STRING,
          description: 'Texto de pesquisa do funcionário, quando solicitado.'
        },
        employee_name: {
          type: SchemaType.STRING,
          description: 'Nome completo para abrir a edição de um funcionário.'
        },
        shift: {
          type: SchemaType.STRING,
          enum: ['all', 'morning', 'evening', 'off'],
          description: 'Filtro de turno na equipa.'
        },
        role: {
          type: SchemaType.STRING,
          description: 'Filtro de função na equipa.'
        },
        month: { type: SchemaType.INTEGER, description: 'Mês da escala, de 1 a 12.' },
        year: { type: SchemaType.INTEGER, description: 'Ano da escala.' },
        format: {
          type: SchemaType.STRING,
          enum: ['excel', 'pdf'],
          description: 'Formato de exportação da escala.'
        }
      },
      required: ['type']
    }
  }, {
    name: 'query_team_data',
    description: 'Consulta dados reais da equipa e da escala sem alterar qualquer registo.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query_type: {
          type: SchemaType.STRING,
          enum: ['team_list', 'employee_leave_stats', 'today_schedule', 'uncovered_shifts']
        },
        employee_name: { type: SchemaType.STRING },
        date: { type: SchemaType.STRING, description: 'Data local ISO YYYY-MM-DD, se necessária.' }
      },
      required: ['query_type']
    }
  }, {
    name: 'prepare_bulk_schedule_update',
    description: 'Prepara UMA única operação em lote para vários funcionários e vários dias. Use obrigatoriamente para pedidos com "todos", vários nomes ou intervalos de datas. Nunca divide o pedido em várias confirmações; a operação fica pendente até o gerente confirmar.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        all_employees: { type: SchemaType.BOOLEAN, description: 'Definir true apenas quando o utilizador disser todos/toda a equipa.' },
        employee_names: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Nomes dos funcionários ativos exatamente como fornecidos no contexto. Ignorado quando all_employees é true.'
        },
        start_date: { type: SchemaType.STRING, description: 'Primeiro dia do intervalo inclusive, ISO YYYY-MM-DD.' },
        end_date: { type: SchemaType.STRING, description: 'Último dia do intervalo inclusive, ISO YYYY-MM-DD.' },
        action: { type: SchemaType.STRING, enum: ['set', 'clear'], description: 'set define os turnos; clear deixa as células sem horário.' },
        shift: { type: SchemaType.STRING, enum: ['morning', 'evening', 'off', 'custom'], description: 'Turno a definir quando action=set.' },
        custom_shift: { type: SchemaType.STRING, description: 'Texto livre até 50 caracteres quando shift=custom.' }
      },
      required: ['start_date', 'end_date', 'action']
    }
  }, {
    name: 'prepare_data_operation',
    description: 'Prepara uma proposta de escrita e aguarda confirmação explícita. Nunca executa a escrita.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        operation: {
          type: SchemaType.STRING,
          enum: ['create_employee', 'update_employee', 'delete_employee', 'create_time_off', 'update_shift_assignment', 'generate_schedule', 'publish_schedule']
        },
        employee_name: { type: SchemaType.STRING },
        role: { type: SchemaType.STRING },
        new_name: { type: SchemaType.STRING },
        date: { type: SchemaType.STRING, description: 'Data local ISO YYYY-MM-DD.' },
        shift: { type: SchemaType.STRING, enum: ['morning', 'evening', 'off'] },
        month: { type: SchemaType.INTEGER },
        year: { type: SchemaType.INTEGER },
        period: { type: SchemaType.STRING, enum: ['month', 'week'] }
      },
      required: ['operation']
    }
  }]
}];

const systemPrompt = `És o assistente do Mr Pizza, uma aplicação de gestão de equipa, horários e turnos. Falas sempre em português de Portugal, de forma clara, simpática e concisa. Podes conversar naturalmente sobre assuntos gerais. Não forces o tema de horários ou equipa em mensagens sociais como "olá", "bom dia" ou "só quero conversar".

Usa assistant_ui_action para navegar nas secções overview, schedule e team; pesquisar e filtrar a equipa; abrir formulários de criação/edição; selecionar um mês da escala; ou exportar a escala para Excel/PDF. Executa estas ações apenas quando o utilizador as pedir.

Usa query_team_data para responder a perguntas factuais sobre funcionários, folgas, escala de hoje ou cobertura. Baseia-te apenas nos dados devolvidos pela aplicação. Nunca inventes funcionários, datas, IDs, resultados ou cobertura.

Usa prepare_bulk_schedule_update obrigatoriamente quando o utilizador pedir uma alteração para vários funcionários, para todos, ou para um intervalo de dias. Resolve nomes apenas com a lista de funcionários ativos fornecida pela aplicação. Prepara um único lote e uma única confirmação; não simules ações individuais nem declares que a alteração foi executada.

Usa prepare_data_operation para uma alteração individual ou para criar/editar/remover funcionário, gerar ou publicar horário. As ferramentas de escrita só criam propostas pendentes que o gerente terá de confirmar explicitamente; nunca executam a escrita. Antes de apresentar a proposta, resume concisamente quantas células, quem e que intervalo serão afetados e pergunta se confirma. Se faltar nome, intervalo ou turno necessário, pede esclarecimento em vez de inventar ou escrever apenas uma parte.

Publicar horários não é suportado pelo schema atual; informa essa limitação em vez de alegar sucesso. Nunca afirmes que uma alteração foi gravada antes de a confirmação e a escrita no servidor terminarem. Nunca peças, reveles ou exponhas chaves, palavras-passe, tokens ou outros segredos. Respostas sem ferramenta são texto normal, sem JSON.`;

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 256000) {
        const error = new Error('Request too large');
        error.status = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

function assistantResult(message, action = null, pendingOperation = null) {
  return { message, action, pendingOperation };
}

function sanitizeAssistantAction(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'navigate' && ['overview', 'schedule', 'team'].includes(action.tab)) {
    return { type: 'navigate', tab: action.tab };
  }
  if (action.type === 'search_employee') {
    const query = String(action.query || '').trim().slice(0, 80);
    return query ? { type: 'search_employee', query } : null;
  }
  if (action.type === 'open_create_employee') return { type: 'open_create_employee' };
  if (action.type === 'edit_employee') {
    const employeeName = cleanText(action.employee_name, 80);
    return employeeName ? { type: 'edit_employee', employeeName } : null;
  }
  if (action.type === 'set_team_filters') {
    const shift = ['all', 'morning', 'evening', 'off'].includes(action.shift) ? action.shift : 'all';
    return {
      type: 'set_team_filters',
      query: cleanText(action.query, 80),
      shift,
      role: cleanText(action.role, 80)
    };
  }
  if (action.type === 'show_schedule_month') {
    const month = Number(action.month);
    const year = Number(action.year);
    return Number.isInteger(month) && month >= 1 && month <= 12
      && Number.isInteger(year) && year >= 2020 && year <= 2100
      ? { type: 'show_schedule_month', month, year }
      : null;
  }
  if (action.type === 'export_schedule' && ['excel', 'pdf'].includes(action.format)) {
    return { type: 'export_schedule', format: action.format };
  }
  return null;
}

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-PT');
}

function cleanText(value, maxLength = 100) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function formatDateInZone(date = new Date()) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: appTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const parts = Object.fromEntries(values.map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function requireSupabaseConfig() {
  if (!supabaseUrl || !isPublicSupabaseKey(supabaseAnonKey)) {
    const error = new Error('Supabase URL or publishable key is missing or invalid');
    error.status = 503;
    error.publicCode = 'configuration_missing';
    throw error;
  }
}

function isPublicSupabaseKey(key) {
  if (key.startsWith('sb_publishable_')) return true;
  if (key.startsWith('sb_secret_')) return false;
  const segments = key.split('.');
  if (segments.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')).role === 'anon';
  } catch {
    return false;
  }
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1].length > 4096) return '';
  return match[1];
}

async function supabaseFetch(token, endpoint, options = {}) {
  requireSupabaseConfig();
  const method = options.method || 'GET';
  const response = await fetch(`${supabaseUrl}${endpoint}`, {
    method,
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const body = await response.text();
  if (!response.ok) {
    let result = {};
    try {
      result = body ? JSON.parse(body) : {};
    } catch {
      result = {};
    }
    const remoteError = result.error && typeof result.error === 'object' ? result.error : result;
    const error = new Error(`Supabase ${method} request failed (${response.status})`);
    error.status = response.status;
    error.supabase = {
      status: response.status,
      code: cleanText(remoteError.code, 80),
      message: cleanText(remoteError.message, 500),
      details: cleanText(remoteError.details, 500),
      hint: cleanText(remoteError.hint, 500)
    };
    if (response.status === 401) error.publicCode = 'authentication_required';
    if (response.status === 403) error.publicCode = 'rls_denied';
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

async function authenticateRequest(request) {
  const token = getBearerToken(request);
  if (!token) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }
  const user = await supabaseFetch(token, '/auth/v1/user');
  if (!user || typeof user.id !== 'string') {
    const error = new Error('Authentication failed');
    error.status = 401;
    throw error;
  }
  const workspaceId = String(request.headers['x-workspace-id'] || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    const error = new Error('Workspace is invalid');
    error.status = 400;
    throw error;
  }
  const workspaces = await supabaseFetch(token, `/rest/v1/workspaces?id=eq.${workspaceId}&select=id,owner_id`);
  if (!Array.isArray(workspaces) || !workspaces.some(workspace => workspace.id === workspaceId && workspace.owner_id === user.id)) {
    const error = new Error('Workspace access denied');
    error.status = 403;
    throw error;
  }
  return { token, userId: user.id, workspaceId };
}

async function getActiveEmployees(session) {
  return supabaseFetch(session.token, `/rest/v1/employees?workspace_id=eq.${session.workspaceId}&status=eq.active&select=id,name,role,initials,color,status,sort_order&order=sort_order.asc`);
}

async function getWorkspaceEmployees(session) {
  return supabaseFetch(session.token, `/rest/v1/employees?workspace_id=eq.${session.workspaceId}&select=id,name,role,status,sort_order&order=sort_order.asc`);
}

function findEmployee(employees, name) {
  const normalized = normalizeName(name);
  return employees.find(employee => normalizeName(employee.name) === normalized) || null;
}

async function getScheduleMonth(session, year, month, create = false) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const found = await supabaseFetch(session.token, `/rest/v1/schedule_months?workspace_id=eq.${session.workspaceId}&month_start=eq.${monthStart}&select=id,month_start,generated,cleared`);
  if (found?.[0] || !create) return found?.[0] || null;
  const created = await supabaseFetch(session.token, '/rest/v1/schedule_months?on_conflict=workspace_id,month_start', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: { workspace_id: session.workspaceId, month_start: monthStart, generated: false, cleared: false }
  });
  return Array.isArray(created) ? created[0] : null;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function explicitDaysOff(entries, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return new Set((entries || [])
    .filter(entry => entry.shift === 'off' && typeof entry.work_date === 'string'
      && entry.work_date.startsWith(prefix) && isValidIsoDate(entry.work_date))
    .map(entry => entry.work_date));
}

function defaultScheduleShift(employeeIndex, day, dayCount) {
  const offDays = new Set(Array.from({ length: Math.min(7, dayCount) }, (_, index) =>
    (Math.floor(index * dayCount / 7) + employeeIndex) % dayCount + 1
  ));
  if (offDays.has(day)) return 'off';
  return employeeIndex % 2 ? 'evening' : 'morning';
}

function effectiveScheduleShift(schedule, entryByDate, employeeId, employeeIndex, date, dayCount) {
  const stored = entryByDate.get(`${employeeId}|${date}`);
  if (stored) return typeof stored === 'string' ? stored : stored.custom_shift || stored.shift;
  if (schedule?.cleared) return 'unset';
  return defaultScheduleShift(employeeIndex, Number(date.slice(8, 10)), dayCount);
}

async function createPendingOperation(session, command, summary, type) {
  const rows = await supabaseFetch(session.token, '/rest/v1/ai_action_log?select=id,created_at', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      workspace_id: session.workspaceId,
      user_id: session.userId,
      action: `assistant_${command.operation}`,
      status: 'pending',
      structured_command: command
    }
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id || !row.created_at) throw new Error('Pending operation could not be stored');
  const expiresAt = new Date(new Date(row.created_at).getTime() + 15 * 60 * 1000).toISOString();
  return assistantResult(`Proposta: ${summary}. Confirmas?`, null, {
    id: row.id,
    type,
    summary,
    expiresAt
  });
}

async function queryTeamData(session, args, context) {
  const employees = await getActiveEmployees(session);
  const queryType = args.query_type;
  if (queryType === 'team_list') {
    const names = employees.map(employee => `${employee.name} (${employee.role})`);
    return assistantResult(names.length ? `A equipa ativa é: ${names.join(', ')}.` : 'Neste momento não há funcionários ativos na equipa.');
  }
  if (queryType === 'employee_leave_stats') {
    const employee = findEmployee(employees, args.employee_name);
    if (!employee) return assistantResult('Não encontrei esse funcionário na equipa ativa. Podes confirmar o nome?');
    const year = context.year;
    const month = context.month;
    const schedule = await getScheduleMonth(session, year, month);
    const entries = schedule
      ? await supabaseFetch(session.token, `/rest/v1/schedule_entries?schedule_month_id=eq.${schedule.id}&employee_id=eq.${employee.id}&select=work_date,shift`)
      : [];
    const daysOff = explicitDaysOff(entries, year, month).size;
    const remaining = Math.max(0, 7 - daysOff);
    const source = schedule
      ? 'contadas apenas as folgas registadas explicitamente'
      : 'ainda não há escala guardada nem folgas registadas';
    return assistantResult(`${employee.name}: ${daysOff}/7 folgas usadas · ${remaining} restantes este mês (${source}).`);
  }
  if (queryType === 'today_schedule') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(args.date || '') ? args.date : context.today;
    const schedule = await getScheduleMonth(session, Number(date.slice(0, 4)), Number(date.slice(5, 7)));
    if (!schedule) {
      const dayCount = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
      const daily = employees.map((person, index) => ({
        name: person.name,
        shift: defaultScheduleShift(index, Number(date.slice(8, 10)), dayCount)
      }));
      return assistantResult(`Para ${date}, estão em serviço: ${daily.filter(item => item.shift !== 'off').map(item => item.name).join(', ') || 'ninguém'}. De folga: ${daily.filter(item => item.shift === 'off').map(item => item.name).join(', ') || 'ninguém'}. Esta é a escala predefinida ainda não guardada.`);
    }
    const entries = await supabaseFetch(session.token, `/rest/v1/schedule_entries?schedule_month_id=eq.${schedule.id}&work_date=eq.${date}&select=employee_id,work_date,shift,custom_shift`);
    const entryByDate = new Map((entries || []).map(entry => [`${entry.employee_id}|${date}`, entry]));
    const dayCount = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
    const effective = employees.map((person, index) => ({
      name: person.name,
      shift: effectiveScheduleShift(schedule, entryByDate, person.id, index, date, dayCount)
    }));
    const source = schedule.cleared ? 'nos registos atuais' : 'na escala atual';
    const working = effective.filter(item => item.shift === 'morning' || item.shift === 'evening');
    const custom = effective.filter(item => item.shift !== 'off' && item.shift !== 'unset'
      && item.shift !== 'morning' && item.shift !== 'evening');
    const customText = custom.length ? ` Horários personalizados: ${custom.map(item => `${item.name} (${cleanText(item.shift, 50)})`).join(', ')}.` : '';
    return assistantResult(`Para ${date}, estão em serviço: ${working.map(item => item.name).join(', ') || 'ninguém'}. De folga: ${effective.filter(item => item.shift === 'off').map(item => item.name).join(', ') || 'ninguém'}.${customText} (${source}).`);
  }
  if (queryType === 'uncovered_shifts') {
    const year = context.year;
    const month = context.month;
    const schedule = await getScheduleMonth(session, year, month);
    const missingDays = [];
    if (!schedule) {
      const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= dayCount; day += 1) {
        const shifts = employees.map((employee, index) => defaultScheduleShift(index, day, dayCount));
        const morning = shifts.filter(shift => shift === 'morning').length;
        const evening = shifts.filter(shift => shift === 'evening').length;
        if (morning < 3 || evening < 3) {
          missingDays.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} (${morning}/3 dia, ${evening}/3 noite)`);
        }
      }
      return assistantResult(missingDays.length
        ? `Na escala predefinida, estes dias têm menos de 3 pessoas num dos turnos: ${missingDays.join(', ')}. A escala ainda não foi guardada.`
        : 'A escala predefinida cumpre o mínimo de 3 pessoas em cada turno; ainda não foi guardada.');
    }
    const entries = await supabaseFetch(session.token, `/rest/v1/schedule_entries?schedule_month_id=eq.${schedule.id}&select=employee_id,work_date,shift,custom_shift`);
    const entryByDate = new Map((entries || []).map(entry => [`${entry.employee_id}|${entry.work_date}`, entry]));
    const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= dayCount; day += 1) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const shifts = employees.map((person, index) =>
        effectiveScheduleShift(schedule, entryByDate, person.id, index, date, dayCount));
      const morning = shifts.filter(shift => shift === 'morning').length;
      const evening = shifts.filter(shift => shift === 'evening').length;
      if (morning < 3 || evening < 3) {
        missingDays.push(`${date} (${morning}/3 dia, ${evening}/3 noite)`);
      }
    }
    return assistantResult(missingDays.length
      ? `Dias com menos de 3 pessoas num dos turnos: ${missingDays.join(', ')}.`
      : 'A cobertura atual cumpre o mínimo de 3 pessoas em cada turno em todos os dias do mês.');
  }
  return assistantResult('Não consegui identificar essa consulta.');
}

function makeDateRange(startDate, endDate) {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate) || startDate > endDate) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const dates = [];
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10));
    if (dates.length > 31) return null;
  }
  return dates;
}

async function prepareBulkScheduleUpdate(session, args, context) {
  const dates = makeDateRange(String(args.start_date || ''), String(args.end_date || ''));
  if (!dates) return assistantResult('Indica um intervalo válido de datas, com início anterior ao fim e no máximo 31 dias.');
  const year = Number(dates[0].slice(0, 4));
  const month = Number(dates[0].slice(5, 7));
  if (dates.some(date => Number(date.slice(0, 4)) !== context.year
    || Number(date.slice(0, 4)) !== year || Number(date.slice(5, 7)) !== month)) {
    return assistantResult(`O intervalo tem de ficar dentro de um único mês do ano ${context.year}.`);
  }
  if (!['set', 'clear'].includes(args.action)) {
    return assistantResult('Indica se queres definir um turno ou deixar os campos sem horário.');
  }
  let shift = 'unset';
  let customShift = null;
  if (args.action === 'set') {
    if (args.shift === 'custom') {
      customShift = cleanText(args.custom_shift, 100);
      if (!customShift) return assistantResult('Indica o texto do horário personalizado, até 50 caracteres.');
      if (customShift.length > 50) return assistantResult('O horário personalizado pode ter no máximo 50 caracteres.');
    } else if (['morning', 'evening', 'off'].includes(args.shift)) {
      shift = args.shift;
    } else {
      return assistantResult('Indica se queres o turno do dia, da noite, folga ou um texto personalizado.');
    }
  }

  const activeEmployees = await getActiveEmployees(session);
  let selectedEmployees;
  if (args.all_employees === true) {
    selectedEmployees = activeEmployees;
  } else {
    const requestedNames = Array.isArray(args.employee_names)
      ? [...new Set(args.employee_names.map(name => cleanText(name, 80)).filter(Boolean))]
      : [];
    if (!requestedNames.length || requestedNames.length > 100) {
      return assistantResult('Indica um ou mais nomes exatos, ou confirma que a alteração é para toda a equipa.');
    }
    const missingNames = requestedNames.filter(name => !findEmployee(activeEmployees, name));
    if (missingNames.length) {
      return assistantResult(`Não encontrei ${missingNames.join(', ')} na equipa ativa; não preparei nenhuma alteração. Confirma os nomes.`);
    }
    selectedEmployees = [...new Map(requestedNames
      .map(name => findEmployee(activeEmployees, name))
      .map(employee => [employee.id, employee])).values()];
  }
  if (!selectedEmployees.length) return assistantResult('Não há funcionários ativos para alterar.');
  if (selectedEmployees.length * dates.length > 500) {
    return assistantResult(`Este lote abrangeria ${selectedEmployees.length * dates.length} células. O limite seguro é 500 células por confirmação; reduz a equipa ou o intervalo.`);
  }

  const employeeNames = selectedEmployees.map(employee => employee.name);
  const shiftLabel = args.action === 'clear' ? 'deixar sem horário'
    : customShift ? `definir "${customShift}"`
      : shift === 'morning' ? 'definir o turno do dia'
        : shift === 'evening' ? 'definir o turno da noite' : 'marcar folga';
  const lastDate = dates[dates.length - 1];
  const rangeLabel = `${dates[0].slice(8, 10)}/${dates[0].slice(5, 7)} a ${lastDate.slice(8, 10)}/${lastDate.slice(5, 7)}/${year}`;
  const namesLabel = employeeNames.length <= 6
    ? employeeNames.join(', ')
    : `${employeeNames.slice(0, 5).join(', ')} e mais ${employeeNames.length - 5}`;
  const summary = `${shiftLabel} para ${employeeNames.length} funcionário(s) (${namesLabel}) de ${rangeLabel}, total ${employeeNames.length * dates.length} células`;
  return createPendingOperation(session, {
    operation: 'bulk_update_schedule',
    employeeIds: selectedEmployees.map(employee => employee.id),
    employeeNames,
    dates,
    shift,
    customShift,
    action: args.action,
    month,
    year
  }, summary, 'bulk_update_schedule');
}

async function prepareOperation(session, args, context) {
  const operation = args.operation;
  if (operation === 'publish_schedule') {
    return assistantResult('A publicação de horários ainda não é suportada: o schema atual não tem estado de publicação nem fluxo de distribuição.');
  }

  if (operation === 'create_employee') {
    const name = cleanText(args.employee_name, 80);
    if (!name) return assistantResult('Qual é o nome do funcionário que pretendes adicionar?', { type: 'open_create_employee' });
    const employees = await getWorkspaceEmployees(session);
    if (employees.some(employee => normalizeName(employee.name) === normalizeName(name))) {
      return assistantResult(`Já existe um funcionário chamado ${name} na equipa ativa.`);
    }
    const role = cleanText(args.role || 'Novo membro', 80);
    return createPendingOperation(session, { operation, name, role }, `adicionar ${name} à equipa como ${role}`, 'create_employee');
  }

  if (operation === 'generate_schedule') {
    if (args.period === 'week') {
      return assistantResult('A geração de uma escala semanal ainda não está implementada; a aplicação suporta apenas geração mensal.');
    }
    const month = Number.isInteger(args.month) ? args.month : context.month;
    const year = Number.isInteger(args.year) ? args.year : context.year;
    if (month < 1 || month > 12 || year !== context.year) {
      return assistantResult('Só posso preparar a geração do mês atualmente suportado pela aplicação.');
    }
    const employees = await getActiveEmployees(session);
    if (!employees.length) return assistantResult('Adiciona pelo menos um funcionário antes de gerar a escala.');
    if (employees.length > 100) return assistantResult('A geração está limitada a 100 funcionários por mês.');
    return createPendingOperation(session, { operation, month, year }, `gerar o horário de ${month}/${year} para toda a equipa`, 'generate_schedule');
  }

  const employees = await getActiveEmployees(session);
  const employee = findEmployee(employees, args.employee_name);
  if (!employee) {
    return assistantResult(args.employee_name
      ? `Não encontrei "${cleanText(args.employee_name, 80)}" na equipa ativa. Confirma o nome?`
      : 'Qual é o nome do funcionário?');
  }

  if (operation === 'delete_employee') {
    return createPendingOperation(session, { operation, employeeId: employee.id }, `apagar permanentemente ${employee.name} e os horários associados`, 'delete_employee');
  }

  if (operation === 'update_employee') {
    const newName = cleanText(args.new_name, 80);
    const role = cleanText(args.role, 80);
    if (!newName && !role) return assistantResult(`O que pretendes alterar no perfil de ${employee.name}?`);
    if (newName && employees.some(person => person.id !== employee.id && normalizeName(person.name) === normalizeName(newName))) {
      return assistantResult(`Já existe outro funcionário chamado ${newName}.`);
    }
    const patch = { operation, employeeId: employee.id };
    if (newName) patch.name = newName;
    if (role) patch.role = role;
    return createPendingOperation(session, patch, `atualizar o perfil de ${employee.name}`, 'update_employee');
  }

  if (operation === 'create_time_off' || operation === 'update_shift_assignment') {
    const date = String(args.date || '');
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      return assistantResult('Para preparar a alteração, preciso de uma data válida no formato dia/mês/ano. Qual é a data?');
    }
    if (Number(date.slice(0, 4)) !== context.year) {
      return assistantResult(`A aplicação só permite alterações na escala de ${context.year}.`);
    }
    const shift = operation === 'create_time_off' ? 'off' : args.shift;
    if (!['morning', 'evening', 'off'].includes(shift)) {
      return assistantResult('Qual turno pretendes atribuir: dia, noite ou folga?');
    }
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const summary = `${shift === 'off' ? 'marcar folga' : `atribuir o turno ${shift === 'morning' ? 'do dia' : 'da noite'}`} a ${employee.name} em ${date}`;
    return createPendingOperation(session, { operation: 'update_shift_assignment', employeeId: employee.id, date, shift, month, year: context.year, day }, summary, 'update_shift_assignment');
  }

  return assistantResult('Esta operação ainda não está disponível no site.');
}

async function processFunctionCall(session, call, context) {
  if (call.name === 'assistant_ui_action') {
    const action = sanitizeAssistantAction(call.args);
    if (!action) return assistantResult('Não consegui identificar uma ação de navegação permitida.');
    if (action.type === 'edit_employee') {
      const employee = findEmployee(await getActiveEmployees(session), action.employeeName);
      if (!employee) return assistantResult('Não encontrei esse funcionário ativo para editar.');
      return assistantResult(`Vou abrir a edição de ${employee.name}.`, { type: 'open_edit_employee', employeeId: employee.id });
    }
    if (action.type === 'set_team_filters') {
      const employees = await getActiveEmployees(session);
      if (action.role && !employees.some(employee => employee.role === action.role)) {
        return assistantResult(`Não encontrei funcionários com a função "${action.role}".`);
      }
      return assistantResult('Vou aplicar os filtros pedidos à equipa.', action);
    }
    if (action.type === 'show_schedule_month') {
      return assistantResult(`Vou abrir a escala de ${String(action.month).padStart(2, '0')}/${action.year}.`, action);
    }
    if (action.type === 'export_schedule') {
      return assistantResult(`Vou exportar a escala atual em ${action.format === 'excel' ? 'Excel' : 'PDF'}.`, action);
    }
    const messages = {
      overview: 'Vou abrir a Visão geral.',
      schedule: 'Vou abrir a secção Horários.',
      team: 'Vou abrir a secção Equipa.'
    };
    if (action.type === 'navigate') return assistantResult(messages[action.tab], action);
    if (action.type === 'search_employee') return assistantResult(`Vou abrir a Equipa e pesquisar por ${action.query}.`, action);
    return assistantResult('Vou abrir o formulário para adicionar um funcionário.', action);
  }
  if (call.name === 'query_team_data') {
    return queryTeamData(session, call.args || {}, context);
  }
  if (call.name === 'prepare_bulk_schedule_update') {
    return prepareBulkScheduleUpdate(session, call.args || {}, context);
  }
  if (call.name === 'prepare_data_operation') {
    return prepareOperation(session, call.args || {}, context);
  }
  throw new Error('Unknown assistant function');
}

async function askGemini(session, message, history = [], context = {}) {
  if (String(process.env.OPENROUTER_API_KEY || '').trim()) {
    return askOpenRouter(session, message, history, context);
  }
  if (!geminiClients.length) {
    const error = new Error('No Gemini API key is configured');
    error.publicCode = 'gemini_auth';
    throw error;
  }
  const today = formatDateInZone();
  const currentMonth = Number(today.slice(5, 7));
  const currentYear = Number(today.slice(0, 4));
  const month = Number.isInteger(context.month) && context.month >= 1 && context.month <= 12 ? context.month : currentMonth;
  const year = Number.isInteger(context.year) && context.year >= 2020 && context.year <= 2100 ? context.year : currentYear;
  const requestContext = {
    today,
    timeZone: appTimeZone,
    month,
    year,
    employees: await getActiveEmployees(session)
  };
  const promptContext = `Data local atual (${appTimeZone}): ${today}. Mês selecionado pela aplicação: ${month}/${year}. Funcionários ativos carregados para desambiguação: ${requestContext.employees.map(person => `${person.name} [ID interno não divulgar]`).join(', ') || 'nenhum'}. Para "amanhã" ou outras datas relativas, calcula a data ISO usando a data local atual. Nunca inventes resultados de consultas: usa query_team_data.`;
  const normalizedHistory = (Array.isArray(history) ? history : [])
      .filter(item => item && (item.role === 'user' || item.role === 'model') && typeof item.text === 'string' && item.text.trim())
      .slice(-12)
      .map(item => ({ role: item.role, parts: [{ text: item.text.slice(0, 4000) }] }));
  const startKeyIndex = nextGeminiKeyIndex;
  nextGeminiKeyIndex = (nextGeminiKeyIndex + 1) % geminiClients.length;
  const triedKeys = new Set();
  let activeKeyIndex = startKeyIndex;
  let transientRetryUsed = false;
  let result;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const modelSession = geminiClients[activeKeyIndex].getGenerativeModel({
        model,
        systemInstruction: `${systemPrompt}\n\n${promptContext}`,
        tools: aiTools,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.55 }
      }, { timeout: requestTimeoutMs });
      const chat = modelSession.startChat({ history: normalizedHistory });
      triedKeys.add(activeKeyIndex);
      console.info(`[gemini] generateContent attempt=${attempt} keySlot=${activeKeyIndex + 1}/${geminiClients.length}`);
      result = await chat.sendMessage(message.slice(0, 2000));
      break;
    } catch (error) {
      const providerCode = classifyGeminiError(error);
      if (providerCode === 'gemini_rate_limited' || providerCode === 'gemini_auth') {
        const nextKeyIndex = Array.from({ length: geminiClients.length }, (_, offset) =>
          (activeKeyIndex + offset + 1) % geminiClients.length
        ).find(index => !triedKeys.has(index));
        if (nextKeyIndex !== undefined) {
          console.warn(`[gemini] keySlot=${activeKeyIndex + 1}/${geminiClients.length} error=${providerCode}; rotating to keySlot=${nextKeyIndex + 1}/${geminiClients.length}`);
          activeKeyIndex = nextKeyIndex;
          transientRetryUsed = false;
          continue;
        }
      }
      const canRetryTransiently = ['gemini_overloaded', 'gemini_timeout', 'gemini_network'].includes(providerCode)
        && !transientRetryUsed;
      console.warn(`[gemini] generateContent attempt=${attempt} keySlot=${activeKeyIndex + 1}/${geminiClients.length} error=${providerCode}${canRetryTransiently ? ' retrying=true' : ''}`);
      if (!canRetryTransiently) {
        error.publicCode = providerCode;
        throw error;
      }
      transientRetryUsed = true;
      await new Promise(resolve => setTimeout(resolve, geminiRetryDelayMs));
    }
  }
  const functionCall = result.response.functionCalls()?.[0];
  if (functionCall) return processFunctionCall(session, functionCall, requestContext);
  const text = result.response.text().trim();
  return assistantResult(text || 'Não consegui formular uma resposta agora. Podes tentar novamente?');
}

function openRouterSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  const converted = {};
  if (typeof schema.type === 'string') converted.type = schema.type.toLowerCase();
  if (typeof schema.description === 'string') converted.description = schema.description;
  if (Array.isArray(schema.enum)) converted.enum = schema.enum;
  if (Array.isArray(schema.required)) converted.required = schema.required;
  if (schema.properties && typeof schema.properties === 'object') {
    converted.properties = Object.fromEntries(Object.entries(schema.properties)
      .map(([name, property]) => [name, openRouterSchema(property)]));
  }
  if (schema.items) converted.items = openRouterSchema(schema.items);
  return converted;
}

async function askOpenRouter(session, message, history = [], context = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const models = getOpenRouterModels();
  const today = formatDateInZone();
  const currentMonth = Number(today.slice(5, 7));
  const currentYear = Number(today.slice(0, 4));
  const month = Number.isInteger(context.month) && context.month >= 1 && context.month <= 12 ? context.month : currentMonth;
  const year = Number.isInteger(context.year) && context.year >= 2020 && context.year <= 2100 ? context.year : currentYear;
  const requestContext = {
    today,
    timeZone: appTimeZone,
    month,
    year,
    employees: await getActiveEmployees(session)
  };
  const promptContext = `Data local atual (${appTimeZone}): ${today}. Mês selecionado: ${month}/${year}. Funcionários ativos para desambiguação: ${requestContext.employees.map(person => `${person.name} [ID interno não divulgar]`).join(', ') || 'nenhum'}. Para datas relativas usa a data local. Nunca inventes resultados factuais: consulta query_team_data.`;
  const messages = [
    { role: 'system', content: `${systemPrompt}\n\n${promptContext}` },
    ...(Array.isArray(history) ? history : [])
      .filter(item => item && (item.role === 'user' || item.role === 'model') && typeof item.text === 'string' && item.text.trim())
      .slice(-12)
      .map(item => ({ role: item.role === 'model' ? 'assistant' : 'user', content: item.text.slice(0, 4000) })),
    { role: 'user', content: message.slice(0, 2000) }
  ];
  const tools = aiTools[0].functionDeclarations.map(declaration => ({
    type: 'function',
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: openRouterSchema(declaration.parameters)
    }
  }));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let responseReceived = false;
    try {
      console.info(`[openrouter] chat completion attempt=${attempt}`);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || `http://localhost:${port}`,
          'X-Title': process.env.OPENROUTER_APP_TITLE || 'Mr Pizza'
        },
        body: JSON.stringify({
          models,
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: 1000,
          temperature: 0.55
        }),
        signal: controller.signal
      });
      responseReceived = true;
      clearTimeout(timeout);
      const payload = await response.json().catch(() => ({}));
      console.info(`[openrouter] response model=${cleanText(payload?.model, 100) || 'unknown'}`);
      if (!response.ok) {
        const error = new Error(cleanText(payload?.error?.message || `OpenRouter request failed (${response.status})`, 300));
        error.status = response.status >= 500 ? 503 : response.status;
        error.publicCode = response.status === 401 || response.status === 403 ? 'openrouter_auth'
          : response.status === 429 ? 'openrouter_rate_limited'
            : response.status >= 500 ? 'openrouter_unavailable' : 'openrouter_error';
        if (response.status >= 500 && attempt < 2) {
          console.warn(`[openrouter] request failed status=${response.status}; retrying=true`);
          await new Promise(resolve => setTimeout(resolve, geminiRetryDelayMs));
          continue;
        }
        throw error;
      }
      const assistantMessage = payload?.choices?.[0]?.message;
      const toolCall = assistantMessage?.tool_calls?.[0];
      if (toolCall?.function?.name) {
        let args;
        try {
          args = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
        } catch {
          const error = new Error('OpenRouter returned invalid tool arguments');
          error.status = 502;
          error.publicCode = 'openrouter_invalid_response';
          throw error;
        }
        return processFunctionCall(session, { name: toolCall.function.name, args }, requestContext);
      }
      const text = typeof assistantMessage?.content === 'string' ? assistantMessage.content.trim() : '';
      return assistantResult(text || 'Não consegui formular uma resposta agora. Podes tentar novamente?');
    } catch (error) {
      clearTimeout(timeout);
      if (error.publicCode || responseReceived) throw error;
      if (attempt < 2) {
        console.warn(`[openrouter] request failed error=${controller.signal.aborted ? 'timeout' : 'network'}; retrying=true`);
        await new Promise(resolve => setTimeout(resolve, geminiRetryDelayMs));
        continue;
      }
      error.status = controller.signal.aborted ? 504 : 503;
      error.publicCode = controller.signal.aborted ? 'openrouter_timeout' : 'openrouter_network';
      throw error;
    }
  }
  const error = new Error('OpenRouter is temporarily unavailable');
  error.status = 503;
  error.publicCode = 'openrouter_unavailable';
  throw error;
}

function classifyGeminiError(error) {
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || error?.httpStatus);
  if (status === 429 || /\b429\b|resource_exhausted|quota exceeded|rate.?limit/.test(message)) return 'gemini_rate_limited';
  if (status === 401 || status === 403 || /\b(401|403)\b|api key not valid|invalid api key|permission denied/.test(message)) return 'gemini_auth';
  if (status === 404 || /\b404\b|model.+not found|not found.+model/.test(message)) return 'gemini_model';
  if (error?.name === 'TimeoutError' || /timeout|timed out|request aborted|operation was aborted/.test(message)) return 'gemini_timeout';
  if (/\b503\b|service unavailable|high demand|overloaded/.test(message)) return 'gemini_overloaded';
  if (/\b502\b|\b500\b|internal error|temporarily unavailable/.test(message)) return 'gemini_overloaded';
  if (/fetch failed|network|econnreset|enotfound|socket/.test(message)) return 'gemini_network';
  return 'gemini_error';
}

function redactSensitiveText(value) {
  let text = String(value || '');
  for (const apiKey of geminiApiKeys) text = text.split(apiKey).join('[redacted]');
  const openRouterApiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (openRouterApiKey) text = text.split(openRouterApiKey).join('[redacted]');
  return text.replace(/\bAIza[\w-]{20,}\b|sb_(?:publishable|secret)_[\w-]+/g, '[redacted]');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function markOperationComplete(session, id) {
  const updated = await supabaseFetch(session.token, `/rest/v1/ai_action_log?id=eq.${id}&workspace_id=eq.${session.workspaceId}&user_id=eq.${session.userId}&status=eq.pending&select=id`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status: 'completed', completed_at: new Date().toISOString() }
  });
  if (!Array.isArray(updated) || !updated.some(row => row.id === id)) {
    const error = new Error('Pending operation could not be marked complete');
    error.status = 409;
    error.publicCode = 'operation_state_conflict';
    throw error;
  }
}

const confirmingOperations = new Set();

async function executeConfirmedOperation(session, operationId) {
  console.info(`[confirm-operation] pendingOperationId=${isUuid(operationId) ? operationId : 'invalid'}`);
  if (!isUuid(operationId)) {
    const error = new Error('Pending operation not found');
    error.status = 404;
    error.publicCode = 'operation_not_found';
    throw error;
  }
  const rows = await supabaseFetch(session.token, `/rest/v1/ai_action_log?id=eq.${operationId}&workspace_id=eq.${session.workspaceId}&user_id=eq.${session.userId}&status=eq.pending&select=id,action,structured_command,created_at`);
  const pending = Array.isArray(rows) ? rows[0] : null;
  console.info(`[confirm-operation] pending operation found=${Boolean(pending)}`);
  if (!pending) {
    const error = new Error('Pending operation not found or already confirmed');
    error.status = 404;
    error.publicCode = 'operation_not_found';
    throw error;
  }
  const createdAt = new Date(pending.created_at).getTime();
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60 * 1000) {
    console.warn(`[confirm-operation] pending operation expired=true`);
    await supabaseFetch(session.token, `/rest/v1/ai_action_log?id=eq.${operationId}&workspace_id=eq.${session.workspaceId}&user_id=eq.${session.userId}&status=eq.pending`, {
      method: 'PATCH',
      body: { status: 'cancelled' }
    });
    const error = new Error('Pending operation expired');
    error.status = 410;
    error.publicCode = 'operation_expired';
    throw error;
  }

  const command = pending.structured_command;
  if (!command || typeof command !== 'object' || !String(pending.action).startsWith('assistant_')) {
    const error = new Error('Pending operation is invalid');
    error.status = 400;
    throw error;
  }
  console.info(`[confirm-operation] type=${command.operation}`);
  const employees = await getActiveEmployees(session);
  let message = 'A operação foi concluída.';

  if (command.operation === 'create_employee') {
    const name = cleanText(command.name, 80);
    const role = cleanText(command.role || 'Novo membro', 80);
    if (!name || employees.some(employee => normalizeName(employee.name) === normalizeName(name))) {
      const error = new Error('Employee name is invalid or already exists');
      error.status = 409;
      throw error;
    }
    const initials = name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toLocaleUpperCase('pt-PT');
    await supabaseFetch(session.token, '/rest/v1/employees', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        workspace_id: session.workspaceId,
        name,
        role,
        initials,
        color: 'avatar-red',
        status: 'active',
        sort_order: employees.length
      }
    });
    message = `${name} foi adicionado à equipa.`;
  } else if (command.operation === 'delete_employee') {
    if (!isUuid(command.employeeId) || !employees.some(employee => employee.id === command.employeeId)) {
      const error = new Error('Employee no longer exists');
      error.status = 409;
      throw error;
    }
    await supabaseFetch(session.token, `/rest/v1/employees?id=eq.${command.employeeId}&workspace_id=eq.${session.workspaceId}&status=eq.active`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
    message = 'O funcionário e os horários associados foram apagados permanentemente.';
  } else if (command.operation === 'update_employee') {
    if (!isUuid(command.employeeId) || !employees.some(employee => employee.id === command.employeeId)) {
      const error = new Error('Employee no longer exists');
      error.status = 409;
      throw error;
    }
    const patch = {};
    if (typeof command.name === 'string') patch.name = cleanText(command.name, 80);
    if (typeof command.role === 'string') patch.role = cleanText(command.role, 80);
    if (!Object.keys(patch).length || Object.values(patch).some(value => !value)) {
      const error = new Error('Employee update is invalid');
      error.status = 400;
      throw error;
    }
    if (patch.name) {
      const allEmployees = await getWorkspaceEmployees(session);
      if (allEmployees.some(employee => employee.id !== command.employeeId && normalizeName(employee.name) === normalizeName(patch.name))) {
        const error = new Error('Employee name already exists');
        error.status = 409;
        throw error;
      }
    }
    await supabaseFetch(session.token, `/rest/v1/employees?id=eq.${command.employeeId}&workspace_id=eq.${session.workspaceId}&status=eq.active`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: patch
    });
    message = 'O perfil do funcionário foi atualizado.';
  } else if (command.operation === 'bulk_update_schedule') {
    const ids = Array.isArray(command.employeeIds) ? command.employeeIds : [];
    const dates = Array.isArray(command.dates) ? command.dates : [];
    const employeeById = new Map(employees.map(employee => [employee.id, employee]));
    const selected = [...new Set(ids)];
    const rangeDates = dates.length ? makeDateRange(dates[0], dates[dates.length - 1]) : null;
    const isCustom = typeof command.customShift === 'string' && command.customShift.trim().length > 0;
    const validSetTarget = isCustom
      ? command.shift === 'unset'
      : ['morning', 'evening', 'off'].includes(command.shift);
    const targetShift = command.action === 'clear' ? 'unset' : isCustom ? 'unset' : command.shift;
    if (!selected.length || selected.length !== ids.length || selected.length > 100
      || selected.some(id => !isUuid(id) || !employeeById.has(id))
      || !rangeDates || rangeDates.length !== dates.length
      || dates.some((date, index) => date !== rangeDates[index])
      || dates.length > 31 || selected.length * dates.length > 500
      || dates.some(date => !isValidIsoDate(date)
        || Number(date.slice(0, 4)) !== Number(command.year)
        || Number(date.slice(5, 7)) !== Number(command.month))
      || !Number.isInteger(Number(command.year)) || Number(command.year) < 2020 || Number(command.year) > 2100
      || !Number.isInteger(Number(command.month)) || Number(command.month) < 1 || Number(command.month) > 12
      || !['set', 'clear'].includes(command.action)
      || (command.action === 'set' && !validSetTarget)
      || (command.action === 'clear' && command.customShift != null)
      || (isCustom && cleanText(command.customShift, 50) !== command.customShift.trim())) {
      const error = new Error('Bulk schedule change is invalid');
      error.status = 400;
      error.publicCode = 'invalid_schedule_change';
      throw error;
    }
    const customShift = command.action === 'set' && isCustom ? cleanText(command.customShift, 50) : null;
    const effectiveShift = command.action === 'clear' ? 'unset' : customShift ? 'unset' : targetShift;
    let schedule = await getScheduleMonth(session, Number(command.year), Number(command.month));
    let existingEntries = [];
    if (schedule) {
      existingEntries = await supabaseFetch(session.token,
        `/rest/v1/schedule_entries?schedule_month_id=eq.${schedule.id}&select=employee_id,work_date,shift`);
    }
    if (effectiveShift === 'off') {
      const settings = await supabaseFetch(session.token,
        `/rest/v1/workspace_settings?workspace_id=eq.${session.workspaceId}&select=monthly_days_off`);
      const leaveLimit = Number(settings?.[0]?.monthly_days_off ?? 7);
      const selectedIds = new Set(selected);
      const changedDates = new Set(dates);
      const offDatesByEmployee = new Map(selected.map(id => [id, new Set()]));
      (existingEntries || []).forEach(entry => {
        if (selectedIds.has(entry.employee_id) && entry.shift === 'off' && !changedDates.has(entry.work_date)) {
          offDatesByEmployee.get(entry.employee_id).add(entry.work_date);
        }
      });
      selected.forEach(id => {
        dates.forEach(date => offDatesByEmployee.get(id).add(date));
        if (offDatesByEmployee.get(id).size > leaveLimit) {
          const error = new Error(`Bulk schedule change exceeds monthly leave limit for ${employeeById.get(id).name}`);
          error.status = 409;
          error.publicCode = 'monthly_leave_limit';
          throw error;
        }
      });
    }
    if (!schedule) schedule = await getScheduleMonth(session, Number(command.year), Number(command.month), true);
    if (!schedule?.id) throw new Error('Schedule month could not be prepared');
    const rowsToUpsert = selected.flatMap(employeeId => dates.map(date => ({
      schedule_month_id: schedule.id,
      employee_id: employeeId,
      work_date: date,
      shift: effectiveShift,
      custom_shift: customShift,
      source: 'ai'
    })));
    await supabaseFetch(session.token, '/rest/v1/schedule_entries?on_conflict=schedule_month_id,employee_id,work_date', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rowsToUpsert
    });
    const names = selected.map(id => employeeById.get(id).name);
    message = `Foram atualizadas ${rowsToUpsert.length} células para ${names.join(', ')} entre ${dates[0].slice(8, 10)}/${dates[0].slice(5, 7)} e ${dates[dates.length - 1].slice(8, 10)}/${dates[dates.length - 1].slice(5, 7)}/${command.year}.`;
  } else if (command.operation === 'update_shift_assignment') {
    console.info(`[confirm-operation] employeeId=${isUuid(command.employeeId) ? command.employeeId : 'invalid'} date=${cleanText(command.date, 10) || 'missing'}`);
    if (!isUuid(command.employeeId)
      || !['morning', 'evening', 'off'].includes(command.shift)
      || !isValidIsoDate(command.date)
      || Number(command.year) !== Number(command.date.slice(0, 4))
      || Number(command.month) !== Number(command.date.slice(5, 7))
      || Number(command.month) < 1 || Number(command.month) > 12) {
      const error = new Error('Schedule change is invalid');
      error.status = 400;
      error.publicCode = 'invalid_schedule_change';
      console.warn('[confirm-operation] validation=failed reason=invalid_employee_id_shift_or_date');
      throw error;
    }
    const employee = employees.find(item => item.id === command.employeeId);
    if (!employee) {
      const error = new Error('Employee no longer exists or is inactive');
      error.status = 404;
      error.publicCode = 'employee_not_found';
      console.warn('[confirm-operation] validation=failed reason=employee_not_found');
      throw error;
    }
    console.info('[confirm-operation] validation=passed employee_exists=true date_valid=true');
    let schedule = await getScheduleMonth(session, Number(command.year), Number(command.month));
    let leaveRows = [];
    if (schedule) {
      leaveRows = await supabaseFetch(session.token, `/rest/v1/schedule_entries?schedule_month_id=eq.${schedule.id}&employee_id=eq.${command.employeeId}&select=work_date,shift`);
    }
    const existingForDate = (leaveRows || []).find(entry => entry.work_date === command.date);
    if (command.shift === 'off' && existingForDate?.shift === 'off') {
      const error = new Error('A leave is already registered for this employee on this date');
      error.status = 409;
      error.publicCode = 'duplicate_time_off';
      console.warn('[confirm-operation] validation=failed reason=duplicate_time_off');
      throw error;
    }
    if (command.shift === 'off') {
      const existingOffCount = explicitDaysOff(leaveRows, Number(command.year), Number(command.month)).size;
      const settings = await supabaseFetch(session.token, `/rest/v1/workspace_settings?workspace_id=eq.${session.workspaceId}&select=monthly_days_off`);
      const leaveLimit = Number(settings?.[0]?.monthly_days_off ?? 7);
      if (existingOffCount >= leaveLimit) {
        const error = new Error('Monthly leave limit reached');
        error.status = 409;
        error.publicCode = 'monthly_leave_limit';
        console.warn(`[confirm-operation] validation=failed reason=monthly_leave_limit used=${existingOffCount} limit=${leaveLimit}`);
        throw error;
      }
    }
    console.info('[confirm-operation] validation=passed leave_rule=ok');
    if (!schedule) schedule = await getScheduleMonth(session, Number(command.year), Number(command.month), true);
    if (!schedule?.id) throw new Error('Schedule month could not be prepared');
    await supabaseFetch(session.token, '/rest/v1/schedule_entries?on_conflict=schedule_month_id,employee_id,work_date', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        schedule_month_id: schedule.id,
        employee_id: command.employeeId,
        work_date: command.date,
        shift: command.shift,
        custom_shift: null,
        source: 'ai'
      }
    });
    console.info('[confirm-operation] insert result=success');
    if (command.shift === 'off') {
      const used = explicitDaysOff(leaveRows.filter(entry => entry.work_date !== command.date), Number(command.year), Number(command.month)).size + 1;
      message = `Folga registada para ${employee.name} em ${command.date}. Agora tem ${used}/7 folgas usadas e ${Math.max(0, 7 - used)} restantes.`;
    } else {
      message = `A escala de ${command.date} foi atualizada.`;
    }
  } else if (command.operation === 'generate_schedule') {
    if (!Number.isInteger(command.month) || command.month < 1 || command.month > 12
      || !Number.isInteger(command.year) || command.year < 2020 || command.year > 2100 || !employees.length || employees.length > 100) {
      const error = new Error('Schedule generation request is invalid');
      error.status = 400;
      throw error;
    }
    const schedule = await getScheduleMonth(session, command.year, command.month, true);
    if (!schedule?.id) throw new Error('Schedule month could not be prepared');
    const dayCount = new Date(Date.UTC(command.year, command.month, 0)).getUTCDate();
    const entries = [];
    employees.forEach((employee, personIndex) => {
      for (let day = 1; day <= dayCount; day += 1) {
        const date = `${command.year}-${String(command.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const shift = defaultScheduleShift(personIndex, day, dayCount);
        entries.push({
          schedule_month_id: schedule.id,
          employee_id: employee.id,
          work_date: date,
          shift,
          custom_shift: null,
          source: 'automatic'
        });
      }
    });
    await supabaseFetch(session.token, '/rest/v1/schedule_entries?on_conflict=schedule_month_id,employee_id,work_date', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: entries
    });
    await supabaseFetch(session.token, `/rest/v1/schedule_months?id=eq.${schedule.id}&workspace_id=eq.${session.workspaceId}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { generated: true, cleared: false, generated_at: new Date().toISOString() }
    });
    message = `O horário de ${String(command.month).padStart(2, '0')}/${command.year} foi gerado para a equipa.`;
  } else {
    const error = new Error('This operation is not supported');
    error.status = 400;
    throw error;
  }

  await markOperationComplete(session, operationId);
  return assistantResult(message);
}

async function confirmOperation(session, operationId) {
  if (confirmingOperations.has(operationId)) {
    const error = new Error('Operation is already being confirmed');
    error.status = 409;
    error.publicCode = 'operation_in_progress';
    throw error;
  }
  confirmingOperations.add(operationId);
  try {
    return await executeConfirmedOperation(session, operationId);
  } finally {
    confirmingOperations.delete(operationId);
  }
}

function safeErrorResponse(error, endpoint) {
  const status = Number.isInteger(error.status) ? error.status : 503;
  const diagnostic = {
    status,
    name: error.name || 'Error',
    code: error.publicCode || error.code || '',
    message: cleanText(redactSensitiveText(error.message), 300),
    supabase: error.supabase ? {
      status: error.supabase.status,
      code: error.supabase.code,
      message: redactSensitiveText(error.supabase.message),
      details: redactSensitiveText(error.supabase.details),
      hint: redactSensitiveText(error.supabase.hint)
    } : undefined
  };
  console.error(`[${endpoint}] request failed ${JSON.stringify(diagnostic)}`);
  if (endpoint === '/api/chat') {
    const providerMessages = {
      gemini_rate_limited: 'O Gemini atingiu temporariamente o limite de pedidos. Aguarda um pouco e tenta novamente.',
      gemini_auth: 'As chaves Gemini configuradas foram recusadas. Verifica GEMINI_API_KEY_1 a GEMINI_API_KEY_4 no servidor.',
      gemini_model: 'O modelo Gemini configurado não está disponível. Verifica GEMINI_MODEL no servidor.',
      gemini_timeout: 'O Gemini demorou demasiado a responder. Tenta novamente dentro de instantes.',
      gemini_overloaded: 'O Gemini está temporariamente com elevada procura. Tenta novamente dentro de instantes.',
      gemini_network: 'Não foi possível ligar ao Gemini. Verifica a ligação do servidor e tenta novamente.',
      gemini_error: 'O Gemini não conseguiu processar o pedido. Tenta novamente dentro de instantes.'
    };
    if (providerMessages[error.publicCode]) {
      return { status: 503, body: assistantResult(providerMessages[error.publicCode]) };
    }
    if (error.supabase?.status === 403) {
      return { status: 503, body: assistantResult('O Supabase recusou o acesso aos dados da equipa. Verifica as permissões e políticas RLS do gerente.') };
    }
    if (error.supabase || error.publicCode === 'database_unavailable') {
      return { status: 503, body: assistantResult('Não foi possível carregar os dados da equipa no Supabase. Tenta novamente dentro de instantes.') };
    }
    if (status === 401 || status === 403) return { status, body: assistantResult('A sessão expirou ou não tens acesso à equipa. Inicia sessão novamente e tenta outra vez.') };
    return { status: 503, body: assistantResult('Não consegui contactar o assistente neste momento. Tenta novamente dentro de instantes.') };
  }
  const messages = {
    operation_not_found: 'A proposta não foi encontrada ou já foi concluída. Envia novamente o pedido para criar uma proposta nova.',
    operation_expired: 'A proposta expirou. Envia novamente o pedido para preparar uma confirmação nova.',
    employee_not_found: 'O funcionário já não existe ou está inativo. Atualiza a equipa e cria uma proposta nova.',
    invalid_schedule_change: 'A data ou os detalhes da alteração são inválidos. Cria uma proposta nova com uma data válida.',
    duplicate_time_off: 'Já existe uma folga registada para este funcionário nesta data.',
    monthly_leave_limit: 'O limite mensal de folgas deste funcionário já foi atingido.',
    operation_in_progress: 'Esta proposta já está a ser processada. Aguarda um instante antes de tentar novamente.',
    operation_state_conflict: 'A alteração foi aplicada, mas não foi possível atualizar o estado da proposta. Contacta o administrador antes de repetir.',
    rls_denied: 'O Supabase recusou a gravação por permissões. Verifica as políticas RLS e o acesso do gerente.',
    permission_denied: 'A sessão não tem permissão para alterar este espaço de trabalho.',
    authentication_required: 'A sessão expirou. Inicia sessão novamente e cria uma nova proposta.',
    database_error: 'O Supabase não conseguiu guardar a alteração. Tenta novamente; a proposta continua disponível.',
    database_unavailable: 'A base de dados está temporariamente indisponível. Tenta novamente; a proposta continua disponível.',
    invalid_confirmation: 'O pedido de confirmação é inválido. Cria uma proposta nova e confirma-a novamente.'
  };
  const code = error.publicCode
    || (error.supabase?.status === 403 ? 'rls_denied'
      : error.supabase?.status === 401 ? 'authentication_required'
        : error.supabase?.status === 409 && error.supabase.code === '23505' ? 'duplicate_time_off'
          : error.supabase ? 'database_error' : '');
  if (code === 'operation_not_found') return { status: 404, body: { message: messages[code], code, retryable: false } };
  if (code === 'operation_expired') return { status: 410, body: { message: messages[code], code, retryable: false } };
  if (code === 'employee_not_found') return { status: 404, body: { message: messages[code], code, retryable: false } };
  if (code === 'duplicate_time_off' || code === 'monthly_leave_limit' || code === 'operation_in_progress' || code === 'operation_state_conflict') {
    return { status: 409, body: { message: messages[code], code, retryable: code === 'operation_in_progress' } };
  }
  if (code === 'invalid_schedule_change' || code === 'invalid_confirmation') {
    return { status: 400, body: { message: messages[code], code, retryable: false } };
  }
  if (code === 'configuration_missing') {
    return { status: 503, body: { message: 'A configuração segura do Supabase está incompleta. Usa uma chave publishable/anon, nunca uma secret/service_role.', code, retryable: false } };
  }
  if (code === 'authentication_required' || status === 401) {
    return { status: 401, body: { message: messages.authentication_required, code: 'authentication_required', retryable: false } };
  }
  if (code === 'rls_denied' || code === 'permission_denied' || status === 403) {
    const permissionCode = code || 'permission_denied';
    return { status: 403, body: { message: messages[permissionCode], code: permissionCode, retryable: code === 'rls_denied' } };
  }
  if (error.supabase || status >= 500 || error.name === 'TimeoutError') {
    const databaseCode = error.name === 'TimeoutError' || status >= 500 ? 'database_unavailable' : 'database_error';
    return { status: 503, body: { message: messages[databaseCode], code: databaseCode, retryable: true } };
  }
  if (status === 409) {
    return { status, body: { message: 'A operação conflita com os dados atuais. Atualiza a equipa e prepara uma proposta nova.', code: 'business_conflict', retryable: false } };
  }
  return {
    status: status === 400 ? 400 : 503,
    body: { message: status === 400 ? messages.invalid_confirmation : 'Não foi possível concluir a operação. Os dados não foram confirmados como atualizados.', code: status === 400 ? 'invalid_confirmation' : 'database_unavailable', retryable: status !== 400 }
  };
}

function serveFile(request, response) {
  const requested = request.url.split('?')[0];
  const publicFiles = new Map([
    ['/index.html', 'text/html'],
    ['/app.js', 'text/javascript'],
    ['/team-summary.js', 'text/javascript'],
    ['/styles.css', 'text/css'],
    ['/enhancements.css', 'text/css']
  ]);
  const contentType = publicFiles.get(requested === '/' ? '/index.html' : requested);
  if (!contentType) return send(response, 404, 'Not found', 'text/plain');
  const relativePath = requested === '/' ? 'index.html' : requested.slice(1);
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(response, 404, 'Not found', 'text/plain');
  send(response, 200, fs.readFileSync(filePath), contentType);
}

function sendSchedulePdf(response, body) {
  const document = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 24, autoFirstPage: false });
  const chunks = [];
  document.on('data', chunk => chunks.push(chunk));
  document.on('end', () => {
    const pdf = Buffer.concat(chunks);
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="mr-pizza-${String(body.monthName || 'horario').toLowerCase()}-${body.year || 2026}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'no-store'
    });
    response.end(pdf);
  });

  document.addPage();
  const dates = Array.isArray(body.dates) ? body.dates : [];
  const employees = Array.isArray(body.employees) ? body.employees : [];
  const width = document.page.width - document.page.margins.left - document.page.margins.right;
  const nameWidth = 130;
  const leaveWidth = 54;
  const dayWidth = Math.max(28, (width - nameWidth - leaveWidth) / Math.max(dates.length, 1));
  const rowHeight = 30;
  const colors = {
    coral: '#d95e48',
    header: '#302e30',
    line: '#ded9d5',
    text: '#25242a',
    morning: '#fff0e3',
    evening: '#f0edff',
    off: '#e9f5ed',
    unset: '#f3f1ef'
  };
  const valueLabel = value => value === 'morning' ? 'Dia' : value === 'evening' ? 'Noite' : value === 'off' ? 'Folga' : value === 'unset' ? 'Sem horário' : cleanText(value, 50);
  const drawCell = (x, y, cellWidth, fill, text, textColor = colors.text, options = {}) => {
    document.rect(x, y, cellWidth, rowHeight).fillAndStroke(fill, colors.line);
    document.fillColor(textColor).fontSize(options.fontSize || 7).font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(text, x + 2, y + (options.top || 10), cellWidth - 4, { align: options.align || 'center', lineBreak: false });
  };

  document.fillColor(colors.coral).font('Helvetica-Bold').fontSize(20).text(`Mr Pizza · Horário de ${body.monthName || ''} ${body.year || ''}`);
  document.fillColor('#777').font('Helvetica').fontSize(9).text('Escala da equipa · 7 folgas mensais por funcionário · PDF exportado pelo Mr Pizza', { continued: false });
  let y = 78;
  const x0 = document.page.margins.left;
  drawCell(x0, y, nameWidth, colors.header, 'FUNCIONÁRIO', '#fff', { bold: true });
  drawCell(x0 + nameWidth, y, leaveWidth, colors.header, 'FOLGAS', '#fff', { bold: true });
  dates.forEach((date, index) => {
    const weekend = date.weekend;
    drawCell(x0 + nameWidth + leaveWidth + index * dayWidth, y, dayWidth, weekend ? '#4a4547' : colors.header, `${date.dayName}\n${date.day}`, '#fff', { bold: true, top: 6 });
  });
  y += rowHeight;

  employees.forEach((employee, employeeIndex) => {
    drawCell(x0, y, nameWidth, employeeIndex % 2 ? '#fcfbfa' : '#f7f4f2', `${employee.name}\n${employee.role || ''}`, colors.text, { align: 'left', top: 6, bold: true });
    drawCell(x0 + nameWidth, y, leaveWidth, employeeIndex % 2 ? '#fcfbfa' : '#f7f4f2', `${employee.leaveUsed || 0}/7\n${employee.leaveRemaining || 0} rest.`, '#555', { top: 6, bold: true });
    dates.forEach((date, index) => {
      const value = employee.schedule?.[index] || 'unset';
      const fill = colors[value] || colors.unset;
      const textColor = value === 'morning' ? '#9b5f2c' : value === 'evening' ? '#63589b' : value === 'off' ? '#43815e' : '#888';
      drawCell(x0 + nameWidth + leaveWidth + index * dayWidth, y, dayWidth, fill, valueLabel(value), textColor, { bold: true, fontSize: dayWidth < 34 ? 6 : 7 });
    });
    y += rowHeight;
  });
  const legendY = document.page.height - 48;
  document.fillColor('#666').font('Helvetica').fontSize(8).text('Legenda:', x0, legendY);
  [['Turno do dia', colors.morning], ['Turno da noite', colors.evening], ['Folga', colors.off], ['Sem horário', colors.unset]].forEach((item, index) => {
    const x = x0 + 48 + index * 88;
    document.rect(x, legendY - 1, 9, 9).fill(item[1]);
    document.fillColor('#666').text(item[0], x + 13, legendY, 70);
  });
  document.end();
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, '');
  if (request.method === 'GET' && request.url === '/api/config') {
    if (!supabaseUrl || !isPublicSupabaseKey(supabaseAnonKey)) {
      return send(response, 503, { error: 'O servidor não tem a configuração pública do Supabase.' });
    }
    const assistantProvider = String(process.env.OPENROUTER_API_KEY || '').trim()
      ? 'OpenRouter'
      : geminiApiKeys.length ? 'Gemini' : '';
    return send(response, 200, { supabaseUrl, supabaseAnonKey, assistantProvider });
  }
  if (request.method === 'POST' && request.url === '/api/chat') {
    try {
      const body = JSON.parse(await readBody(request));
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return send(response, 400, assistantResult('Escreve uma mensagem para o assistente.'));
      }
      const session = await authenticateRequest(request);
      const result = await askGemini(session, body.message.trim(), body.history, {
        month: Number(body.month),
        year: Number(body.year)
      });
      return send(response, 200, result);
    } catch (error) {
      const failure = safeErrorResponse(error, '/api/chat');
      return send(response, failure.status, failure.body);
    }
  }
  if (request.method === 'POST' && request.url === '/api/confirm-operation') {
    try {
      const body = JSON.parse(await readBody(request));
      if (!body || Object.keys(body).some(key => key !== 'pendingOperationId')) {
        const error = new Error('Only a pending operation ID is accepted');
        error.status = 400;
        throw error;
      }
      const session = await authenticateRequest(request);
      const result = await confirmOperation(session, body.pendingOperationId);
      console.info('[confirm-operation] HTTP status=200 result=success');
      return send(response, 200, result);
    } catch (error) {
      const failure = safeErrorResponse(error, '/api/confirm-operation');
      console.warn(`[confirm-operation] HTTP status=${failure.status} code=${failure.body.code || 'request_failed'}`);
      return send(response, failure.status, failure.body);
    }
  }
  if (request.method === 'POST' && request.url === '/api/export-pdf') {
    try { return sendSchedulePdf(response, JSON.parse(await readBody(request))); } catch (error) { return send(response, 400, { error: error.message }); }
  }
  if (request.method === 'GET') return serveFile(request, response);
  return send(response, 405, { error: 'Method not allowed' });
});

try {
  new Intl.DateTimeFormat('en-CA', { timeZone: appTimeZone }).format(new Date());
} catch {
  console.error('Invalid APP_TIME_ZONE configuration.');
  process.exit(1);
}

if (require.main === module) {
  if (String(process.env.OPENROUTER_API_KEY || '').trim()) {
    try {
      console.info(`[openrouter] configured with ${getOpenRouterModels().length} model fallbacks`);
    } catch (error) {
      console.error(`Invalid OpenRouter model configuration: ${error.message}`);
      process.exit(1);
    }
  } else if (geminiApiKeys.length) {
    console.info(`[gemini] configured key slots=${geminiApiKeys.length}; requests use round-robin selection and quota failover`);
  } else {
    console.warn('No OpenRouter or Gemini API keys are configured; assistant requests will be unavailable.');
  }
  if (!supabaseUrl || !isPublicSupabaseKey(supabaseAnonKey)) console.warn('Supabase configuration requires a URL and a publishable/anon key; secret/service_role keys are not accepted.');
  server.listen(port, '127.0.0.1', () => console.log(`Mr Pizza aberto em http://localhost:${port}`));
}

module.exports = {
  server,
  assistantResult,
  isPublicSupabaseKey,
  sanitizeAssistantAction,
  formatDateInZone,
  defaultScheduleShift
};
