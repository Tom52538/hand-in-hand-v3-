// utils/calculationUtils.js

// KORRIGIERTE Funktion getExpectedHours
function getExpectedHours(employeeData, dateStr) {
    if (!employeeData || !dateStr) return 0;
    try {
        // *** FIX: Nur den Datumsanteil (YYYY-MM-DD) extrahieren ***
        const dateOnly = String(dateStr).split(' ')[0]; // Nimmt den Teil vor dem ersten Leerzeichen

        // Konstruiere das Datumsobjekt nur mit dem Datumsanteil + expliziter UTC-Zeit
        const d = new Date(dateOnly + 'T00:00:00Z');

        // Prüfe auf Gültigkeit nach der Bereinigung
        if (isNaN(d.getTime())) {
             // Verwende den Originalstring in der Warnung, um das Problem zu sehen
             console.warn(`Ungültiges Datum in getExpectedHours nach Bereinigung: Input='${dateStr}', Verwendet='${dateOnly}'`);
             return 0;
        }
        // *** ENDE FIX ***

        const day = d.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa
        switch (day) {
            case 1: return employeeData.mo_hours || 0;
            case 2: return employeeData.di_hours || 0;
            case 3: return employeeData.mi_hours || 0;
            case 4: return employeeData.do_hours || 0;
            case 5: return employeeData.fr_hours || 0;
            default: return 0; // Samstag, Sonntag haben keine Soll-Stunden per Definition hier
        }
    } catch (e) {
        console.error(`Fehler in getExpectedHours für Datum: ${dateStr}`, e);
        return 0;
    }
}

function forEachDayBetween(startDate, endDate, callback) {
    // Stellt sicher, dass endDate exklusiv ist (z.B. erster Tag des Folgemonats)
    let current = new Date(startDate.getTime()); // Kopie erstellen
    const end = new Date(endDate.getTime()); // Kopie erstellen

    while (current < end) {
        const dateStr = current.toISOString().split('T')[0];
        const dayOfWeek = current.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa
        callback(dateStr, dayOfWeek);
        // Datum um einen Tag erhöhen (UTC)
        current.setUTCDate(current.getUTCDate() + 1);
    }
}

function isStandardWorkday(dayOfWeek) {
    // Nimmt an, dass Standard-Arbeitstage Mo-Fr sind (relevant für Abwesenheitsberechnung)
    // Diese Funktion wird HIER nicht mehr direkt für die Soll-Stunden-Berechnung verwendet,
    // aber bleibt für Klarheit oder andere potenzielle Verwendungen erhalten.
    return dayOfWeek >= 1 && dayOfWeek <= 5; // Mo = 1, Fr = 5
}

/**
 * Berechnet für einen Mitarbeiter die Monatsdaten unter Berücksichtigung von Abwesenheiten.
 * NEUE LOGIK FÜR totalExpected: Basiert auf Standard-Arbeitstagen minus Abwesenheiten.
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
    const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name.toLowerCase()]);
    if (empResult.rows.length === 0) throw new Error("Mitarbeiter nicht gefunden.");
    const employee = empResult.rows[0];

    // Datumsbereich für den Monat (UTC)
    const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
    const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Exklusiv: Erster Tag des Folgemonats
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Arbeitszeiten holen (Ist-Stunden)
    const workResult = await db.query(
        `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
         FROM work_hours
         WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3
         ORDER BY date ASC`,
        [name.toLowerCase(), startDateStr, endDateStr] // Korrekte Filterung nach Name
    );
    const workEntries = workResult.rows;

    // Abwesenheiten holen
    const absenceResult = await db.query(
        `SELECT date, absence_type, credited_hours
         FROM absences
         WHERE employee_id = $1 AND date >= $2 AND date < $3`,
        [employee.id, startDateStr, endDateStr]
    );
    const absenceMap = new Map();
    absenceResult.rows.forEach(a => {
        const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date).split(' ')[0]; // Nur Datumsteil als Key
        absenceMap.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 });
    });
    // ----- Berechnung Ist-Stunden (totalActual) -----
    let workedHoursTotal = 0;
    workEntries.forEach(entry => {
        workedHoursTotal += parseFloat(entry.hours) || 0;
    });
    let absenceHoursTotal = 0;
    // Iteriere durch die Abwesenheiten im Map für die Summe
    for (const [dateKey, absenceInfo] of absenceMap.entries()) {
         // Stelle sicher, dass das Datum innerhalb des Monats liegt (sollte durch DB-Query der Fall sein, aber sicher ist sicher)
         if (dateKey >= startDateStr && dateKey < endDateStr) {
              absenceHoursTotal += absenceInfo.hours;
         }
    }
    const totalActual = workedHoursTotal + absenceHoursTotal;

    // ----- NEUE Berechnung Soll-Stunden (totalExpected) -----
    let totalExpected = 0;
    forEachDayBetween(startDate, endDate, (dateStr, dayOfWeek) => {
        // Ermittle die Standard-Soll-Stunden für diesen Wochentag laut Vertrag
        // Nutzt die korrigierte getExpectedHours Funktion
        const standardHoursForDay = getExpectedHours(employee, dateStr);

        if (standardHoursForDay > 0) { // Nur wenn an diesem Wochentag normalerweise gearbeitet wird
            if (absenceMap.has(dateStr)) { // Prüfe, ob für diesen Tag eine Abwesenheit gespeichert ist
                totalExpected += 0; // An Abwesenheitstagen ist Soll = 0
            } else {
                totalExpected += standardHoursForDay; // Standard-Soll addieren
            }
        } else {
             totalExpected += 0; // Kein Standard-Arbeitstag -> Soll = 0
        }
    });

    // Gesamt-Differenz für den Monat
    const totalDifference = totalActual - totalExpected;

    // Übertrag & Saldo speichern (unverändert)
    const prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
    const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
    const prevResult = await db.query(
        `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
        [employee.id, prevMonthDateStr]
    );
    const previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;
    const newCarry = previousCarry + totalDifference;
    const currentMonthDateStr = startDateStr;
    const upsertQuery = `
        INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (employee_id, year_month) DO UPDATE
        SET difference = EXCLUDED.difference, carry_over = EXCLUDED.carry_over;
    `;
    await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);

    const absenceDetails = Array.from(absenceMap.entries()).map(([date, info]) => ({ date, ...info }));

    return {
        employeeData: employee,
        employeeName: employee.name,
        month: parsedMonth,
        year: parsedYear,
        previousCarryOver: parseFloat(previousCarry.toFixed(2)),
        totalExpected: parseFloat(totalExpected.toFixed(2)),
        totalActual: parseFloat(totalActual.toFixed(2)),
        workedHours: parseFloat(workedHoursTotal.toFixed(2)),
        absenceHours: parseFloat(absenceHoursTotal.toFixed(2)),
        totalDifference: parseFloat(totalDifference.toFixed(2)),
        newCarryOver: parseFloat(newCarry.toFixed(2)),
        workEntries: workEntries,
        absenceEntries: absenceDetails
    };
}

/**
 * Berechnet für einen Mitarbeiter die Daten für ein Quartal oder Jahr.
 * NEUE LOGIK FÜR totalExpectedPeriod: Basiert auf Standard-Arbeitstagen minus Abwesenheiten.
 * @param {Object} db - DB Pool.
 * @param {string} name - Mitarbeitername.
 * @param {string|number} year - Jahr.
 * @param {'QUARTER'|'YEAR'} periodType - Zeitraumtyp.
 * @param {number} [periodValue] - Quartalsnummer (1-4).
 * @returns {Object} - Periodendaten inkl. Abwesenheitsinfos und employeeData.
 */
async function calculatePeriodData(db, name, year, periodType, periodValue) {
    const parsedYear = parseInt(year);
    if (!name || !year || isNaN(parsedYear) || !['QUARTER', 'YEAR'].includes(periodType)) {
        throw new Error("Ungültige Parameter.");
    }
    let startMonth, endMonth, periodIdentifier = '';
    if (periodType === 'QUARTER') {
        const quarter = parseInt(periodValue);
        if (isNaN(quarter) || quarter < 1 || quarter > 4) { throw new Error("Ungültiges Quartal."); }
        startMonth = (quarter - 1) * 3 + 1; endMonth = quarter * 3; periodIdentifier = `Q${quarter}`;
    } else { startMonth = 1; endMonth = 12; periodIdentifier = 'Gesamtjahr'; }

    const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name.toLowerCase()]);
    if (empResult.rows.length === 0) throw new Error("Mitarbeiter nicht gefunden.");
    const employee = empResult.rows[0];

    const periodStartDate = new Date(Date.UTC(parsedYear, startMonth - 1, 1));
    const periodEndDate = new Date(Date.UTC(parsedYear, endMonth, 1));
    const periodStartDateStr = periodStartDate.toISOString().split('T')[0];
    const periodEndDateStr = periodEndDate.toISOString().split('T')[0];

    const balanceStartDate = new Date(Date.UTC(parsedYear, startMonth - 2, 1));
    const balanceStartDateStr = balanceStartDate.toISOString().split('T')[0];
    const prevResult = await db.query(`SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`, [employee.id, balanceStartDateStr]);
    const startingBalance = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;

    const workResult = await db.query(
        `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
         FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3 ORDER BY date ASC`,
        [name.toLowerCase(), periodStartDateStr, periodEndDateStr]
    );
    const workEntriesPeriod = workResult.rows;

    const absenceResult = await db.query(
        `SELECT date, absence_type, credited_hours FROM absences WHERE employee_id = $1 AND date >= $2 AND date < $3`,
        [employee.id, periodStartDateStr, periodEndDateStr]
    );
    const absenceMapPeriod = new Map();
    absenceResult.rows.forEach(a => {
        const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date).split(' ')[0]; // Nur Datumsteil
        absenceMapPeriod.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 });
    });
    // ----- Berechnung Ist-Stunden (totalActualPeriod) -----
    let workedHoursTotalPeriod = 0;
    workEntriesPeriod.forEach(entry => { workedHoursTotalPeriod += parseFloat(entry.hours) || 0; });
    let absenceHoursTotalPeriod = 0;
    for (const [dateKey, absenceInfo] of absenceMapPeriod.entries()) {
         if (dateKey >= periodStartDateStr && dateKey < periodEndDateStr) {
             absenceHoursTotalPeriod += absenceInfo.hours;
         }
    }
    const totalActualPeriod = workedHoursTotalPeriod + absenceHoursTotalPeriod;

    // ----- NEUE Berechnung Soll-Stunden (totalExpectedPeriod) -----
    let totalExpectedPeriod = 0;
    forEachDayBetween(periodStartDate, periodEndDate, (dateStr, dayOfWeek) => {
        // Nutzt die korrigierte getExpectedHours Funktion
        const standardHoursForDay = getExpectedHours(employee, dateStr);
        if (standardHoursForDay > 0) {
            if (absenceMapPeriod.has(dateStr)) {
                totalExpectedPeriod += 0;
            } else {
                totalExpectedPeriod += standardHoursForDay;
            }
        } else {
             totalExpectedPeriod += 0;
        }
    });

    const periodDifference = totalActualPeriod - totalExpectedPeriod;
    const endingBalancePeriod = startingBalance + periodDifference;

    const absenceDetailsPeriod = Array.from(absenceMapPeriod.entries()).map(([date, info]) => ({ date, ...info }));
    return {
        employeeData: employee,
        employeeName: employee.name,
        year: parsedYear,
        periodType: periodType,
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
  getExpectedHours,        // Korrigierte Funktion
  // forEachDayBetween,    // Nur exportieren, wenn extern benötigt
  // isStandardWorkday,    // Nur exportieren, wenn extern benötigt
  calculateMonthlyData,
  calculatePeriodData
};
