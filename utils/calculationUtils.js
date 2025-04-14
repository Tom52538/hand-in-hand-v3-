// utils/calculationUtils.js

/**
 * Ermittelt die Soll-Stunden für einen Mitarbeiter an einem bestimmten Datum.
 * @param {Object} employeeData - Datensatz des Mitarbeiters.
 * @param {string} dateStr - Datum im Format "YYYY-MM-DD".
 * @returns {number} - Soll-Stunden für den Tag.
 */
function getExpectedHours(employeeData, dateStr) {
  if (!employeeData || !dateStr) return 0;
  try {
    // Datum als gültiges Datum interpretieren (YYYY-MM-DD), UTC-Zeit verwenden
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) {
      console.warn(`Ungültiges Datum für getExpectedHours: ${dateStr}`);
      return 0;
    }
    const day = d.getUTCDay(); // 0 = Sonntag, 1 = Montag, ... 6 = Samstag
    switch (day) {
      case 1: return employeeData.mo_hours || 0;
      case 2: return employeeData.di_hours || 0;
      case 3: return employeeData.mi_hours || 0;
      case 4: return employeeData.do_hours || 0;
      case 5: return employeeData.fr_hours || 0;
      default: return 0; // Wochenende oder nicht definiert
    }
  } catch (e) {
    console.error(`Fehler in getExpectedHours mit Datum: ${dateStr}`, e);
    return 0;
  }
}

/**
 * Berechnet für einen Mitarbeiter die Monatsdaten, fasst Arbeitszeiten zusammen und
 * aktualisiert ggf. die Tabelle monthly_balance.
 * @param {Object} db - Die PostgreSQL-Datenbankverbindung (Pool).
 * @param {string} name - Name des Mitarbeiters.
 * @param {string|number} year - Jahr, z. B. "2025".
 * @param {string|number} month - Monat, z. B. "3" für März.
 * @returns {Object} - Ein Objekt mit den ermittelten Monatsdaten und den Arbeitszeiteinträgen.
 */
async function calculateMonthlyData(db, name, year, month) {
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);
  if (!name || !year || !month || isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new Error("Ungültiger Name, Jahr oder Monat angegeben.");
  }

  // Mitarbeiter-Daten abrufen
  const empResult = await db.query(
    `SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`,
    [name]
  );
  if (empResult.rows.length === 0) {
    throw new Error("Mitarbeiter nicht gefunden.");
  }
  const employee = empResult.rows[0];

  // Datumsbereich für den Monat festlegen (UTC)
  const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Exklusiv – erster Tag des Folgemonats
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  // Arbeitszeiten für den Monat abrufen
  const workResult = await db.query(
    `SELECT id, date, hours, break_time, comment, 
            TO_CHAR(starttime, 'HH24:MI') AS "startTime", 
            TO_CHAR(endtime, 'HH24:MI') AS "endTime"
     FROM work_hours
     WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3
     ORDER BY date ASC`,
    [name.toLowerCase(), startDateStr, endDateStr]
  );
  const workEntries = workResult.rows;

  // Initialisierung der Summen: Differenz, Soll- und Ist-Arbeitsstunden
  let totalExpected = 0;
  let totalActual = 0;
  let totalDifference = 0;

  // Für jeden Arbeitszeiteintrag: Soll-Stunden ermitteln, Summen fortlaufend addieren
  workEntries.forEach(entry => {
    // Datum als String
    const entryDateStr = (entry.date instanceof Date)
      ? entry.date.toISOString().split('T')[0]
      : entry.date;
    const expected = getExpectedHours(employee, entryDateStr);
    entry.expectedHours = expected;      // Für spätere Auswertung
    totalExpected += expected;
    const worked = parseFloat(entry.hours) || 0;
    totalActual += worked;
    totalDifference += worked - expected;
  });

  // Übertrag aus dem Vormonat ermitteln
  const prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
  const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
  const prevResult = await db.query(
    `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
    [employee.id, prevMonthDateStr]
  );
  const previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;

  // Neuen Übertrag berechnen: previousCarry + (totalActual - totalExpected)
  const newCarry = previousCarry + totalDifference;

  // Saldo des aktuellen Monats in der Datenbank speichern/aktualisieren
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
    previousCarryOver: parseFloat(previousCarry.toFixed(2)),
    totalExpected: parseFloat(totalExpected.toFixed(2)),
    totalActual: parseFloat(totalActual.toFixed(2)),
    newCarryOver: parseFloat(newCarry.toFixed(2)),
    workEntries: workEntries
  };
}

module.exports = {
  getExpectedHours,
  calculateMonthlyData
};
