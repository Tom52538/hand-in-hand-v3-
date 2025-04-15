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
 * Iteriert durch alle Tage zwischen zwei Daten (inklusive Start, exklusive Ende).
 * @param {Date} startDate - Startdatum (UTC)
 * @param {Date} endDate - Enddatum (UTC)
 * @param {function(string): void} callback - Funktion, die für jedes Datum (Format "YYYY-MM-DD") aufgerufen wird.
 */
function forEachDayBetween(startDate, endDate, callback) {
    let current = new Date(startDate.getTime()); // Kopie erstellen
    while (current < endDate) {
        const dateStr = current.toISOString().split('T')[0];
        callback(dateStr);
        current.setUTCDate(current.getUTCDate() + 1); // Nächsten Tag setzen
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
      : String(entry.date).split('T')[0]; // Sicherstellen, dass es ein String ist
    const expected = getExpectedHours(employee, entryDateStr);
    entry.expectedHours = expected;      // Für spätere Auswertung
    totalExpected += expected;
    const worked = parseFloat(entry.hours) || 0;
    totalActual += worked;
    totalDifference += worked - expected;
  });

   // Übertrag aus dem Vormonat ermitteln
   const prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1)); // Erster Tag des Vormonats
   const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
   const prevResult = await db.query(
     `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
     [employee.id, prevMonthDateStr]
   );
   const previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;

   // Neuen Übertrag berechnen: previousCarry + (totalActual - totalExpected)
   const newCarry = previousCarry + totalDifference;

   // Saldo des aktuellen Monats in der Datenbank speichern/aktualisieren
   const currentMonthDateStr = startDateStr; // Jahr-Monat für den aktuellen Saldo
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
     newCarryOver: parseFloat(newCarry.toFixed(2)), // Der berechnete Saldo am Ende des Monats
     workEntries: workEntries // Die Buchungen nur dieses Monats
   };
}
/**
 * Berechnet für einen Mitarbeiter die Daten für ein Quartal oder Jahr.
 * @param {Object} db - Die PostgreSQL-Datenbankverbindung (Pool).
 * @param {string} name - Name des Mitarbeiters.
 * @param {string|number} year - Jahr, z. B. "2025".
 * @param {'QUARTER'|'YEAR'} periodType - Art des Zeitraums.
 * @param {number} [periodValue] - Wert des Zeitraums (1-4 für Quartal, irrelevant für Jahr).
 * @returns {Object} - Ein Objekt mit den ermittelten Periodendaten.
 */
async function calculatePeriodData(db, name, year, periodType, periodValue) {
    const parsedYear = parseInt(year);
    if (!name || !year || isNaN(parsedYear) || !['QUARTER', 'YEAR'].includes(periodType)) {
        throw new Error("Ungültiger Name, Jahr oder Periodentyp angegeben.");
    }

    let startMonth, endMonth;
    let periodIdentifier = '';

    if (periodType === 'QUARTER') {
        const quarter = parseInt(periodValue);
        if (isNaN(quarter) || quarter < 1 || quarter > 4) {
            throw new Error("Ungültiges Quartal angegeben (1-4 erforderlich).");
        }
        startMonth = (quarter - 1) * 3 + 1; // Q1 -> M1, Q2 -> M4, etc.
        endMonth = quarter * 3;             // Q1 -> M3, Q2 -> M6, etc.
        periodIdentifier = `Q${quarter}`;
    } else { // YEAR
        startMonth = 1;
        endMonth = 12;
        periodIdentifier = 'Gesamtjahr';
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

    // Datumsbereich für den gesamten Zeitraum festlegen (UTC)
    // Start: Erster Tag des Startmonats
    const periodStartDate = new Date(Date.UTC(parsedYear, startMonth - 1, 1));
    // Ende: Erster Tag des Monats NACH dem Endmonat (exklusiv)
    const periodEndDate = new Date(Date.UTC(parsedYear, endMonth, 1));
    const periodStartDateStr = periodStartDate.toISOString().split('T')[0];
    const periodEndDateStr = periodEndDate.toISOString().split('T')[0];

    // --- Startsaldo ermitteln ---
    // Monat VOR dem Startmonat
    const balanceStartDate = new Date(Date.UTC(parsedYear, startMonth - 2, 1));
    const balanceStartDateStr = balanceStartDate.toISOString().split('T')[0];
    const prevResult = await db.query(
        `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
        [employee.id, balanceStartDateStr]
    );
    const startingBalance = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;


    // --- Daten für den Zeitraum abrufen ---
    // Alle Arbeitszeiten im Zeitraum
    const workResult = await db.query(
        `SELECT id, date, hours, comment,
                TO_CHAR(starttime, 'HH24:MI') AS "startTime",
                TO_CHAR(endtime, 'HH24:MI') AS "endTime"
         FROM work_hours
         WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3
         ORDER BY date ASC`,
        [name.toLowerCase(), periodStartDateStr, periodEndDateStr]
    );
    const workEntriesPeriod = workResult.rows;

    // --- Berechnungen für den Zeitraum ---
    let totalExpectedPeriod = 0;
    let totalActualPeriod = 0;

    // 1. Ist-Stunden summieren
    workEntriesPeriod.forEach(entry => {
        totalActualPeriod += parseFloat(entry.hours) || 0;
    });

    // 2. Soll-Stunden für jeden Tag im Zeitraum summieren
    forEachDayBetween(periodStartDate, periodEndDate, (dateStr) => {
         totalExpectedPeriod += getExpectedHours(employee, dateStr);
    });


    const periodDifference = totalActualPeriod - totalExpectedPeriod;
    const endingBalancePeriod = startingBalance + periodDifference;

    return {
        employeeName: employee.name,
        year: parsedYear,
        periodType: periodType,
        periodValue: periodValue, // (Quarter number or null for year)
        periodIdentifier: periodIdentifier, // Q1, Q2, Q3, Q4 or Gesamtjahr
        periodStartDate: periodStartDateStr,
        periodEndDate: new Date(Date.UTC(parsedYear, endMonth, 0)).toISOString().split('T')[0], // Letzter Tag des Endmonats
        startingBalance: parseFloat(startingBalance.toFixed(2)),
        totalExpectedPeriod: parseFloat(totalExpectedPeriod.toFixed(2)),
        totalActualPeriod: parseFloat(totalActualPeriod.toFixed(2)),
        periodDifference: parseFloat(periodDifference.toFixed(2)),
        endingBalancePeriod: parseFloat(endingBalancePeriod.toFixed(2)),
        workEntriesPeriod: workEntriesPeriod // Alle Buchungen des Zeitraums
    };
}


module.exports = {
  getExpectedHours,
  calculateMonthlyData,
  calculatePeriodData // Neue Funktion exportieren
};
