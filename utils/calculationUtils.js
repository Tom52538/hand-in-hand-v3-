// utils/calculationUtils.js

// getExpectedHours, forEachDayBetween, isStandardWorkday (bleiben unverändert)
function getExpectedHours(employeeData, dateStr) { /* ... */ if (!employeeData || !dateStr) return 0; try { const d = new Date(dateStr + 'T00:00:00Z'); if (isNaN(d.getTime())) { return 0; } const day = d.getUTCDay(); switch (day) { case 1: return employeeData.mo_hours || 0; case 2: return employeeData.di_hours || 0; case 3: return employeeData.mi_hours || 0; case 4: return employeeData.do_hours || 0; case 5: return employeeData.fr_hours || 0; default: return 0; } } catch (e) { console.error(`Fehler in getExpectedHours: ${dateStr}`, e); return 0; } }
function forEachDayBetween(startDate, endDate, callback) { /* ... */ let current = new Date(startDate.getTime()); while (current < endDate) { const dateStr = current.toISOString().split('T')[0]; const dayOfWeek = current.getUTCDay(); callback(dateStr, dayOfWeek); current.setUTCDate(current.getUTCDate() + 1); } }
function isStandardWorkday(dayOfWeek) { /* ... */ return dayOfWeek >= 1 && dayOfWeek <= 5; }


/**
 * Berechnet für einen Mitarbeiter die Monatsdaten unter Berücksichtigung von Abwesenheiten.
 * @param {Object} db - Die PostgreSQL-Datenbankverbindung (Pool).
 * @param {string} name - Name des Mitarbeiters.
 * @param {string|number} year - Jahr.
 * @param {string|number} month - Monat.
 * @returns {Object} - Ein Objekt mit den ermittelten Monatsdaten inkl. Abwesenheitsinfos und employeeData.
 */
async function calculateMonthlyData(db, name, year, month) {
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);
  if (!name || !year || !month || isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new Error("Ungültiger Name, Jahr oder Monat angegeben.");
  }

  // Mitarbeiter-Daten abrufen
  const empResult = await db.query( `SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name.toLowerCase()]);
  if (empResult.rows.length === 0) throw new Error("Mitarbeiter nicht gefunden.");
  const employee = empResult.rows[0]; // Das Objekt brauchen wir im PDF

  // Datumsbereich für den Monat (UTC)
  const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  // Arbeitszeiten holen (korrigierte Abfrage)
  const workResult = await db.query(
    `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime" FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3 ORDER BY date ASC`,
    [name, startDateStr, endDateStr]
  );
  const workEntries = workResult.rows;

  // Abwesenheiten holen
  const absenceResult = await db.query(
      `SELECT date, absence_type, credited_hours FROM absences WHERE employee_id = $1 AND date >= $2 AND date < $3`,
      [employee.id, startDateStr, endDateStr]
  );
  const absenceMap = new Map();
  absenceResult.rows.forEach(a => { const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date); absenceMap.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 }); });

  // Berechnungen totalActual & totalExpected (unverändert von letzter korrekter Version)
  let totalActual = 0; let absenceHoursTotal = 0; let workedHoursTotal = 0;
  workEntries.forEach(entry => { workedHoursTotal += parseFloat(entry.hours) || 0; });
  forEachDayBetween(startDate, endDate, (dateStr, dayOfWeek) => { if (absenceMap.has(dateStr) && isStandardWorkday(dayOfWeek)) { absenceHoursTotal += absenceMap.get(dateStr).hours; } });
  totalActual = workedHoursTotal + absenceHoursTotal;
  let totalExpected = 0;
  forEachDayBetween(startDate, endDate, (dateStr, dayOfWeek) => { if (isStandardWorkday(dayOfWeek)) { if (absenceMap.has(dateStr)) { totalExpected += 0; } else { totalExpected += getExpectedHours(employee, dateStr); } } else { totalExpected += 0; } });
  const totalDifference = totalActual - totalExpected;

   // Übertrag & Saldo speichern (unverändert)
   const prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1)); const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
   const prevResult = await db.query( `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`, [employee.id, prevMonthDateStr] );
   const previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;
   const newCarry = previousCarry + totalDifference;
   const currentMonthDateStr = startDateStr;
   const upsertQuery = ` INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over) VALUES ($1, $2, $3, $4) ON CONFLICT (employee_id, year_month) DO UPDATE SET difference = EXCLUDED.difference, carry_over = EXCLUDED.carry_over; `;
   await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);
   const absenceDetails = Array.from(absenceMap.entries()).map(([date, info]) => ({ date, ...info }));

   // *** KORRIGIERT: employee Objekt mit zurückgeben ***
   return {
     employeeData: employee, // Mitarbeiterdaten für PDF hinzufügen
     employeeName: employee.name, month: parsedMonth, year: parsedYear,
     previousCarryOver: parseFloat(previousCarry.toFixed(2)),
     totalExpected: parseFloat(totalExpected.toFixed(2)),
     totalActual: parseFloat(totalActual.toFixed(2)),
     workedHours: parseFloat(workedHoursTotal.toFixed(2)),
     absenceHours: parseFloat(absenceHoursTotal.toFixed(2)),
     newCarryOver: parseFloat(newCarry.toFixed(2)),
     workEntries: workEntries,
     absenceEntries: absenceDetails
   };
}
/**
 * Berechnet für einen Mitarbeiter die Daten für ein Quartal oder Jahr unter Berücksichtigung von Abwesenheiten.
 * @param {Object} db - DB Pool.
 * @param {string} name - Mitarbeitername.
 * @param {string|number} year - Jahr.
 * @param {'QUARTER'|'YEAR'} periodType - Zeitraumtyp.
 * @param {number} [periodValue] - Quartalsnummer (1-4).
 * @returns {Object} - Periodendaten inkl. Abwesenheitsinfos und employeeData.
 */
async function calculatePeriodData(db, name, year, periodType, periodValue) {
    const parsedYear = parseInt(year);
    if (!name || !year || isNaN(parsedYear) || !['QUARTER', 'YEAR'].includes(periodType)) { throw new Error("Ungültige Parameter."); }
    let startMonth, endMonth, periodIdentifier = '';
    if (periodType === 'QUARTER') { /* ... Quartalslogik ... */ const quarter = parseInt(periodValue); if (isNaN(quarter) || quarter < 1 || quarter > 4) { throw new Error("Ungültiges Quartal."); } startMonth = (quarter - 1) * 3 + 1; endMonth = quarter * 3; periodIdentifier = `Q${quarter}`; }
    else { /* ... Jahreslogik ... */ startMonth = 1; endMonth = 12; periodIdentifier = 'Gesamtjahr'; }

    // Mitarbeiter-Daten abrufen
    const empResult = await db.query( `SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name.toLowerCase()]);
    if (empResult.rows.length === 0) throw new Error("Mitarbeiter nicht gefunden.");
    const employee = empResult.rows[0]; // Das Objekt brauchen wir im PDF

    // Zeitraum definieren
    const periodStartDate = new Date(Date.UTC(parsedYear, startMonth - 1, 1));
    const periodEndDate = new Date(Date.UTC(parsedYear, endMonth, 1));
    const periodStartDateStr = periodStartDate.toISOString().split('T')[0];
    const periodEndDateStr = periodEndDate.toISOString().split('T')[0];

    // Startsaldo holen (unverändert)
    const balanceStartDate = new Date(Date.UTC(parsedYear, startMonth - 2, 1)); const balanceStartDateStr = balanceStartDate.toISOString().split('T')[0];
    const prevResult = await db.query( `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`, [employee.id, balanceStartDateStr] );
    const startingBalance = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;

    // Arbeitszeiten holen (korrigierte Abfrage)
    const workResult = await db.query(
        `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime" FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3 ORDER BY date ASC`,
        [name, periodStartDateStr, periodEndDateStr] // Nach Name filtern
    );
    const workEntriesPeriod = workResult.rows;

    // Abwesenheiten holen (unverändert)
    const absenceResult = await db.query( `SELECT date, absence_type, credited_hours FROM absences WHERE employee_id = $1 AND date >= $2 AND date < $3`, [employee.id, periodStartDateStr, periodEndDateStr] );
    const absenceMap = new Map();
    absenceResult.rows.forEach(a => { const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date); absenceMap.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 }); });

    // Berechnungen totalActualPeriod & totalExpectedPeriod (unverändert)
    let totalActualPeriod = 0; let absenceHoursTotalPeriod = 0; let workedHoursTotalPeriod = 0;
    workEntriesPeriod.forEach(entry => { workedHoursTotalPeriod += parseFloat(entry.hours) || 0; });
    forEachDayBetween(periodStartDate, periodEndDate, (dateStr, dayOfWeek) => { if (absenceMap.has(dateStr) && isStandardWorkday(dayOfWeek)) { absenceHoursTotalPeriod += absenceMap.get(dateStr).hours; } });
    totalActualPeriod = workedHoursTotalPeriod + absenceHoursTotalPeriod;
    let totalExpectedPeriod = 0;
    forEachDayBetween(periodStartDate, periodEndDate, (dateStr, dayOfWeek) => { if (isStandardWorkday(dayOfWeek)) { if (absenceMap.has(dateStr)) { totalExpectedPeriod += 0; } else { totalExpectedPeriod += getExpectedHours(employee, dateStr); } } else { totalExpectedPeriod += 0; } });
    const periodDifference = totalActualPeriod - totalExpectedPeriod;
    const endingBalancePeriod = startingBalance + periodDifference;

    // Rückgabeobjekt
    const absenceDetailsPeriod = Array.from(absenceMap.entries()).map(([date, info]) => ({ date, ...info }));
    // *** KORRIGIERT: employee Objekt mit zurückgeben ***
    return {
        employeeData: employee, // Mitarbeiterdaten für PDF hinzufügen
        employeeName: employee.name, year: parsedYear, periodType: periodType,
        periodValue: periodType === 'QUARTER' ? parseInt(periodValue) : null,
        periodIdentifier: periodIdentifier,
        periodStartDate: periodStartDateStr,
        periodEndDate: new Date(periodEndDate.getTime() - 86400000).toISOString().split('T')[0],
        startingBalance: parseFloat(startingBalance.toFixed(2)),
        totalExpectedPeriod: parseFloat(totalExpectedPeriod.toFixed(2)),
        totalActualPeriod: parseFloat(totalActualPeriod.toFixed(2)),
        workedHoursPeriod: parseFloat(workedHoursTotalPeriod.toFixed(2)),
        absenceHoursPeriod: parseFloat(absenceHoursTotalPeriod.toFixed(2)),
        periodDifference: parseFloat(periodDifference.toFixed(2)),
        endingBalancePeriod: parseFloat(endingBalancePeriod.toFixed(2)),
        workEntriesPeriod: workEntriesPeriod,
        absenceEntriesPeriod: absenceDetailsPeriod
    };
}
module.exports = {
  getExpectedHours,
  calculateMonthlyData, // KORRIGIERT: Gibt jetzt employeeData zurück
  calculatePeriodData   // KORRIGIERT: Gibt jetzt employeeData zurück
};
