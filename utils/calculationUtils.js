// utils/calculationUtils.js

/**
 * Ermittelt die Soll-Stunden für einen Mitarbeiter an einem bestimmten Datum.
 * Bleibt unverändert: Liefert die vertraglich vereinbarten Soll-Stunden.
 * @param {Object} employeeData - Datensatz des Mitarbeiters.
 * @param {string} dateStr - Datum im Format "YYYY-MM-DD".
 * @returns {number} - Soll-Stunden für den Tag.
 */
function getExpectedHours(employeeData, dateStr) {
  if (!employeeData || !dateStr) return 0;
  try {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) {
      // console.warn(`Ungültiges Datum für getExpectedHours: ${dateStr}`); // Weniger Logging
      return 0;
    }
    // 0=Sonntag, 1=Montag, ..., 6=Samstag
    const day = d.getUTCDay();
    switch (day) {
      case 1: return employeeData.mo_hours || 0;
      case 2: return employeeData.di_hours || 0;
      case 3: return employeeData.mi_hours || 0;
      case 4: return employeeData.do_hours || 0;
      case 5: return employeeData.fr_hours || 0;
      default: return 0; // Wochenende
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
 * @param {function(string, number): void} callback - Funktion, die für jedes Datum (Format "YYYY-MM-DD") und den Wochentag (0-6) aufgerufen wird.
 */
function forEachDayBetween(startDate, endDate, callback) {
    let current = new Date(startDate.getTime()); // Kopie erstellen
    while (current < endDate) {
        const dateStr = current.toISOString().split('T')[0];
        const dayOfWeek = current.getUTCDay(); // 0=So, 6=Sa
        callback(dateStr, dayOfWeek);
        current.setUTCDate(current.getUTCDate() + 1); // Nächsten Tag setzen
    }
}

/**
 * Prüft, ob ein Wochentag ein Standard-Arbeitstag ist (Mo-Fr).
 * @param {number} dayOfWeek - Der Wochentag (0=So, 1=Mo, ..., 6=Sa).
 * @returns {boolean} - True, wenn Mo-Fr, sonst false.
 */
function isStandardWorkday(dayOfWeek) {
    return dayOfWeek >= 1 && dayOfWeek <= 5; // Montag bis Freitag
}


/**
 * Berechnet für einen Mitarbeiter die Monatsdaten unter Berücksichtigung von Abwesenheiten.
 * @param {Object} db - Die PostgreSQL-Datenbankverbindung (Pool).
 * @param {string} name - Name des Mitarbeiters.
 * @param {string|number} year - Jahr.
 * @param {string|number} month - Monat.
 * @returns {Object} - Ein Objekt mit den ermittelten Monatsdaten inkl. Abwesenheitsinfos.
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
  const employee = empResult.rows[0];

  // Datumsbereich für den Monat (UTC)
  const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Exklusiv
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  // Arbeitszeiten für den Monat abrufen
  const workResult = await db.query(
    `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
     FROM work_hours
     WHERE employee_id = $1 AND date >= $2 AND date < $3 -- Nach employee_id filtern
     ORDER BY date ASC`,
    [employee.id, startDateStr, endDateStr] // Verwende employee.id
  );
  const workEntries = workResult.rows;

  // *** NEU: Abwesenheiten für den Monat abrufen ***
  const absenceResult = await db.query(
      `SELECT date, absence_type, credited_hours
       FROM absences
       WHERE employee_id = $1 AND date >= $2 AND date < $3`,
      [employee.id, startDateStr, endDateStr]
  );
  // Konvertiere Ergebnis in eine Map für schnellen Zugriff: Map<DateString, AbsenceInfo>
  const absenceMap = new Map();
  absenceResult.rows.forEach(a => {
      const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date);
      absenceMap.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 });
  });
  // *** ENDE NEU ***

  let totalExpected = 0;
  let totalActual = 0;
  let absenceHoursTotal = 0; // Zum separaten Zählen der Abwesenheitsstunden
  let workedHoursTotal = 0; // Zum separaten Zählen der gearbeiteten Stunden

  // *** GEÄNDERT: Berechnung totalActual ***
  // 1. Gearbeitete Stunden summieren
  workEntries.forEach(entry => {
    workedHoursTotal += parseFloat(entry.hours) || 0;
  });
  // 2. Gutgeschriebene Stunden aus Abwesenheiten summieren (nur an Standard-Arbeitstagen Mo-Fr)
  forEachDayBetween(startDate, endDate, (dateStr, dayOfWeek) => {
      if (absenceMap.has(dateStr) && isStandardWorkday(dayOfWeek)) {
          absenceHoursTotal += absenceMap.get(dateStr).hours;
      }
  });
  totalActual = workedHoursTotal + absenceHoursTotal;
  // *** ENDE ÄNDERUNG totalActual ***

  // *** GEÄNDERT: Berechnung totalExpected ***
  forEachDayBetween(startDate, endDate, (dateStr, dayOfWeek) => {
    // Ist es ein Standard-Arbeitstag (Mo-Fr)?
    if (isStandardWorkday(dayOfWeek)) {
        // Ist an diesem Arbeitstag eine Abwesenheit oder Feiertag eingetragen?
        if (absenceMap.has(dateStr)) {
            // Ja, also sind 0 Stunden Anwesenheit erwartet
            totalExpected += 0;
        } else {
            // Nein, normaler Arbeitstag -> Standard-Soll holen
            totalExpected += getExpectedHours(employee, dateStr);
        }
    } else {
        // Wochenende -> 0 Stunden erwartet (es sei denn, es gäbe spezielle Wochenend-Regeln)
        totalExpected += 0;
    }
  });
  // *** ENDE ÄNDERUNG totalExpected ***

  const totalDifference = totalActual - totalExpected;

   // Übertrag aus dem Vormonat ermitteln
   const prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
   const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
   const prevResult = await db.query(
     `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
     [employee.id, prevMonthDateStr]
   );
   const previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;

   // Neuen Übertrag berechnen
   const newCarry = previousCarry + totalDifference;

   // Saldo des aktuellen Monats in der Datenbank speichern/aktualisieren
   const currentMonthDateStr = startDateStr;
   const upsertQuery = `
     INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, year_month) DO UPDATE SET
       difference = EXCLUDED.difference, carry_over = EXCLUDED.carry_over;
   `;
   await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);

   // Optional: Detail-Infos zu Abwesenheiten hinzufügen
   const absenceDetails = Array.from(absenceMap.entries()).map(([date, info]) => ({ date, ...info }));

   return {
     employeeName: employee.name,
     month: parsedMonth,
     year: parsedYear,
     previousCarryOver: parseFloat(previousCarry.toFixed(2)),
     totalExpected: parseFloat(totalExpected.toFixed(2)), // Angepasste Soll-Summe
     totalActual: parseFloat(totalActual.toFixed(2)),    // Angepasste Ist-Summe (Arbeit + Abw.)
     workedHours: parseFloat(workedHoursTotal.toFixed(2)), // Nur gearbeitete Stunden
     absenceHours: parseFloat(absenceHoursTotal.toFixed(2)), // Nur Abwesenheitsstunden
     newCarryOver: parseFloat(newCarry.toFixed(2)),
     workEntries: workEntries, // Nur tatsächliche Arbeitsbuchungen
     absenceEntries: absenceDetails // Liste der Abwesenheiten im Monat
   };
}
