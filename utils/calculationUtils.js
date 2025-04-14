// utils/calculationUtils.js

// --- Benötigte Hilfsfunktionen ---
function getExpectedHours(employeeData, dateStr) {
  // Ermittelt die Soll-Stunden für einen gegebenen Mitarbeiter und Datum
  if (!employeeData || !dateStr) return 0;
  try {
    // Stelle sicher, dass dateStr ein gültiges Datum ist (YYYY-MM-DD)
    const d = new Date(dateStr + 'T00:00:00Z'); // Als UTC interpretieren
    if (isNaN(d.getTime())) {
      console.warn(`Ungültiges Datum für getExpectedHours: ${dateStr}`);
      return 0;
    }
    const day = d.getUTCDay(); // 0 = Sonntag, 1 = Montag, …, 6 = Samstag (UTC)
    switch (day) {
      case 1: return employeeData.mo_hours || 0;
      case 2: return employeeData.di_hours || 0;
      case 3: return employeeData.mi_hours || 0;
      case 4: return employeeData.do_hours || 0;
      case 5: return employeeData.fr_hours || 0;
      default: return 0; // Wochenende oder fehlende Angabe
    }
  } catch (e) {
    console.error(`Fehler in getExpectedHours mit Datum: ${dateStr}`, e);
    return 0; // Im Fehlerfall 0 zurückgeben
  }
}

// --- Hauptfunktion ---
async function calculateMonthlyData(db, name, year, month) {
  // Berechnet Monatsdifferenz, Überträge und sammelt Buchungsdaten
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);

  if (!name || !year || !month || isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new Error("Ungültiger Name, Jahr oder Monat angegeben.");
  }

  // Mitarbeiterdaten abrufen
  const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name]);
  if (empResult.rows.length === 0) {
    throw new Error("Mitarbeiter nicht gefunden.");
  }
  const employee = empResult.rows[0];

  // Datumsbereich für den Monat festlegen (UTC)
  const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Exklusiv (bis zum ersten des nächsten Monats)
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  // Arbeitszeiten für den Monat abrufen
  const workResult = await db.query(
    `SELECT id, date, hours, break_time, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
     FROM work_hours
     WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3
     ORDER BY date ASC`,
    [name.toLowerCase(), startDateStr, endDateStr]
  );
  const workEntries = workResult.rows;

  // Monatliche Differenz berechnen und Soll-Stunden zu Einträgen hinzufügen
  let totalDifference = 0;
  workEntries.forEach(entry => {
    // Sicherstellen, dass das Datum als String vorliegt
    const entryDateStr = (entry.date instanceof Date)
      ? entry.date.toISOString().split('T')[0]
      : entry.date;
    // Soll-Stunden für den Tag berechnen
    const expected = getExpectedHours(employee, entryDateStr);
    // Füge Soll-Stunden zum Eintrag hinzu
    entry.expectedHours = expected;
    // Sicherstellen, dass die gearbeiteten Stunden als Zahl behandelt werden
    const workedHours = parseFloat(entry.hours) || 0;
    // Differenz ermitteln und zur Gesamtdifferenz addieren
    totalDifference += workedHours - expected;
  });

  // Übertrag aus dem Vormonat ermitteln
  let prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
  const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
  const prevResult = await db.query(
    `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
    [employee.id, prevMonthDateStr]
  );
  let previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;

  // Neuen Übertrag berechnen
  const newCarry = previousCarry + totalDifference;

  // Aktuellen Saldo speichern/aktualisieren (optional, aber konsistent)
  const currentMonthDateStr = startDateStr;
  const upsertQuery = `
    INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (employee_id, year_month) DO UPDATE SET
      difference = EXCLUDED.difference,
      carry_over = EXCLUDED.carry_over;
  `;
  await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);

  // Ergebnisse zurückgeben
  return {
    employeeName: employee.name,
    month: parsedMonth,
    year: parsedYear,
    monthlyDifference: parseFloat(totalDifference.toFixed(2)),
    previousCarryOver: parseFloat(previousCarry.toFixed(2)),
    newCarryOver: parseFloat(newCarry.toFixed(2)),
    workEntries: workEntries // Enthält nun auch 'expectedHours' pro Eintrag
  };
}

// Exportiere die Funktionen für andere Module
module.exports = { calculateMonthlyData, getExpectedHours };
