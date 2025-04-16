// utils/calculationUtils.js - MIT DIAGNOSE-LOGGING

// KORRIGIERTE Funktion getExpectedHours (unverändert)
function getExpectedHours(employeeData, dateStr) {
    // console.log(`DEBUG: getExpectedHours called for date: ${dateStr}`); // Kann bei Bedarf aktiviert werden
    if (!employeeData || !dateStr) return 0;
    try {
        const dateOnly = String(dateStr).split(' ')[0];
        const d = new Date(dateOnly + 'T00:00:00Z');
        if (isNaN(d.getTime())) {
             console.warn(`Ungültiges Datum in getExpectedHours nach Bereinigung: Input='${dateStr}', Verwendet='${dateOnly}'`);
             return 0;
        }
        const day = d.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa
        switch (day) {
            case 1: return employeeData.mo_hours || 0;
            case 2: return employeeData.di_hours || 0;
            case 3: return employeeData.mi_hours || 0;
            case 4: return employeeData.do_hours || 0;
            case 5: return employeeData.fr_hours || 0;
            default: return 0; // Samstag, Sonntag
        }
    } catch (e) {
        console.error(`Fehler in getExpectedHours für Datum: ${dateStr}`, e);
        return 0;
    }
}

// forEachDayBetween (unverändert)
function forEachDayBetween(startDate, endDate, callback) {
    let current = new Date(startDate.getTime());
    const end = new Date(endDate.getTime());
    // console.log(`DEBUG: forEachDayBetween - Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`); // Debug Log
    let iterations = 0; // Schutz gegen Endlosschleifen
    while (current < end && iterations < 367) { // Sicherheitslimit
        const dateStr = current.toISOString().split('T')[0];
        const dayOfWeek = current.getUTCDay();
        // console.log(`DEBUG: forEachDayBetween - Iteration: ${dateStr}, Day: ${dayOfWeek}`); // Sehr detailreich, nur bei Bedarf
        callback(dateStr, dayOfWeek);
        current.setUTCDate(current.getUTCDate() + 1);
        iterations++;
    }
     if (iterations >= 367) {
         console.error(`FEHLER: forEachDayBetween hat Sicherheitslimit von 367 Iterationen erreicht! Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`);
     }
}

// isStandardWorkday (unverändert)
function isStandardWorkday(dayOfWeek) {
    return dayOfWeek >= 1 && dayOfWeek <= 5;
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
    // +++ LOGGING START +++
    console.log(`[LOG] calculateMonthlyData: START - MA: ${name}, Monat: ${month}/${year}`);
    const startTime = Date.now();
    // +++ LOGGING ENDE +++

    const parsedYear = parseInt(year);
    const parsedMonth = parseInt(month);
    if (!name || !year || !month || isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        console.error(`[LOG] calculateMonthlyData: ERROR - Ungültige Eingabe - MA: ${name}, Monat: ${month}/${year}`);
        throw new Error("Ungültiger Name, Jahr oder Monat angegeben.");
    }

    try {
        // Mitarbeiter-Daten abrufen
        console.log(`[LOG] calculateMonthlyData: Fetching employee data for ${name}...`);
        const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name.toLowerCase()]);
        if (empResult.rows.length === 0) {
            console.error(`[LOG] calculateMonthlyData: ERROR - Mitarbeiter ${name} nicht gefunden.`);
            throw new Error("Mitarbeiter nicht gefunden.");
        }
        const employee = empResult.rows[0];
        console.log(`[LOG] calculateMonthlyData: Employee data found for ID: ${employee.id}`);

        // Datumsbereich für den Monat (UTC)
        const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
        const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Exklusiv
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        console.log(`[LOG] calculateMonthlyData: Date range - Start: ${startDateStr}, End (exclusive): ${endDateStr}`);

        // Arbeitszeiten holen (Ist-Stunden)
        console.log(`[LOG] calculateMonthlyData: Fetching work hours...`);
        const workResult = await db.query(
            `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
             FROM work_hours
             WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3
             ORDER BY date ASC`,
            [name.toLowerCase(), startDateStr, endDateStr]
        );
        const workEntries = workResult.rows;
        console.log(`[LOG] calculateMonthlyData: ${workEntries.length} work hour entries found.`);

        // Abwesenheiten holen
        console.log(`[LOG] calculateMonthlyData: Fetching absences...`);
        const absenceResult = await db.query(
            `SELECT date, absence_type, credited_hours
             FROM absences
             WHERE employee_id = $1 AND date >= $2 AND date < $3`,
            [employee.id, startDateStr, endDateStr]
        );
        const absenceMap = new Map();
        absenceResult.rows.forEach(a => {
            const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date).split(' ')[0];
            absenceMap.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 });
        });
        console.log(`[LOG] calculateMonthlyData: ${absenceMap.size} absence entries found and mapped.`);

        // ----- Berechnung Ist-Stunden (totalActual) -----
        console.log(`[LOG] calculateMonthlyData: Calculating actual hours...`);
        let workedHoursTotal = 0;
        workEntries.forEach(entry => {
            workedHoursTotal += parseFloat(entry.hours) || 0;
        });
        let absenceHoursTotal = 0;
        for (const [dateKey, absenceInfo] of absenceMap.entries()) {
             if (dateKey >= startDateStr && dateKey < endDateStr) {
                  absenceHoursTotal += absenceInfo.hours;
             }
        }
        const totalActual = workedHoursTotal + absenceHoursTotal;
        console.log(`[LOG] calculateMonthlyData: Actual hours calculated - Worked: ${workedHoursTotal.toFixed(2)}, Absence: ${absenceHoursTotal.toFixed(2)}, Total: ${totalActual.toFixed(2)}`);

        // ----- NEUE Berechnung Soll-Stunden (totalExpected) -----
        console.log(`[LOG] calculateMonthlyData: Calculating expected hours (iterating days)...`);
        let totalExpected = 0;
        forEachDayBetween(startDate, endDate, (dateStr, dayOfWeek) => {
            // Nutzt die korrigierte getExpectedHours Funktion
            const standardHoursForDay = getExpectedHours(employee, dateStr);
            if (standardHoursForDay > 0) { // Nur Wochentage mit Soll > 0 berücksichtigen
                if (!absenceMap.has(dateStr)) { // Nur addieren, wenn KEINE Abwesenheit an diesem Tag
                    totalExpected += standardHoursForDay;
                }
                // Wenn Abwesenheit vorhanden, werden die Sollstunden für diesen Tag nicht addiert
            }
        });
        console.log(`[LOG] calculateMonthlyData: Expected hours calculated: ${totalExpected.toFixed(2)}`);

        // Gesamt-Differenz für den Monat
        const totalDifference = totalActual - totalExpected;
        console.log(`[LOG] calculateMonthlyData: Monthly difference: ${totalDifference.toFixed(2)}`);

        // Übertrag & Saldo speichern
        console.log(`[LOG] calculateMonthlyData: Fetching previous carry over...`);
        const prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
        // Wichtig: Format für year_month muss stimmen (YYYY-MM-DD)
        const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
        const prevResult = await db.query(
            `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
            [employee.id, prevMonthDateStr] // year_month ist der erste des Vormonats
        );
        const previousCarry = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;
        const newCarry = previousCarry + totalDifference;
        console.log(`[LOG] calculateMonthlyData: Carry over - Previous: ${previousCarry.toFixed(2)}, New: ${newCarry.toFixed(2)}`);

        console.log(`[LOG] calculateMonthlyData: Upserting monthly balance...`);
        const currentMonthDateStr = startDateStr; // year_month ist der erste des aktuellen Monats
        const upsertQuery = `
            INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (employee_id, year_month) DO UPDATE
            SET difference = EXCLUDED.difference, carry_over = EXCLUDED.carry_over;
        `;
        await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);
        console.log(`[LOG] calculateMonthlyData: Monthly balance upserted.`);

        const absenceDetails = Array.from(absenceMap.entries()).map(([date, info]) => ({ date, ...info }));

        // +++ LOGGING START +++
        const duration = (Date.now() - startTime) / 1000;
        console.log(`[LOG] calculateMonthlyData: END - MA: ${name}, Monat: ${month}/${year}. Duration: ${duration.toFixed(2)}s`);
        // +++ LOGGING ENDE +++

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
    } catch (error) {
        // +++ LOGGING START +++
        console.error(`[LOG] calculateMonthlyData: CRITICAL ERROR - MA: ${name}, Monat: ${month}/${year}. Error: ${error.message}`, error.stack);
        // +++ LOGGING ENDE +++
        // Werfe den Fehler weiter, damit die Route ihn behandeln kann
        throw error;
    }
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
     // +++ LOGGING START +++
    const logPrefix = `[LOG] calculatePeriodData: MA: ${name}, Year: ${year}, Type: ${periodType}, Val: ${periodValue || 'N/A'} -`;
    console.log(`${logPrefix} START`);
    const startTime = Date.now();
    // +++ LOGGING ENDE +++

    const parsedYear = parseInt(year);
    if (!name || !year || isNaN(parsedYear) || !['QUARTER', 'YEAR'].includes(periodType)) {
        console.error(`${logPrefix} ERROR - Ungültige Parameter.`);
        throw new Error("Ungültige Parameter.");
    }
    let startMonth, endMonth, periodIdentifier = '';
    if (periodType === 'QUARTER') {
        const quarter = parseInt(periodValue);
        if (isNaN(quarter) || quarter < 1 || quarter > 4) {
            console.error(`${logPrefix} ERROR - Ungültiges Quartal.`);
            throw new Error("Ungültiges Quartal.");
        }
        startMonth = (quarter - 1) * 3 + 1;
        endMonth = quarter * 3;
        periodIdentifier = `Q${quarter}`;
    } else { // YEAR
        startMonth = 1;
        endMonth = 12;
        periodIdentifier = 'Gesamtjahr';
    }
     console.log(`${logPrefix} Period defined: ${periodIdentifier}, Months ${startMonth}-${endMonth}`);

    try {
        // Mitarbeiterdaten
        console.log(`${logPrefix} Fetching employee data...`);
        const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name.toLowerCase()]);
        if (empResult.rows.length === 0) {
            console.error(`${logPrefix} ERROR - Mitarbeiter nicht gefunden.`);
            throw new Error("Mitarbeiter nicht gefunden.");
        }
        const employee = empResult.rows[0];
        console.log(`${logPrefix} Employee data found for ID: ${employee.id}`);

        // Datumsbereich Periode (UTC)
        const periodStartDate = new Date(Date.UTC(parsedYear, startMonth - 1, 1));
        const periodEndDate = new Date(Date.UTC(parsedYear, endMonth, 1)); // Exklusiv
        const periodStartDateStr = periodStartDate.toISOString().split('T')[0];
        const periodEndDateStr = periodEndDate.toISOString().split('T')[0];
        console.log(`${logPrefix} Date range - Start: ${periodStartDateStr}, End (exclusive): ${periodEndDateStr}`);

        // Startsaldo holen (Übertrag VOR dem ersten Monat der Periode)
        console.log(`${logPrefix} Fetching starting balance...`);
        const balanceStartDate = new Date(Date.UTC(parsedYear, startMonth - 2, 1)); // Erster Tag des Vormonats
        const balanceStartDateStr = balanceStartDate.toISOString().split('T')[0];
        const prevResult = await db.query(
            `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
            [employee.id, balanceStartDateStr]
        );
        const startingBalance = prevResult.rows.length > 0 ? (parseFloat(prevResult.rows[0].carry_over) || 0) : 0;
        console.log(`${logPrefix} Starting balance found: ${startingBalance.toFixed(2)}`);

        // Arbeitszeiten für Periode
        console.log(`${logPrefix} Fetching work hours for period...`);
        const workResult = await db.query(
            `SELECT id, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
             FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3 ORDER BY date ASC`,
            [name.toLowerCase(), periodStartDateStr, periodEndDateStr]
        );
        const workEntriesPeriod = workResult.rows;
        console.log(`${logPrefix} ${workEntriesPeriod.length} work hour entries found for period.`);

        // Abwesenheiten für Periode
        console.log(`${logPrefix} Fetching absences for period...`);
        const absenceResult = await db.query(
            `SELECT date, absence_type, credited_hours FROM absences WHERE employee_id = $1 AND date >= $2 AND date < $3`,
            [employee.id, periodStartDateStr, periodEndDateStr]
        );
        const absenceMapPeriod = new Map();
        absenceResult.rows.forEach(a => {
            const dateKey = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date).split(' ')[0];
            absenceMapPeriod.set(dateKey, { type: a.absence_type, hours: parseFloat(a.credited_hours) || 0 });
        });
        console.log(`${logPrefix} ${absenceMapPeriod.size} absence entries found and mapped for period.`);

        // ----- Berechnung Ist-Stunden (totalActualPeriod) -----
        console.log(`${logPrefix} Calculating actual hours for period...`);
        let workedHoursTotalPeriod = 0;
        workEntriesPeriod.forEach(entry => { workedHoursTotalPeriod += parseFloat(entry.hours) || 0; });
        let absenceHoursTotalPeriod = 0;
        for (const [dateKey, absenceInfo] of absenceMapPeriod.entries()) {
             if (dateKey >= periodStartDateStr && dateKey < periodEndDateStr) {
                 absenceHoursTotalPeriod += absenceInfo.hours;
             }
        }
        const totalActualPeriod = workedHoursTotalPeriod + absenceHoursTotalPeriod;
        console.log(`${logPrefix} Actual hours calculated - Worked: ${workedHoursTotalPeriod.toFixed(2)}, Absence: ${absenceHoursTotalPeriod.toFixed(2)}, Total: ${totalActualPeriod.toFixed(2)}`);

        // ----- NEUE Berechnung Soll-Stunden (totalExpectedPeriod) -----
        console.log(`${logPrefix} Calculating expected hours for period (iterating days)...`);
        let totalExpectedPeriod = 0;
        forEachDayBetween(periodStartDate, periodEndDate, (dateStr, dayOfWeek) => {
            const standardHoursForDay = getExpectedHours(employee, dateStr);
            if (standardHoursForDay > 0) {
                if (!absenceMapPeriod.has(dateStr)) { // Nur addieren, wenn KEINE Abwesenheit
                    totalExpectedPeriod += standardHoursForDay;
                }
            }
        });
        console.log(`${logPrefix} Expected hours calculated: ${totalExpectedPeriod.toFixed(2)}`);

        // Differenz und Endsaldo
        const periodDifference = totalActualPeriod - totalExpectedPeriod;
        const endingBalancePeriod = startingBalance + periodDifference;
        console.log(`${logPrefix} Period difference: ${periodDifference.toFixed(2)}, Ending balance: ${endingBalancePeriod.toFixed(2)}`);

        const absenceDetailsPeriod = Array.from(absenceMapPeriod.entries()).map(([date, info]) => ({ date, ...info }));

         // +++ LOGGING START +++
        const duration = (Date.now() - startTime) / 1000;
        console.log(`${logPrefix} END - Duration: ${duration.toFixed(2)}s`);
        // +++ LOGGING ENDE +++

        return {
            employeeData: employee,
            employeeName: employee.name,
            year: parsedYear,
            periodType: periodType,
            periodValue: periodType === 'QUARTER' ? parseInt(periodValue) : null,
            periodIdentifier: periodIdentifier,
            periodStartDate: periodStartDateStr,
            // Korrektur: Enddatum für Anzeige ist der letzte Tag der Periode
            periodEndDate: new Date(periodEndDate.getTime() - 86400000).toISOString().split('T')[0], // Letzter Tag
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
    } catch (error) {
         // +++ LOGGING START +++
         console.error(`${logPrefix} CRITICAL ERROR - Error: ${error.message}`, error.stack);
         // +++ LOGGING ENDE +++
         throw error; // Fehler weiterwerfen
    }
}

module.exports = {
  getExpectedHours,
  // forEachDayBetween, // Nicht exportiert, nur intern genutzt
  // isStandardWorkday, // Nicht exportiert, nur intern genutzt
  calculateMonthlyData,
  calculatePeriodData
};
