const employees = [
  { name: 'João Silva', role: 'Pizzaiolo', initials: 'JS', color: 'avatar-red', shift: '11:00 — 19:00', status: 'Em turno', nextOff: '21 set.' },
  { name: 'Marco Costa', role: 'Atendimento', initials: 'MC', color: 'avatar-blue', shift: '19:00 — 02:00', status: 'Em turno', nextOff: '22 set.' },
  { name: 'Teresa Alves', role: 'Cozinha', initials: 'TA', color: 'avatar-gold', shift: '11:00 — 19:00', status: 'Em turno', nextOff: '23 set.' },
  { name: 'Inês Almeida', role: 'Atendimento', initials: 'IA', color: 'avatar-green', shift: 'Folga hoje', status: 'De folga', nextOff: 'Hoje' },
  { name: 'Rita Sousa', role: 'Pizzaiola', initials: 'RS', color: 'avatar-purple', shift: '19:00 — 02:00', status: 'Em turno', nextOff: '24 set.' },
  { name: 'Filipe Cruz', role: 'Entregas', initials: 'FC', color: 'avatar-cyan', shift: '19:00 — 02:00', status: 'Em turno', nextOff: '25 set.' }
];
const allEmployees = [...employees, { name:'Ana Rocha', role:'Cozinha', initials:'AR', color:'avatar-red', shift:'11:00 — 19:00', status:'Em turno', nextOff:'28 set.' }, { name:'Pedro Nunes', role:'Entregas', initials:'PN', color:'avatar-blue', shift:'19:00 — 02:00', status:'Em turno', nextOff:'29 set.' }, { name:'Sofia Lima', role:'Atendimento', initials:'SL', color:'avatar-green', shift:'11:00 — 19:00', status:'Em turno', nextOff:'30 set.' }, { name:'Miguel Reis', role:'Pizzaiolo', initials:'MR', color:'avatar-gold', shift:'Folga hoje', status:'De folga', nextOff:'Hoje' }, { name:'Carla Dias', role:'Atendimento', initials:'CD', color:'avatar-purple', shift:'19:00 — 02:00', status:'Em turno', nextOff:'26 set.' }, { name:'Nuno Gomes', role:'Entregas', initials:'NG', color:'avatar-cyan', shift:'11:00 — 19:00', status:'Em turno', nextOff:'27 set.' }];
const initialDate = new Date();
let currentMonth = initialDate.getMonth();
let currentYear = initialDate.getFullYear();
let generated = false;
const manualOverrides = {};
const customShiftOverrides = {};
const persistedScheduleCells = new Set();
const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const dayNames = ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'];
const aiHistory = [];
const aiConversation = [];
let supabaseClient = null;
let workspaceId = null;
let currentUser = null;
let customShiftColumnAvailable = false;
let aiExecutionStopped = false;
let pendingAssistantOperation = null;

function startAiExecution(message = 'A IA está a preparar a tarefa...') {
  aiExecutionStopped = false;
  document.body.classList.add('ai-working');
  const indicator = document.getElementById('ai-execution-indicator');
  document.getElementById('ai-execution-text').textContent = message;
  indicator.hidden = false;
}

function stopAiExecution() {
  document.body.classList.remove('ai-working');
  document.getElementById('ai-execution-indicator').hidden = true;
}

function showView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active-view'));
  document.getElementById(`${name}-view`).classList.add('active-view');
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === name));
  document.getElementById('page-title').textContent = { overview:'Visão geral', schedule:'Horários', team:'Equipa' }[name];
  if (name === 'schedule') renderSchedule();
}
function navigateToTab(name) {
  const allowedTabs = new Set(['overview', 'schedule', 'team']);
  if (!allowedTabs.has(name)) return false;
  showView(name);
  return true;
}
function initials(name) { return name.split(' ').map(word => word[0]).slice(0,2).join(''); }
function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function renderWeek() {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const dates = Array.from({ length: 7 }, (_, index) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index));
  document.getElementById('week-strip').innerHTML = dates.map(date => `<div class="week-day ${date.getDay() === 0 || date.getDay() === 6 ? 'off-day' : ''}"><div>${dayNames[date.getDay()]}</div><div class="week-date ${formatLocalDate(date) === formatLocalDate(today) ? 'current' : ''}">${date.getDate()}</div></div>`).join('');
  const weekdayLabel = document.querySelector('#overview-view .eyebrow');
  if (weekdayLabel) weekdayLabel.textContent = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(today);
  const weekLabel = document.getElementById('overview-week-label');
  if (weekLabel) {
    const formatter = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' });
    weekLabel.textContent = `${formatter.format(dates[0])} — ${formatter.format(dates[6])}`;
  }
}
function teamRow(person) {
  let shift = person.shift;
  let status = person.status;
  let nextOff = person.nextOff;
  if (person.id) {
    const today = new Date();
    const todayValue = readCellValue(person, today);
    const customText = customShiftOverrides[scheduleKey(person.name, today)] || '';
    shift = customText || (todayValue === 'off' ? 'Folga hoje'
      : todayValue === 'unset' ? 'Sem horário'
        : shiftTimes(today, todayValue));
    status = customText ? 'Personalizado' : todayValue === 'off' ? 'De folga'
      : todayValue === 'unset' ? 'Sem horário'
        : 'Em turno';
    const todayKey = formatLocalDate(today);
    const nextOffDate = getMonthDates().find(date => formatLocalDate(date) >= todayKey
      && readCellValue(person, date) === 'off');
    nextOff = nextOffDate
      ? formatLocalDate(nextOffDate) === todayKey
        ? 'Hoje'
        : new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short' }).format(nextOffDate)
      : 'Sem folga agendada';
  }
  return `<div class="team-row"><div class="person-cell"><span class="avatar ${escapeHtml(person.color)}">${escapeHtml(person.initials)}</span><div><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.role)}</small></div></div><span>${escapeHtml(shift)}</span><span class="status-label ${status === 'De folga' ? 'rest' : ''}">${escapeHtml(status)}</span><span>${escapeHtml(nextOff)}</span></div>`;
}
function renderPreview() { document.getElementById('team-preview-rows').innerHTML = allEmployees.slice(0,4).map(teamRow).join(''); }
function renderOverview() {
  const total = allEmployees.length;
  const dates = getMonthDates();
  const today = new Date();
  const working = allEmployees.filter(person => readCellValue(person, today) !== 'off' && readCellValue(person, today) !== 'unset').length;
  const off = allEmployees.filter(person => readCellValue(person, today) === 'off').length;
  const morning = allEmployees.filter(person => readCellValue(person, today) === 'morning');
  const evening = allEmployees.filter(person => readCellValue(person, today) === 'evening');
  const scheduledCells = total * dates.length;
  const filledCells = scheduledCells ? dates.reduce((sum, date) =>
    sum + allEmployees.filter(person => persistedScheduleCells.has(scheduleKey(person.name, date))).length, 0) : 0;
  const completion = scheduledCells ? Math.round((filledCells / scheduledCells) * 100) : 0;
  const coverage = total ? Math.round((working / total) * 100) : 0;
  document.getElementById('overview-team-count').innerHTML = `${total} <small>pessoas</small>`;
  document.getElementById('overview-team-note').textContent = total ? 'Equipa carregada do Supabase' : 'Sem funcionários';
  document.getElementById('overview-working-count').innerHTML = `${working} <small>em serviço</small>`;
  document.getElementById('overview-off-count').textContent = `${off} folgas programadas`;
  document.getElementById('overview-completion').innerHTML = `${completion}<small>% completo</small>`;
  document.getElementById('overview-completion-bar').style.width = `${completion}%`;
  document.getElementById('overview-month-label').textContent = `${monthNames[currentMonth]} ${currentYear}`;
  document.getElementById('overview-coverage').innerHTML = `${coverage}<small>% assegurada</small>`;
  document.getElementById('overview-coverage-note').textContent = total ? 'Cobertura calculada pela escala' : 'Sem equipa para cobrir turnos';
  document.getElementById('overview-morning-count').textContent = `${morning.length} pessoas`;
  document.getElementById('overview-evening-count').textContent = `${evening.length} pessoas`;
  document.getElementById('overview-morning-members').innerHTML = morning.slice(0, 3).map(person => `<span class="avatar ${person.color}">${person.initials}</span>`).join('') + (morning.length > 3 ? `<span class="avatar avatar-more">+${morning.length - 3}</span>` : '');
  document.getElementById('overview-evening-members').innerHTML = evening.slice(0, 3).map(person => `<span class="avatar ${person.color}">${person.initials}</span>`).join('') + (evening.length > 3 ? `<span class="avatar avatar-more">+${evening.length - 3}</span>` : '');
}
function buildAiDataContext() {
  const today = new Date();
  return {
    employeeCount: allEmployees.length,
    employees: allEmployees.map(person => ({ name: person.name, role: person.role, status: person.status })),
    today: {
      date: formatLocalDate(today),
      working: allEmployees.filter(person => !['off', 'unset'].includes(readCellValue(person, today))).map(person => person.name),
      off: allEmployees.filter(person => readCellValue(person, today) === 'off').map(person => person.name)
    },
    month: monthNames[currentMonth],
    year: currentYear
  };
}
function getLeaveStats(person) {
  const used = getMonthDates().filter(date => readCellValue(person, date) === 'off').length;
  return { used, remaining: Math.max(0, 7 - used) };
}
function renderTeam() {
  const activeEmployees = window.MrPizzaTeamSummary.getActiveEmployees(allEmployees);
  const query = document.getElementById('team-search').value.trim().toLocaleLowerCase('pt-PT');
  const shiftFilter = document.getElementById('team-shift-filter').value;
  const roleSelect = document.getElementById('team-role-filter');
  const selectedRole = roleSelect.value;
  const roles = [...new Set(activeEmployees.map(person => person.role).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'pt-PT'));
  roleSelect.replaceChildren(new Option('Todas as funções', ''));
  roles.forEach(role => roleSelect.add(new Option(role, role)));
  if (roles.includes(selectedRole)) roleSelect.value = selectedRole;
  const roleFilter = roleSelect.value;
  const list = activeEmployees.filter(person => {
    const matchesQuery = `${person.name} ${person.role}`.toLocaleLowerCase('pt-PT').includes(query);
    const matchesRole = !roleFilter || person.role === roleFilter;
    const matchesShift = !shiftFilter || getMonthDates().some(date => readCellValue(person, date) === shiftFilter);
    return matchesQuery && matchesRole && matchesShift;
  });
  document.getElementById('team-summary').textContent = window.MrPizzaTeamSummary.getTeamSummary(allEmployees);
  document.getElementById('team-cards').innerHTML = list.length ? list.map(person => {
    const leave = getLeaveStats(person);
    return `<article class="member-card"><details class="member-actions"><summary aria-label="Opções de ${escapeHtml(person.name)}">•••</summary><div class="member-actions-menu"><button type="button" data-edit-employee="${escapeHtml(person.id)}">Editar dados</button><button type="button" data-delete-employee="${escapeHtml(person.id)}">Apagar permanentemente</button></div></details><div class="member-card-top"><span class="avatar ${escapeHtml(person.color)}">${escapeHtml(person.initials)}</span><div><h3>${escapeHtml(person.name)}</h3><p>${escapeHtml(person.role)}</p></div></div><div class="member-meta"><div><span>Folgas</span><strong>${leave.used}/7 usadas · ${leave.remaining} restantes</strong></div><div><span>Estado</span><strong class="small-state">● ${escapeHtml(person.status)}</strong></div></div></article>`;
  }).join('') : '<p class="team-empty-state">Não foram encontrados funcionários com estes filtros.</p>';
}
function getMonthDates() { const days = new Date(currentYear, currentMonth + 1, 0).getDate(); return Array.from({length: days}, (_, index) => new Date(currentYear, currentMonth, index + 1)); }
function scheduleKey(personName, date) { return `${personName}|${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function shiftTimes(date, shift) {
  const weekend = date.getDay() === 5 || date.getDay() === 6;
  if (weekend) return shift === 'evening' ? '19:00 — 02:00' : '11:00 — 19:00';
  return shift === 'evening' ? '18:00 — 00:00' : '11:00 — 18:00';
}
function defaultCell(person, personIndex, date, dates) { const selectedOffDates = new Set(Array.from({ length: Math.min(7, dates.length) }, (_, index) => dates[(Math.floor(index * dates.length / 7) + personIndex) % dates.length].getDate())); if (selectedOffDates.has(date.getDate())) return 'off'; return personIndex % 2 ? 'evening' : 'morning'; }
function cellMarkup(value, date, customText = '') {
  if (customText) return `<span class="cell-custom" title="${escapeHtml(customText)}">${escapeHtml(customText)}</span>`;
  if (value === 'unset') return '';
  if (value === 'off') return '<span class="cell-off">Folga</span>';
  return `<span class="cell-shift ${value === 'evening' ? 'evening' : ''}">${shiftTimes(date, value).replace(/:00/g, 'h')}</span>`;
}
function renderSchedule() {
  document.getElementById('month-label').textContent = `${monthNames[currentMonth]} ${currentYear}`;
  const dates = getMonthDates();
  const columns = `grid-template-columns:190px repeat(${dates.length}, 72px)`;
  const head = `<div class="month-grid-head" style="${columns}"><div>FUNCIONÁRIO</div>${dates.map(date => `<div>${dayNames[date.getDay()]} ${date.getDate()}</div>`).join('')}</div>`;
  const rows = allEmployees.map((person, personIndex) => `<div class="month-grid-row" style="${columns}"><div class="schedule-person"><span class="avatar ${escapeHtml(person.color)}">${escapeHtml(person.initials)}</span><div><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.role)}</small></div></div>${dates.map(date => {
    const key = scheduleKey(person.name, date);
    const customText = customShiftOverrides[key] || '';
    const value = customText ? 'unset' : scheduleCleared ? (manualOverrides[key] || 'unset') : (manualOverrides[key] || defaultCell(person, personIndex, date, dates));
    const label = customText || (value === 'unset' ? 'Sem horário' : value === 'off' ? 'Folga' : value === 'evening' ? 'Turno da noite' : 'Turno do dia');
    return `<button class="schedule-cell editable-cell${customText ? ' has-custom-shift' : ''}" data-person="${escapeHtml(person.name)}" data-employee-id="${escapeHtml(person.id || '')}" data-date="${date.getDate()}" data-work-date="${formatLocalDate(date)}" data-value="${value}" title="Clique para percorrer turnos · duplo clique ou toque prolongado para escrever" aria-label="${escapeHtml(person.name)}, dia ${date.getDate()}: ${escapeHtml(label)}">${cellMarkup(value, date, customText)}</button>`;
  }).join('')}</div>`).join('');
  document.getElementById('monthly-schedule').innerHTML = head + rows;
  renderCoverage();
  renderAiSuggestions();
  renderOverview();
}
function toast(message) { document.getElementById('toast-message').textContent = message; document.getElementById('toast').classList.add('show'); setTimeout(() => document.getElementById('toast').classList.remove('show'), 2600); }

function highlightUpdatedScheduleCells(affectedCells) {
  if (!Array.isArray(affectedCells)) return;
  const updatedKeys = new Set(affectedCells.map(cell => `${cell.employee_id}|${cell.date}`));
  document.querySelectorAll('#monthly-schedule .schedule-cell').forEach(cell => {
    if (!updatedKeys.has(`${cell.dataset.employeeId}|${cell.dataset.workDate}`)) return;
    cell.classList.remove('cell-updated');
    void cell.offsetWidth;
    cell.classList.add('cell-updated');
    setTimeout(() => cell.classList.remove('cell-updated'), 2000);
  });
}

async function generateSchedule() {
  if ((generated || scheduleCleared || Object.keys(manualOverrides).length)
    && !window.confirm(`Substituir a escala existente de ${monthNames[currentMonth]} ${currentYear}?`)) return;
  const previousOverrides = { ...manualOverrides };
  const previousCustomOverrides = { ...customShiftOverrides };
  const previousGenerated = generated;
  const previousCleared = scheduleCleared;
  generated = true;
  scheduleCleared = false;
  Object.keys(manualOverrides).forEach(key => delete manualOverrides[key]);
  Object.keys(customShiftOverrides).forEach(key => delete customShiftOverrides[key]);
  getMonthDates().forEach(date => {
    allEmployees.forEach((person, personIndex) => {
      const key = scheduleKey(person.name, date);
      if (!manualOverrides[key]) manualOverrides[key] = defaultCell(person, personIndex, date, getMonthDates());
    });
  });
  const validation = validatePlan([]);
  try {
    if (customText && !customShiftColumnAvailable) {
      throw new Error('Apply supabase-migration-schedule-custom-text.sql to enable custom schedule text');
    }
    await saveState();
    renderSchedule();
    if (validation.valid) toast(`Horário completo de ${monthNames[currentMonth].toLowerCase()} gerado.`);
    else addAiMessage(`<strong>Mr Pizza IA</strong><p>Horário gerado, mas precisa de revisão:<br>${validation.issues.map(escapeHtml).slice(0, 3).join('<br>')}</p>`);
  } catch (error) {
    Object.keys(manualOverrides).forEach(key => delete manualOverrides[key]);
    Object.keys(customShiftOverrides).forEach(key => delete customShiftOverrides[key]);
    Object.assign(manualOverrides, previousOverrides);
    Object.assign(customShiftOverrides, previousCustomOverrides);
    generated = previousGenerated;
    scheduleCleared = previousCleared;
    console.error('Schedule generation failed:', error.name);
    renderSchedule();
    toast('Não foi possível guardar o horário. As alterações não foram confirmadas.');
  }
}
let scheduleEditInProgress = false;

function updateScheduleCell(button, person, date, value, customText = '') {
  const label = customText || (value === 'unset' ? 'Sem horário' : value === 'off' ? 'Folga' : value === 'evening' ? 'Turno da noite' : 'Turno do dia');
  button.dataset.value = value;
  button.classList.toggle('has-custom-shift', Boolean(customText));
  button.title = 'Clique para percorrer turnos · duplo clique ou toque prolongado para escrever';
  button.setAttribute('aria-label', `${person}, dia ${date.getDate()}: ${label}`);
  button.innerHTML = cellMarkup(value, date, customText);
}

async function cycleCell(button) {
  if (scheduleEditInProgress) return;
  const values = ['morning', 'evening', 'off', 'unset'];
  const previousValue = button.dataset.value;
  const nextValue = values[(values.indexOf(previousValue) + 1) % values.length];
  const person = button.dataset.person;
  const date = new Date(currentYear, currentMonth, Number(button.dataset.date));
  const key = scheduleKey(person, date);
  const hadPreviousOverride = Object.prototype.hasOwnProperty.call(manualOverrides, key);
  const previousOverride = manualOverrides[key];
  const previousCustomOverride = customShiftOverrides[key];
  scheduleEditInProgress = true;
  document.querySelectorAll('#monthly-schedule .schedule-cell').forEach(cell => { cell.disabled = true; });
  manualOverrides[key] = nextValue;
  delete customShiftOverrides[key];
  updateScheduleCell(button, person, date, nextValue);
  try {
    await saveState();
    renderCoverage();
    renderAiSuggestions();
    renderOverview();
    const labels = { morning: 'turno do dia', evening: 'turno da noite', off: 'folga', unset: 'sem horário' };
    toast(`${person}: ${labels[nextValue]} atualizado.`);
  } catch (error) {
    if (hadPreviousOverride) manualOverrides[key] = previousOverride;
    else delete manualOverrides[key];
    if (previousCustomOverride) customShiftOverrides[key] = previousCustomOverride;
    updateScheduleCell(button, person, date, previousValue, previousCustomOverride || '');
    renderCoverage();
    renderAiSuggestions();
    renderOverview();
    console.error('Schedule edit failed:', error.name);
    toast('Não foi possível guardar a alteração. O horário não foi atualizado.');
  } finally {
    scheduleEditInProgress = false;
    document.querySelectorAll('#monthly-schedule .schedule-cell').forEach(cell => { cell.disabled = false; });
  }
}

function beginScheduleCellTextEdit(button) {
  if (scheduleEditInProgress || button.dataset.editing === 'true') return;
  const person = button.dataset.person;
  const date = new Date(currentYear, currentMonth, Number(button.dataset.date));
  const key = scheduleKey(person, date);
  const previousValue = button.dataset.value;
  const previousCustomText = customShiftOverrides[key] || '';
  const previousMarkup = button.innerHTML;
  const previousLabel = button.getAttribute('aria-label');
  button.dataset.editing = 'true';
  button.setAttribute('contenteditable', 'true');
  button.classList.add('editing');
  button.textContent = previousCustomText || (previousValue === 'unset' ? '' : previousValue === 'off' ? 'Folga' : shiftTimes(date, previousValue).replace(/:00/g, 'h'));
  button.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(button);
  selection.removeAllRanges();
  selection.addRange(range);

  let finished = false;
  const cleanUp = () => {
    button.removeEventListener('keydown', onKeydown);
    button.removeEventListener('blur', onBlur);
    button.removeAttribute('contenteditable');
    button.classList.remove('editing');
    delete button.dataset.editing;
  };
  const onKeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void finishEditing(button.textContent);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finished = true;
      cleanUp();
      button.innerHTML = previousMarkup;
      button.setAttribute('aria-label', previousLabel);
    }
  };
  const onBlur = () => { void finishEditing(button.textContent); };
  const finishEditing = async rawText => {
    if (finished) return;
    finished = true;
    cleanUp();
    const customText = String(rawText || '').trim().slice(0, 50);
    const hadPreviousOverride = Object.prototype.hasOwnProperty.call(manualOverrides, key);
    const previousOverride = manualOverrides[key];
    scheduleEditInProgress = true;
    document.querySelectorAll('#monthly-schedule .schedule-cell').forEach(cell => { cell.disabled = true; });
    manualOverrides[key] = 'unset';
    if (customText) customShiftOverrides[key] = customText;
    else delete customShiftOverrides[key];
    updateScheduleCell(button, person, date, 'unset', customText);
    try {
      await saveState();
      renderCoverage();
      renderAiSuggestions();
      renderOverview();
      toast(customText ? `${person}: horário personalizado atualizado.` : `${person}: horário removido.`);
    } catch (error) {
      if (hadPreviousOverride) manualOverrides[key] = previousOverride;
      else delete manualOverrides[key];
      if (previousCustomText) customShiftOverrides[key] = previousCustomText;
      else delete customShiftOverrides[key];
      updateScheduleCell(button, person, date, previousValue, previousCustomText);
      renderCoverage();
      renderAiSuggestions();
      renderOverview();
      console.error('Custom schedule edit failed:', error.name);
      toast(error.message.includes('supabase-migration-schedule-custom-text.sql')
        ? 'Para guardar texto livre, executa primeiro a migração SQL indicada no projeto.'
        : 'Não foi possível guardar o horário personalizado. A alteração foi cancelada.');
    } finally {
      scheduleEditInProgress = false;
      document.querySelectorAll('#monthly-schedule .schedule-cell').forEach(cell => { cell.disabled = false; });
    }
  };
  button.addEventListener('keydown', onKeydown);
  button.addEventListener('blur', onBlur);
}

let scheduleLongPressTimer = null;
let suppressNextScheduleClick = false;
const pendingScheduleClicks = new WeakMap();
const scheduleGrid = document.getElementById('monthly-schedule');
scheduleGrid.addEventListener('dblclick', event => {
  const button = event.target.closest('.editable-cell');
  if (!button) return;
  clearTimeout(pendingScheduleClicks.get(button));
  pendingScheduleClicks.delete(button);
  beginScheduleCellTextEdit(button);
});
scheduleGrid.addEventListener('pointerdown', event => {
  const button = event.target.closest('.editable-cell');
  if (!button || event.pointerType !== 'touch') return;
  scheduleLongPressTimer = setTimeout(() => {
    suppressNextScheduleClick = true;
    beginScheduleCellTextEdit(button);
  }, 550);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(type => scheduleGrid.addEventListener(type, () => {
  clearTimeout(scheduleLongPressTimer);
  scheduleLongPressTimer = null;
}));
scheduleGrid.addEventListener('click', event => {
  const button = event.target.closest('.editable-cell');
  if (!button) return;
  if (suppressNextScheduleClick) {
    suppressNextScheduleClick = false;
    event.preventDefault();
    return;
  }
  if (button.dataset.editing !== 'true') {
    clearTimeout(pendingScheduleClicks.get(button));
    const timer = setTimeout(() => {
      pendingScheduleClicks.delete(button);
      void cycleCell(button);
    }, 260);
    pendingScheduleClicks.set(button, timer);
  }
});

function readCellValue(person, date) {
  const key = scheduleKey(person.name, date);
  if (scheduleCleared && !manualOverrides[key]) return 'unset';
  return manualOverrides[key] || defaultCell(person, allEmployees.indexOf(person), date, getMonthDates());
}

function getCoverageForDate(date) {
  const totals = { morning: 0, evening: 0, off: 0 };
  allEmployees.forEach((person, personIndex) => {
    const value = readCellValue(person, date);
    if (value === 'morning') totals.morning += 1;
    if (value === 'evening') totals.evening += 1;
    if (value === 'off') totals.off += 1;
  });
  return totals;
}

function validatePlan(changes) {
  const issues = [];
  const monthDates = getMonthDates();
  const personDays = {};
  const sundayOffCounts = {};

  allEmployees.forEach(person => {
    personDays[person.name] = { morning: 0, evening: 0, off: 0 };
    sundayOffCounts[person.name] = 0;
  });

  const planMap = new Map();
  changes.forEach(change => {
    const key = `${change.name}|${change.date.getFullYear()}-${change.date.getMonth()}-${change.date.getDate()}`;
    planMap.set(key, change.value);
  });

  const getEffectiveValue = (person, date) => {
    const key = `${person.name}|${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (planMap.has(key)) return planMap.get(key);
    if (manualOverrides[scheduleKey(person.name, date)]) return manualOverrides[scheduleKey(person.name, date)];
    if (scheduleCleared) return 'unset';
    return defaultCell(person, allEmployees.indexOf(person), date, monthDates);
  };

  monthDates.forEach(date => {
    allEmployees.forEach(person => {
      const value = getEffectiveValue(person, date);
      if (value === 'off') {
        personDays[person.name].off += 1;
        if (date.getDay() === 0) sundayOffCounts[person.name] += 1;
      }
      if (value === 'morning') personDays[person.name].morning += 1;
      if (value === 'evening') personDays[person.name].evening += 1;
    });
  });

  Object.entries(personDays).forEach(([personName, stats]) => {
    const scheduledDays = stats.morning + stats.evening + stats.off;
    if (!scheduleCleared && stats.off !== 7) issues.push(`${personName} deve ter exatamente 7 folgas neste mês.`);
    if (scheduleCleared && scheduledDays > 0 && stats.off > 7) issues.push(`${personName} ultrapassa as 7 folgas permitidas.`);
  });

  monthDates.forEach(date => {
    const coverage = { morning: 0, evening: 0, off: 0 };
    allEmployees.forEach(person => {
      const value = getEffectiveValue(person, date);
      if (value === 'morning') coverage.morning += 1;
      if (value === 'evening') coverage.evening += 1;
      if (value === 'off') coverage.off += 1;
    });
    if (!scheduleCleared && coverage.morning < 3) issues.push(`Dia ${date.getDate()} tem menos de 3 pessoas no turno do dia.`);
    if (!scheduleCleared && coverage.evening < 3) issues.push(`Dia ${date.getDate()} tem menos de 3 pessoas no turno da noite.`);
  });

  return { valid: issues.length === 0, issues: [...new Set(issues)] };
}

function buildSmartSuggestions() {
  const suggestions = [];
  const monthDates = getMonthDates();
  const regulars = allEmployees.slice(0, 6);

  monthDates.forEach(date => {
    const coverage = getCoverageForDate(date);
    if (coverage.morning < 3) {
      const person = regulars.find(member => readCellValue(member, date) !== 'morning' && readCellValue(member, date) !== 'evening');
      if (person) suggestions.push(`${person.name} trabalha de manhã dia ${date.getDate()}`);
    }
    if (coverage.evening < 3) {
      const person = regulars.find(member => readCellValue(member, date) !== 'morning' && readCellValue(member, date) !== 'evening');
      if (person) suggestions.push(`${person.name} trabalha à tarde dia ${date.getDate()}`);
    }
    if (coverage.off > 2) {
      const person = regulars.find(member => readCellValue(member, date) === 'off' && date.getDay() !== 5 && date.getDay() !== 6);
      if (person) suggestions.push(`${person.name} pode fazer o turno do almoço dia ${date.getDate()}`);
    }
  });

  return [...new Set(suggestions)].slice(0, 5);
}

function renderCoverage() {
  const summary = document.getElementById('coverage-summary');
  const grid = document.getElementById('coverage-grid');
  const status = document.getElementById('coverage-status');
  if (!summary || !grid || !status) return;

  const dates = getMonthDates();
  const coverage = dates.map(date => ({ date, values: getCoverageForDate(date) }));
  const safeDays = coverage.filter(item => item.values.morning >= 3 && item.values.evening >= 3).length;
  const average = coverage.reduce((total, item) => total + item.values.morning + item.values.evening, 0) / coverage.length;
  const hasProblems = safeDays !== coverage.length;

  status.textContent = hasProblems ? `${coverage.length - safeDays} dia(s) a rever` : 'Cobertura assegurada';
  status.classList.toggle('rest', hasProblems);
  summary.innerHTML = `<div><strong>${safeDays}/${coverage.length}</strong><span>dias equilibrados</span></div><div><strong>${Math.round(average)}</strong><span>pessoas em média/dia</span></div><div><strong>${coverage.reduce((total, item) => total + item.values.off, 0)}</strong><span>folgas no mês</span></div>`;
  grid.innerHTML = coverage.map(item => {
    const { date, values } = item;
    const ok = values.morning >= 3 && values.evening >= 3;
    return `<button class="coverage-day ${ok ? 'coverage-ok' : 'coverage-warning'}" title="Dia ${date.getDate()}: ${values.morning} almoço, ${values.evening} jantar, ${values.off} folgas"><strong>${dayNames[date.getDay()]}</strong><span>${date.getDate()}</span><small>${values.morning}/${values.evening}</small></button>`;
  }).join('');
}

function renderAiSuggestions() {
  const container = document.querySelector('.ai-suggestions');
  if (!container) return;
  const suggestions = buildSmartSuggestions();
  const items = suggestions.length ? suggestions : ['João folga dia 23', 'Rita trabalha de noite dia 25', 'Teresa está de manhã dia 12'];
  container.innerHTML = items.map(prompt => `<button data-ai-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join('');
  container.querySelectorAll('[data-ai-prompt]').forEach(button => {
    button.addEventListener('click', () => {
      document.getElementById('ai-prompt').value = button.dataset.aiPrompt;
      document.getElementById('ai-form').requestSubmit();
    });
  });
}

let scheduleCleared = false;

async function loadSavedState() {
  let { data: membership, error: membershipError } = await supabaseClient
    .from('workspace_members').select('workspace_id').eq('user_id', currentUser.id).limit(1).maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) {
    const { data: ownedWorkspace, error: workspaceError } = await supabaseClient
      .from('workspaces').select('id').eq('owner_id', currentUser.id).limit(1).maybeSingle();
    if (workspaceError) throw workspaceError;

    if (ownedWorkspace) {
      const { error: memberError } = await supabaseClient.from('workspace_members').upsert({
        workspace_id: ownedWorkspace.id,
        user_id: currentUser.id,
        is_admin: true
      }, { onConflict: 'workspace_id,user_id' });
      if (memberError) throw memberError;
      membership = { workspace_id: ownedWorkspace.id };
    } else {
      const { data: createdWorkspace, error: createError } = await supabaseClient
        .rpc('create_workspace', { workspace_name: 'Mr Pizza' });
      if (createError) throw createError;
      membership = { workspace_id: createdWorkspace };
    }
  }
  workspaceId = membership.workspace_id;
  const monthStart = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;
  const { data: dbEmployees, error: employeeError } = await supabaseClient
    .from('employees').select('*').eq('workspace_id', workspaceId).eq('status', 'active').order('sort_order');
  if (employeeError) throw employeeError;
  allEmployees.splice(0, allEmployees.length, ...(dbEmployees || []).map(person => ({
    ...person, status: person.status === 'active' ? 'Ativo' : person.status
  })));
  const { data: month, error: monthError } = await supabaseClient
    .from('schedule_months').select('id,generated,cleared').eq('workspace_id', workspaceId).eq('month_start', monthStart).maybeSingle();
  if (monthError) throw monthError;
  generated = month?.generated || false;
  scheduleCleared = month?.cleared || false;
  Object.keys(manualOverrides).forEach(key => delete manualOverrides[key]);
  Object.keys(customShiftOverrides).forEach(key => delete customShiftOverrides[key]);
  persistedScheduleCells.clear();
  let entries = [];
  const entryQuery = month
    ? supabaseClient.from('schedule_entries').select('employee_id,work_date,shift,custom_shift').eq('schedule_month_id', month.id)
    : supabaseClient.from('schedule_entries').select('custom_shift').limit(0);
  let { data: loadedEntries, error: entryError } = await entryQuery;
  if (entryError && (entryError.code === '42703' || entryError.code === 'PGRST204'
    || /custom_shift.*(does not exist|schema cache)/i.test(entryError.message || ''))) {
    customShiftColumnAvailable = false;
    if (month) {
      const fallback = await supabaseClient.from('schedule_entries')
        .select('employee_id,work_date,shift').eq('schedule_month_id', month.id);
      if (fallback.error) throw fallback.error;
      loadedEntries = fallback.data;
    }
  } else if (entryError) {
    throw entryError;
  } else {
    customShiftColumnAvailable = true;
  }
  entries = loadedEntries || [];
  if (month) {
    (entries || []).forEach(entry => {
      const person = allEmployees.find(item => item.id === entry.employee_id);
      if (person) {
        const date = new Date(`${entry.work_date}T00:00:00`);
        const key = scheduleKey(person.name, date);
        manualOverrides[key] = entry.shift;
        if (entry.custom_shift) customShiftOverrides[key] = entry.custom_shift;
        if (entry.shift !== 'unset' || entry.custom_shift) persistedScheduleCells.add(key);
      }
    });
  }
}

async function saveState() {
  if (!supabaseClient || !workspaceId || !currentUser) throw new Error('Cannot save schedule without an authenticated workspace');
  const monthStart = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;
  const { data: month, error: monthError } = await supabaseClient.from('schedule_months')
    .upsert({ workspace_id: workspaceId, month_start: monthStart, generated, cleared: scheduleCleared }, { onConflict: 'workspace_id,month_start' })
    .select('id').single();
  if (monthError) throw monthError;
  const entries = getMonthDates().flatMap(date => allEmployees.map(person => {
    const value = readCellValue(person, date);
    const key = scheduleKey(person.name, date);
    const entry = {
      schedule_month_id: month.id,
      employee_id: person.id,
      work_date: formatLocalDate(date),
      shift: value,
      source: Object.prototype.hasOwnProperty.call(manualOverrides, key) ? 'manual' : 'automatic'
    };
    if (customShiftColumnAvailable) entry.custom_shift = customShiftOverrides[key] || null;
    return entry;
  })).filter(entry => entry.employee_id);
  if (entries.length) {
    const { error } = await supabaseClient.from('schedule_entries').upsert(entries, { onConflict: 'schedule_month_id,employee_id,work_date' });
    if (error) throw error;
  }
  persistedScheduleCells.clear();
  entries.filter(entry => entry.shift !== 'unset' || entry.custom_shift).forEach(entry => {
    const person = allEmployees.find(employee => employee.id === entry.employee_id);
    if (person) persistedScheduleCells.add(scheduleKey(person.name, new Date(`${entry.work_date}T00:00:00`)));
  });
}

async function persistEmployee(person) {
  const { data, error } = await supabaseClient.from('employees').upsert({
    id: person.id,
    workspace_id: workspaceId,
    name: person.name,
    role: person.role || 'Novo membro',
    initials: person.initials || initials(person.name),
    color: person.color || 'avatar-red',
    status: 'active',
    sort_order: allEmployees.indexOf(person)
  }).select('*').single();
  if (error) throw error;
  Object.assign(person, data);
}

async function initializeCloudApp() {
  if (!supabaseClient) throw new Error('Supabase client is not configured');
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    document.getElementById('auth-overlay').hidden = false;
    return;
  }
  currentUser = session.user;
  const displayName = session.user.email?.split('@')[0] || 'Gerente';
  document.getElementById('manager-email').textContent = session.user.email || '';
  document.getElementById('sidebar-user-name').textContent = displayName;
  document.getElementById('sidebar-user-avatar').textContent = initials(displayName);
  try {
    await loadSavedState();
    document.querySelector('.app-shell').inert = false;
    document.getElementById('open-ai-assistant').inert = false;
    document.getElementById('auth-overlay').hidden = true;
    renderWeek(); renderPreview(); renderTeam(); renderSchedule(); renderOverview();
  } catch (error) {
    document.getElementById('auth-overlay').hidden = false;
    console.error('Cloud application initialization failed:', error.name);
    document.getElementById('auth-error').textContent = 'Não foi possível carregar os dados do espaço de trabalho. Verifica o acesso e tenta novamente.';
  }
}

async function initializeAppConfiguration() {
  const authOverlay = document.getElementById('auth-overlay');
  const authError = document.getElementById('auth-error');
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Supabase public configuration unavailable');
    const config = await response.json();
    if (typeof config.supabaseUrl !== 'string' || typeof config.supabaseAnonKey !== 'string'
      || !config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error('Supabase public configuration is incomplete');
    }
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const assistantStatus = document.querySelector('.ai-online');
    if (assistantStatus) {
      const indicator = document.createElement('i');
      const provider = typeof config.assistantProvider === 'string' ? config.assistantProvider : '';
      assistantStatus.replaceChildren(indicator, document.createTextNode(provider ? ` Configurado · ${provider}` : ' Indisponível'));
    }
    await initializeCloudApp();
  } catch (error) {
    console.error('App configuration failed:', error.name);
    authOverlay.hidden = false;
    authError.textContent = 'Não foi possível ligar ao projeto Supabase. Confirma a URL e a chave pública configuradas no servidor e verifica se o serviço está acessível.';
  }
}

function normalizeText(value = '') {
  let normalized = String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const informalTerms = [
    [/\btds?\b/g, 'todos'],
    [/\btodas?\b/g, 'todas'],
    [/\bfuncs?\b/g, 'funcionarios'],
    [/\bfuncionarios?\b/g, 'funcionarios'],
    [/\bequip[ae]\b/g, 'equipa'],
    [/\beq\b/g, 'equipa'],
    [/\bmembros?\b/g, 'membros'],
    [/\bcolaboradores?\b/g, 'funcionarios'],
    [/\bpessoas?\b/g, 'funcionarios'],
    [/\bapague?s?\b/g, 'apagar'],
    [/\bdelete?s?\b/g, 'apagar'],
    [/\bexclua?s?\b/g, 'apagar'],
    [/\bremova?s?\b/g, 'remover']
  ];
  informalTerms.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, replacement);
  });
  return normalized.replace(/\s+/g, ' ').trim();
}

function isExplicitConfirmation(text) {
  return /^(sim|sim confirmo|confirmo|confirmar|podes avancar|pode avancar|avanca|avancar|confirmo a operacao|confirmo a operação)[.! ]*$/i.test(normalizeText(text));
}

function isExplicitCancellation(text) {
  return /^(nao|não|cancela|cancelar|nao confirmo|não confirmo|deixa estar|esquece)[.! ]*$/i.test(normalizeText(text));
}

async function getAssistantRequestHeaders() {
  if (!supabaseClient || !workspaceId) throw new Error('Sessão não autenticada');
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error || !session?.access_token) throw new Error('Sessão expirada');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
    'X-Workspace-Id': workspaceId
  };
}

function sanitizePendingOperation(operation) {
  const allowedTypes = new Set(['create_employee', 'update_employee', 'delete_employee', 'update_shift_assignment', 'bulk_update_schedule', 'generate_schedule']);
  if (!operation || typeof operation !== 'object' || !/^[0-9a-f-]{36}$/i.test(operation.id || '')
    || !allowedTypes.has(operation.type) || typeof operation.summary !== 'string'
    || typeof operation.expiresAt !== 'string') return null;
  return { id: operation.id, type: operation.type, summary: operation.summary, expiresAt: operation.expiresAt };
}

async function requestAssistantMessage(prompt) {
  try {
    const headers = await getAssistantRequestHeaders();
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: prompt,
        history: aiConversation.slice(0, -1).slice(-12),
        month: currentMonth + 1,
        year: currentYear
      })
    });
    const result = await response.json();
    if (!response.ok) {
      return {
        message: typeof result.message === 'string'
          ? result.message
          : 'Não consegui contactar o assistente neste momento. Tenta novamente dentro de instantes.',
        action: null,
        pendingOperation: null
      };
    }
    const action = result.action ? sanitizeFrontendAction(result.action) : null;
    const pendingOperation = sanitizePendingOperation(result.pendingOperation);
    return {
      message: typeof result.message === 'string' && result.message.trim()
        ? result.message
        : 'Não consegui formular uma resposta agora. Podes tentar novamente?',
      action,
      pendingOperation
    };
  } catch (error) {
    console.error('Assistant request failed:', error.name);
    return {
      message: 'Não consegui contactar o assistente neste momento. Tenta novamente dentro de instantes.',
      action: null,
      pendingOperation: null
    };
  }
}

function sanitizeFrontendAction(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'navigate' && ['overview', 'schedule', 'team'].includes(action.tab)) {
    return { type: 'navigate', tab: action.tab };
  }
  if (action.type === 'search_employee' && typeof action.query === 'string') {
    const query = action.query.trim().slice(0, 80);
    return query ? { type: 'search_employee', query } : null;
  }
  if (action.type === 'open_create_employee') return { type: 'open_create_employee' };
  if (action.type === 'open_edit_employee' && /^[0-9a-f-]{36}$/i.test(action.employeeId || '')) {
    return { type: 'open_edit_employee', employeeId: action.employeeId };
  }
  if (action.type === 'set_team_filters'
    && ['all', 'morning', 'evening', 'off'].includes(action.shift)
    && typeof action.query === 'string' && typeof action.role === 'string') {
    return {
      type: 'set_team_filters',
      query: action.query.slice(0, 80),
      shift: action.shift,
      role: action.role.slice(0, 80)
    };
  }
  if (action.type === 'show_schedule_month'
    && Number.isInteger(action.month) && action.month >= 1 && action.month <= 12
    && Number.isInteger(action.year) && action.year >= 2020 && action.year <= 2100) {
    return { type: 'show_schedule_month', month: action.month, year: action.year };
  }
  if (action.type === 'export_schedule' && ['excel', 'pdf'].includes(action.format)) {
    return { type: 'export_schedule', format: action.format };
  }
  return null;
}

async function executeAssistantAction(action) {
  if (!action) return;
  if (action.type === 'navigate') {
    navigateToTab(action.tab);
    return;
  }
  if (action.type === 'search_employee') {
    navigateToTab('team');
    const search = document.getElementById('team-search');
    search.value = action.query;
    renderTeam();
    search.focus();
    return;
  }
  if (action.type === 'open_create_employee') {
    openCreateEmployeeForm();
    return;
  }
  if (action.type === 'open_edit_employee') {
    navigateToTab('team');
    openEditEmployeeForm(action.employeeId);
    return;
  }
  if (action.type === 'set_team_filters') {
    navigateToTab('team');
    document.getElementById('team-search').value = action.query;
    document.getElementById('team-shift-filter').value = action.shift === 'all' ? '' : action.shift;
    renderTeam();
    const roleFilter = document.getElementById('team-role-filter');
    if (!action.role || [...roleFilter.options].some(option => option.value === action.role)) {
      roleFilter.value = action.role;
      renderTeam();
    }
    return;
  }
  if (action.type === 'show_schedule_month') {
    navigateToTab('schedule');
    const offset = (action.year - currentYear) * 12 + action.month - 1 - currentMonth;
    if (offset) await changeScheduleMonth(offset);
    return;
  }
  if (action.type === 'export_schedule') {
    try {
      if (action.format === 'excel') exportScheduleExcel();
      else await exportSchedulePdf();
    } catch (error) {
      console.error('Assistant schedule export failed:', error.name);
      toast(`Não foi possível exportar a escala: ${error.message}`);
    }
    return;
  }
  console.warn('Assistant UI action blocked.');
}

async function confirmAssistantOperation(operationId) {
  const operation = pendingAssistantOperation;
  if (!operation || operation.id !== operationId) return;
  try {
    const headers = await getAssistantRequestHeaders();
    const response = await fetch('/api/confirm-operation', {
      method: 'POST',
      headers,
      body: JSON.stringify({ pendingOperationId: operation.id })
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.message || 'Não foi possível concluir a operação.');
      error.code = result.code;
      error.retryable = result.retryable;
      throw error;
    }
    pendingAssistantOperation = null;
    document.querySelectorAll('[data-assistant-confirm], [data-assistant-cancel]').forEach(button => button.closest('.ai-confirm-actions')?.remove());
    aiConversation.push({ role: 'model', text: result.message });
    try {
      await loadSavedState();
      renderWeek();
      renderPreview();
      renderTeam();
      renderSchedule();
      renderOverview();
      highlightUpdatedScheduleCells(result.affectedCells);
      addAiMessage(`<strong>Mr Pizza IA</strong><p>${escapeHtml(result.message)}</p>`);
    } catch (refreshError) {
      console.error('Assistant operation saved but UI refresh failed:', refreshError.name);
      addAiMessage(`<strong>Mr Pizza IA</strong><p>${escapeHtml(result.message)}</p><p>A alteração foi guardada, mas não consegui atualizar os dados no ecrã. Atualiza a página para os carregar.</p>`);
    }
  } catch (error) {
    console.error('Assistant confirmation failed:', error.name);
    if (error.retryable === false) {
      pendingAssistantOperation = null;
      document.querySelectorAll('[data-assistant-confirm], [data-assistant-cancel]').forEach(button => button.closest('.ai-confirm-actions')?.remove());
    }
    addAiMessage(`<strong>Mr Pizza IA</strong><p>${escapeHtml(error.message || 'Não foi possível concluir a operação. Os dados não foram confirmados como atualizados.')}</p>`);
  }
}

function openCreateEmployeeForm() {
  navigateToTab('team');
  const dialog = document.getElementById('employee-dialog');
  if (!dialog.open) dialog.showModal();
  document.getElementById('employee-name').focus();
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character])); }
function addAiMessage(text, type) {
  const chat = document.getElementById('ai-chat');
  aiHistory.push({ type: type || 'system', text, at: Date.now() });
  if (aiHistory.length > 12) aiHistory.shift();
  chat.insertAdjacentHTML('beforeend', `<div class="ai-message ${type || ''}">${text}</div>`);
  chat.scrollTop = chat.scrollHeight;
}

document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => navigateToTab(item.dataset.view)));
document.querySelectorAll('[data-view-target]').forEach(item => item.addEventListener('click', () => navigateToTab(item.dataset.viewTarget)));
const globalAiPanel = document.querySelector('.ai-panel');
if (globalAiPanel) document.body.appendChild(globalAiPanel);
document.getElementById('open-ai-assistant').addEventListener('click', () => {
  const panel = globalAiPanel;
  if (!panel) return;
  const button = document.getElementById('open-ai-assistant');
  const isOpen = panel.classList.toggle('ai-panel-open');
  button.classList.toggle('assistant-open', isOpen);
  button.setAttribute('aria-expanded', String(isOpen));
  const input = document.getElementById('ai-prompt');
  if (panel.classList.contains('ai-panel-open')) {
    input.focus();
  }
});
document.getElementById('generate-schedule').addEventListener('click', generateSchedule);
document.getElementById('generate-overview').addEventListener('click', () => { navigateToTab('schedule'); generateSchedule(); });
async function changeScheduleMonth(offset) {
  const previousMonth = currentMonth;
  const previousYear = currentYear;
  try {
    await saveState();
    const date = new Date(currentYear, currentMonth + offset, 1);
    currentMonth = date.getMonth();
    currentYear = date.getFullYear();
    await loadSavedState();
    renderSchedule();
  } catch (error) {
    currentMonth = previousMonth;
    currentYear = previousYear;
    try {
      await loadSavedState();
      renderSchedule();
    } catch (reloadError) {
      console.error('Schedule state recovery failed:', reloadError.name);
    }
    console.error('Schedule month navigation failed:', error.name);
    toast('Não foi possível carregar esse mês. Verifica a ligação e tenta novamente.');
  }
}
document.getElementById('prev-month').addEventListener('click', () => changeScheduleMonth(-1));
document.getElementById('next-month').addEventListener('click', () => changeScheduleMonth(1));
document.getElementById('team-search').addEventListener('input', renderTeam);
document.getElementById('team-shift-filter').addEventListener('change', renderTeam);
document.getElementById('team-role-filter').addEventListener('change', renderTeam);
document.getElementById('add-member').addEventListener('click', openCreateEmployeeForm);
function openEditEmployeeForm(employeeId) {
  const person = allEmployees.find(employee => employee.id === employeeId);
  if (!person) {
    toast('Não encontrei esse funcionário. Atualiza a equipa e tenta novamente.');
    return;
  }
  document.getElementById('edit-employee-id').value = person.id;
  document.getElementById('edit-employee-name').value = person.name;
  document.getElementById('edit-employee-role').value = person.role;
  document.getElementById('employee-edit-dialog').showModal();
  document.getElementById('edit-employee-name').focus();
}

async function deleteEmployee(employeeId) {
  const person = allEmployees.find(employee => employee.id === employeeId);
  if (!person) {
    toast('Não encontrei esse funcionário. Atualiza a equipa e tenta novamente.');
    return;
  }
  if (!window.confirm(`Apagar permanentemente ${person.name}? Os horários e o histórico associados também serão apagados. Esta ação não pode ser anulada.`)) return;
  try {
    const { data, error } = await supabaseClient.from('employees')
      .delete()
      .eq('id', person.id)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Employee was not updated');
    await loadSavedState();
    renderPreview();
    renderTeam();
    renderSchedule();
    toast(`${person.name} e os horários associados foram apagados permanentemente.`);
  } catch (error) {
    const code = error?.code || error?.name || 'erro desconhecido';
    const message = error?.message || 'O Supabase não informou o motivo.';
    console.error('Employee deletion failed:', {
      code,
      message,
      details: error?.details,
      hint: error?.hint
    });
    toast(`Não foi possível apagar o funcionário (${code}): ${message}`);
  }
}

document.getElementById('team-cards').addEventListener('click', event => {
  const editButton = event.target.closest('[data-edit-employee]');
  const deleteButton = event.target.closest('[data-delete-employee]');
  if (editButton) {
    editButton.closest('details').open = false;
    openEditEmployeeForm(editButton.dataset.editEmployee);
  } else if (deleteButton) {
    deleteButton.closest('details').open = false;
    deleteEmployee(deleteButton.dataset.deleteEmployee);
  }
});

document.getElementById('employee-edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const employeeId = document.getElementById('edit-employee-id').value;
  const name = document.getElementById('edit-employee-name').value.trim();
  const role = document.getElementById('edit-employee-role').value.trim() || 'Novo membro';
  const person = allEmployees.find(employee => employee.id === employeeId);
  if (!person || !name) return;
  try {
    const { data, error } = await supabaseClient.from('employees')
      .update({ name, role, initials: initials(name) })
      .eq('id', employeeId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Employee was not updated');
    await loadSavedState();
    renderPreview();
    renderTeam();
    renderSchedule();
    document.getElementById('employee-edit-dialog').close();
    toast(`${name} foi atualizado.`);
  } catch (error) {
    console.error('Employee update failed:', error.name);
    toast('Não foi possível guardar as alterações. Verifica se já existe alguém com esse nome.');
  }
});

document.getElementById('employee-edit-cancel').addEventListener('click', () => document.getElementById('employee-edit-dialog').close());
document.getElementById('employee-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = document.getElementById('employee-name').value.trim();
  const role = document.getElementById('employee-role').value.trim() || 'Novo membro';
  if (!name) return;
  const person = { name, role, initials: initials(name), color: 'avatar-red', shift: 'A definir', status: 'Por escalar', nextOff: 'A definir' };
  let employeeSaved = false;
  try {
    await persistEmployee(person);
    employeeSaved = true;
    await loadSavedState();
    await saveState();
    renderPreview();
    renderTeam();
    renderSchedule();
    document.getElementById('employee-dialog').close();
    event.target.reset();
    toast(`${name} foi adicionado à equipa.`);
  } catch (error) {
    console.error('Manual employee creation failed:', error.name);
    if (employeeSaved) {
      try {
        await loadSavedState();
        renderPreview();
        renderTeam();
        renderSchedule();
      } catch (reloadError) {
        console.error('Employee creation recovery failed:', reloadError.name);
      }
    }
    toast(employeeSaved
      ? `${name} foi adicionado, mas não consegui guardar a escala. Atualiza a página para continuar.`
      : 'Não foi possível adicionar o funcionário. Confirma se já existe alguém com esse nome e tenta novamente.');
  }
});
function exportScheduleExcel() {
  const dates = getMonthDates();
  const title = `Mr Pizza · Horário de ${monthNames[currentMonth]} ${currentYear}`;
  const header = dates.map(date => `<th class="${date.getDay() === 5 || date.getDay() === 6 ? 'weekend' : ''}"><span>${String(date.getDate()).padStart(2, '0')}</span><br>${dayNames[date.getDay()]}</th>`).join('');
  const rows = allEmployees.map(person => {
    const leave = getLeaveStats(person);
    const cells = dates.map(date => {
      const value = readCellValue(person, date);
      const key = scheduleKey(person.name, date);
      const customText = customShiftOverrides[key] || '';
      const label = customText || (value === 'off' ? 'Folga' : value === 'unset' ? 'Sem horário' : shiftTimes(date, value));
      const kind = customText ? 'custom' : value === 'off' ? 'off' : value === 'unset' ? 'unset' : value;
      return `<td class="${kind}">${escapeHtml(label)}</td>`;
    }).join('');
    return `<tr><td class="person"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.role)}</small></td><td class="leave">${leave.used}/7<br><small>${leave.remaining} restantes</small></td>${cells}</tr>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: landscape; margin: 12mm; }
  body { font-family: Arial, sans-serif; color: #25242a; margin: 24px; }
  h1 { color: #d95e48; margin: 0 0 4px; font-size: 22px; }
  .subtitle { color: #777; margin-bottom: 8px; font-size: 12px; }
  .meta { color: #aaa; margin-bottom: 14px; font-size: 9px; }
  .legend { margin: 0 0 14px; font-size: 11px; color: #666; }
  .legend span { display: inline-block; padding: 5px 9px; margin-right: 6px; border-radius: 4px; }
  .morning { background: #fff0e3 !important; color: #9b5f2c; }
  .evening { background: #f0edff !important; color: #63589b; }
  .off { background: #e9f5ed !important; color: #43815e; }
  .unset { background: #f3f1ef !important; color: #888; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 9px; }
  thead { display: table-header-group; }
  th { background: #302e30; color: white; padding: 8px 4px; border: 1px solid #494548; }
  th span { font-size: 12px; }
  th.weekend { background: #4a4547; }
  td { border: 1px solid #e3dfdc; text-align: center; padding: 7px 3px; height: 30px; }
  tr:nth-child(even) td { background-color: #fcfbfa; }
  td.person { width: 135px; text-align: left; background: #f7f4f2 !important; padding-left: 8px; }
  td.person strong, td.person small { display: block; }
  td.person small, td.leave small { color: #888; font-size: 8px; margin-top: 3px; }
  td.leave { width: 55px; font-weight: bold; color: #555; }
  td.morning, td.evening, td.off, td.unset { font-weight: bold; }
  td.custom { color: #576b8c; font-style: italic; }
  </style></head><body><h1>${title}</h1><div class="subtitle">Escala da equipa · 7 folgas mensais por funcionário · Exportado pelo Mr Pizza</div><div class="meta">Gerado em ${new Date().toLocaleDateString('pt-PT')} · ${allEmployees.length} funcionários · ${dates.length} dias</div><div class="legend"><span class="morning">Turno do dia</span><span class="evening">Turno da noite</span><span class="off">Folga</span><span class="unset">Sem horário</span></div><table><thead><tr><th>FUNCIONÁRIO</th><th>FOLGAS</th>${header}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
  const blob = new Blob([`\ufeff${html}`], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `mr-pizza-${monthNames[currentMonth].toLowerCase()}-${currentYear}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Tabela Excel profissional exportada.');
}
document.getElementById('export-schedule').addEventListener('click', exportScheduleExcel);
async function exportSchedulePdf() {
  const dates = getMonthDates();
  const payload = {
    monthName: monthNames[currentMonth],
    year: currentYear,
    dates: dates.map(date => ({
      day: date.getDate(),
      dayName: dayNames[date.getDay()],
      weekend: date.getDay() === 5 || date.getDay() === 6
    })),
    employees: allEmployees.map(person => {
      const leave = getLeaveStats(person);
      return {
        name: person.name,
        role: person.role,
        leaveUsed: leave.used,
        leaveRemaining: leave.remaining,
        schedule: dates.map(date => customShiftOverrides[scheduleKey(person.name, date)] || readCellValue(person, date))
      };
    })
  };
  const response = await fetch('/api/export-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error('Não foi possível criar o PDF.');
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `mr-pizza-${monthNames[currentMonth].toLowerCase()}-${currentYear}.pdf`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('PDF descarregado com sucesso.');
}
document.getElementById('print-schedule').addEventListener('click', async () => {
  const button = document.getElementById('print-schedule');
  button.disabled = true;
  button.textContent = 'A preparar PDF...';
  try { await exportSchedulePdf(); } catch (error) { toast(error.message); } finally { button.disabled = false; button.textContent = '↓ Baixar PDF'; }
});
document.getElementById('ai-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('ai-prompt');
  const prompt = input.value.trim();
  if (!prompt) return;
  addAiMessage(`<span class="ai-user-label">Você</span><p>${escapeHtml(prompt)}</p>`, 'user-message');
  aiConversation.push({ role: 'user', text: prompt });
  input.value = '';
  if (pendingAssistantOperation && isExplicitConfirmation(prompt)) {
    addAiMessage(`<strong>Mr Pizza IA</strong><p>Vou confirmar: ${escapeHtml(pendingAssistantOperation.summary)}.</p>`);
    startAiExecution('A confirmar a operação...');
    await confirmAssistantOperation(pendingAssistantOperation.id);
    stopAiExecution();
    return;
  }
  if (pendingAssistantOperation && isExplicitCancellation(prompt)) {
    pendingAssistantOperation = null;
    document.querySelectorAll('[data-assistant-confirm], [data-assistant-cancel]').forEach(button => button.closest('.ai-confirm-actions')?.remove());
    const cancellation = 'Está bem, cancelei a proposta. Não alterei os dados.';
    aiConversation.push({ role: 'model', text: cancellation });
    addAiMessage(`<strong>Mr Pizza IA</strong><p>${cancellation}</p>`);
    return;
  }
  addAiMessage('<strong>Mr Pizza IA</strong><p class="ai-thinking">A analisar a sua mensagem...</p>');

  startAiExecution('A IA está a analisar o pedido...');
  try {
    const result = await requestAssistantMessage(prompt);
    const assistantMessage = result.message;
    aiConversation.push({ role: 'model', text: assistantMessage });
    addAiMessage(`<strong>Mr Pizza IA</strong><p>${escapeHtml(assistantMessage)}</p>`);
    if (result.action) await executeAssistantAction(result.action);
    if (result.pendingOperation) {
      pendingAssistantOperation = result.pendingOperation;
      addAiMessage(`<div class="ai-confirm-actions"><button type="button" data-assistant-confirm="${escapeHtml(result.pendingOperation.id)}">Confirmar e executar</button><button type="button" data-assistant-cancel>Cancelar</button></div>`);
    }
    renderAiSuggestions();
  } finally {
    stopAiExecution();
    document.querySelectorAll('.ai-thinking').forEach(item => item.closest('.ai-message')?.remove());
  }
});
document.getElementById('ai-chat').addEventListener('click', async event => {
  const confirm = event.target.closest('button[data-assistant-confirm]');
  const cancel = event.target.closest('button[data-assistant-cancel]');
  if (confirm && pendingAssistantOperation?.id === confirm.dataset.assistantConfirm) {
    startAiExecution('A confirmar a operação...');
    await confirmAssistantOperation(pendingAssistantOperation.id);
    stopAiExecution();
  } else if (cancel && pendingAssistantOperation) {
    pendingAssistantOperation = null;
    cancel.closest('.ai-confirm-actions')?.remove();
    addAiMessage('<strong>Mr Pizza IA</strong><p>Proposta cancelada. Não alterei os dados.</p>');
  }
});
document.getElementById('cancel-ai-execution').addEventListener('click', () => {
  aiExecutionStopped = true;
  stopAiExecution();
  addAiMessage('<strong>Mr Pizza IA</strong><p>Parei a animação. A tarefa só é alterada depois da tua confirmação.</p>');
});
renderAiSuggestions();
document.getElementById('toggle-password-visibility').addEventListener('click', event => {
  const button = event.currentTarget;
  const passwordInput = document.getElementById('auth-password');
  const isVisible = passwordInput.type === 'text';
  passwordInput.type = isVisible ? 'password' : 'text';
  button.textContent = isVisible ? 'Mostrar' : 'Ocultar';
  button.setAttribute('aria-pressed', String(!isVisible));
  button.setAttribute('aria-label', isVisible ? 'Mostrar palavra-passe' : 'Ocultar palavra-passe');
});
document.getElementById('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const errorElement = document.getElementById('auth-error');
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  errorElement.textContent = '';
  if (!supabaseClient) {
    errorElement.textContent = 'O Supabase não está configurado no servidor.';
    return;
  }
  submitButton.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: document.getElementById('auth-email').value.trim(),
      password: document.getElementById('auth-password').value
    });
    if (error) {
      const code = String(error.code || '').toLowerCase();
      if (code === 'email_not_confirmed') {
        errorElement.textContent = 'O email da conta ainda não foi confirmado. Confirma-o no Supabase Authentication → Users ou pede um novo email de confirmação.';
      } else if (code === 'too_many_requests' || error.status === 429) {
        errorElement.textContent = 'Foram feitas muitas tentativas. Aguarda alguns minutos antes de tentar novamente.';
      } else if (code === 'user_banned') {
        errorElement.textContent = 'Esta conta está desativada. Verifica o estado do utilizador em Supabase Authentication → Users.';
      } else if (code === 'invalid_credentials' || code === 'invalid_grant' || error.status === 400) {
        errorElement.textContent = 'Email ou palavra-passe incorretos, ou a conta ainda não foi criada. Em Supabase Authentication → Users, confirma que existe um utilizador com este email; a conta do painel Supabase não é a mesma conta.';
      } else {
        errorElement.textContent = 'Não foi possível validar a sessão com o Supabase. Verifica a ligação e o estado do serviço e tenta novamente.';
      }
      return;
    }
    document.getElementById('auth-password').value = '';
    await initializeCloudApp();
  } catch {
    errorElement.textContent = 'Não foi possível contactar o projeto Supabase configurado. Confirma se a URL do projeto está correta e se o serviço está acessível.';
  } finally {
    submitButton.disabled = false;
  }
});
document.getElementById('sign-out').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    currentUser = null;
    workspaceId = null;
    allEmployees.length = 0;
    Object.keys(manualOverrides).forEach(key => delete manualOverrides[key]);
    Object.keys(customShiftOverrides).forEach(key => delete customShiftOverrides[key]);
    persistedScheduleCells.clear();
    generated = false;
    scheduleCleared = false;
    currentMonth = new Date().getMonth();
    currentYear = new Date().getFullYear();
    pendingAssistantOperation = null;
    aiConversation.length = 0;
    aiHistory.length = 0;
    document.getElementById('ai-chat').innerHTML = '<div class="ai-message"><strong>Olá</strong><p>Inicia sessão para usar o assistente da equipa.</p></div>';
    document.querySelector('.ai-panel').classList.remove('ai-panel-open');
    document.getElementById('open-ai-assistant').classList.remove('assistant-open');
    document.getElementById('open-ai-assistant').setAttribute('aria-expanded', 'false');
    document.getElementById('manager-email').textContent = '';
    document.getElementById('sidebar-user-name').textContent = 'Gerente';
    document.getElementById('sidebar-user-avatar').textContent = 'G';
    navigateToTab('overview');
    renderWeek();
    renderPreview();
    renderTeam();
    renderSchedule();
    renderOverview();
    document.querySelector('.app-shell').inert = true;
    document.getElementById('open-ai-assistant').inert = true;
    document.getElementById('auth-email').value = '';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-error').textContent = '';
    document.getElementById('auth-overlay').hidden = false;
  } catch (error) {
    console.error('Sign out failed:', error.name);
    toast('Não foi possível terminar a sessão. Tenta novamente.');
  } finally {
    button.disabled = false;
  }
});
document.getElementById('employee-dialog-cancel').addEventListener('click', () => document.getElementById('employee-dialog').close());
initializeAppConfiguration();
