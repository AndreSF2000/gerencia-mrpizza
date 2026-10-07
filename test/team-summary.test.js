const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getActiveEmployees, getTeamSummary } = require('../team-summary.js');

test('shows the real active employee count in the team heading', () => {
  const employees = [
    { id: 'andre', name: 'Andre Fernandes', status: 'active' }
  ];

  assert.equal(getTeamSummary(employees), '1 funcionário · 2 turnos por dia');
});

test('uses plural for multiple active employees', () => {
  const employees = [
    { id: '1', status: 'active' },
    { id: '2', status: 'active' }
  ];

  assert.equal(getTeamSummary(employees), '2 funcionários · 2 turnos por dia');
});

test('excludes inactive employees and safely handles an empty team', () => {
  const employees = [
    { id: 'active', status: 'active' },
    { id: 'inactive', status: 'inactive' }
  ];

  assert.deepEqual(getActiveEmployees(employees), [employees[0]]);
  assert.equal(getTeamSummary(employees), '1 funcionário · 2 turnos por dia');
  assert.equal(getTeamSummary([]), '0 funcionários · 2 turnos por dia');
});
