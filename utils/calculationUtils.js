// utils/calculationUtils.js

// --- Benötigte Hilfsfunktionen ---
function getExpectedHours(employeeData, dateStr) {
  if (!employeeData || !dateStr) return 0;
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0 = Sonntag, 1 = Montag, …, 6 = Samstag (UTC)
  switch (day) {
    case 1: return employeeData.mo_hours || 0;
    case 2: return employeeData.di_hours || 0;
    case 3: return employeeData.mi_hours || 0;
    case 4: return employeeData.do_hours || 0;
    case 5: return employeeData.fr_hours || 0;
    default: return 0;
  }
}

// --- Hauptfunktion ---
async function calculateMonthlyData(db, name, year, month) {
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);

  if (!name || !year || !month || isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new Error("Ungültiger Name, Jahr oder Monat angegeben.");
  }

  const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name]);
  if (empResult.rows.length === 0) {
    throw new Error("Mitarbeiter nicht gefunden.");
  }
  const employee = empResult.rows[0];

  const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  const workResult = await db.query(
    `SELECT id, date, hours, break_time, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
     FROM work_hours
     WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3
     ORDER BY date ASC`,
    [name.toLowerCase(), startDateStr, endDateStr]
  );
  const workEntries = workResult.rows;

  let totalDifference = 0;
  workEntries.forEach(entry => {
    const expected = getExpectedHours(employee, entry.date.toISOString().split('T')[0]);
    totalDifference += (entry.hours || 0) - expected;
  });

  let prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
  const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];

  const prevResult = await db.query(
    `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
    [employee.id, prevMonthDateStr]
  );
  let previousCarry = prevResult.rows.length > 0 ? (prevResult.rows[0].carry_over || 0) : 0;
  const newCarry = previousCarry + totalDifference;

  const currentMonthDateStr = startDateStr;
  const upsertQuery = `
    INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (employee_id, year_month) DO UPDATE SET
      difference = EXCLUDED.difference,
      carry_over = EXCLUDED.carry_over;
  `;
  await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);

  return {
    employeeName: employee.name,
    month: parsedMonth,
    year: parsedYear,
    monthlyDifference: parseFloat(totalDifference.toFixed(2)),
    previousCarryOver: parseFloat(previousCarry.toFixed(2)),
    newCarryOver: parseFloat(newCarry.toFixed(2)),
    workEntries: workEntries
  };
}

// Exportiere beide Funktionen, damit sie anderswo genutzt werden können
module.exports = { calculateMonthlyData, getExpectedHours };
