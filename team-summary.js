(function (root, factory) {
  const teamSummary = factory();
  if (typeof module === 'object' && module.exports) module.exports = teamSummary;
  if (root) root.MrPizzaTeamSummary = teamSummary;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function getActiveEmployees(employees = []) {
    if (!Array.isArray(employees)) return [];
    return employees.filter(employee => employee && employee.status !== 'inactive');
  }

  function getTeamSummary(employees = []) {
    const total = getActiveEmployees(employees).length;
    const noun = total === 1 ? 'funcionário' : 'funcionários';
    return `${total} ${noun} · 2 turnos por dia`;
  }

  return { getActiveEmployees, getTeamSummary };
});
