// server.js - KORRIGIERTE VERSION (Trust Proxy + Diagnose-Logging + Aufsteigende Sortierung + Verhinderung Doppelbuchung + Wochentag im CSV + Global Error Handler)

// 1. Notwendige Bibliotheken importieren
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const dotenv = require('dotenv');
const Holidays = require('date-holidays');
const { Pool } = require('pg');

dotenv.config();

// Datenbankverbindung herstellen
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { // Nur wenn nötig
  //   rejectUnauthorized: false
  // }
});

// Datenbankverbindung testen
db.connect((err, client, release) => {
  if (err) {
    console.error('!!! Kritischer Fehler beim Verbinden mit der Datenbank:', err.stack);
    process.exit(1);
  } else {
    console.log('>>> Datenbank erfolgreich verbunden.');
    release();
  }
});

// 2. Express App initialisieren
const app = express();
const port = process.env.PORT || 3000;

// Express anweisen, dem Proxy zu vertrauen
app.set('trust proxy', 1);

// 3. Globale Variablen und Hilfsfunktionen
const hd = new Holidays('DE', 'NW');
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils');
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint'); // Pfad ggf. anpassen

// Formatierungsoptionen für Datum mit Wochentag (global für CSV)
const csvDateOptions = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };

// Hilfsfunktionen (parseTime, calculateWorkHours)
function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  let diffInMin = endMinutes - startMinutes;
  if (diffInMin < 0) {
      diffInMin += 24 * 60; // Korrigiert für Mitternacht
  }
  return diffInMin / 60;
}

async function convertToCSV(database, data) {
    if (!data || data.length === 0) return '';
    const csvRows = [];
    const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std", "Differenz", "Bemerkung"];
    csvRows.push(headers.join(','));
    let employeeMap = new Map();

    try {
        const empRes = await database.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees');
        empRes.rows.forEach(emp => employeeMap.set(emp.name.toLowerCase(), emp));
    } catch(e) {
        console.error("Fehler beim Abrufen der Mitarbeiterdaten für CSV-Sollstunden:", e);
    }

    // Hinweis: Das N+1 Problem mit absenceCheck wurde hier zur Vereinfachung erstmal drin gelassen.
    // Für bessere Performance bei großen CSVs sollte dies optimiert werden (Abwesenheiten vorher sammeln).
    for (const row of data) {
        let dateFormatted = "";
        let dateForCalc = null;
        if (row.date) {
            try {
                const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
                dateForCalc = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD für Berechnungen

                // ** NEUE FORMATIERUNG FÜR CSV **
                if (!isNaN(dateObj.getTime())) {
                   dateFormatted = dateObj.toLocaleDateString('de-DE', csvDateOptions); // Format: "Mo. TT.MM.YYYY"
                } else {
                   dateFormatted = String(row.date); // Fallback
                }

            } catch (e) {
                dateFormatted = String(row.date); // Fallback bei Fehler
                console.warn("Fehler bei CSV-Datumsformatierung:", row.date, e);
                // Hier könnte der Fehler auftreten, wenn intl fehlt! Wird aber abgefangen.
            }
        }
        const startTimeFormatted = row.startTime || ""; // Kommt als HH:MI
        const endTimeFormatted = row.endTime || "";   // Kommt als HH:MI
        const istHours = parseFloat(row.hours) || 0;
        let expectedHours = 0;
        const employeeData = employeeMap.get(String(row.name).toLowerCase());
        if(employeeData && dateForCalc && typeof getExpectedHours === 'function') {
            try {
                 // Prüfen, ob an diesem Tag eine Abwesenheit eingetragen ist (ignoriert Sollstunden)
                const absenceCheck = await database.query('SELECT 1 FROM absences WHERE employee_id = $1 AND date = $2', [employeeData.id, dateForCalc]);
                if (absenceCheck.rows.length === 0) { // Nur wenn KEINE Abwesenheit
                    expectedHours = getExpectedHours(employeeData, dateForCalc);
                }
            } catch (e) { console.error(`Fehler Soll-Std CSV (MA: ${row.name}, D: ${dateForCalc}):`, e); }
        }
        const diffHours = istHours - expectedHours;
        const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`; // Korrektes Escaping für Kommentare
        const values = [
            row.id, row.name, dateFormatted, startTimeFormatted, endTimeFormatted,
            istHours.toFixed(2), expectedHours.toFixed(2), diffHours.toFixed(2), commentFormatted
        ];
        csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}
// ENDE server.js TEIL 1/4
// START server.js TEIL 2/4
// 4. Middleware konfigurieren
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*', // Sicherer machen für Produktion!
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session Middleware
app.use(session({
    store: new pgSession({
        pool: db,
        tableName: 'user_sessions'
    }),
    secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-secret-fuer-dev', // UNBEDINGT IN .env ÄNDERN!
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Wird durch 'trust proxy' korrekt behandelt
        maxAge: 1000 * 60 * 60 * 24, // 24 Stunden
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Statische Dateien ausliefern
app.use(express.static(path.join(__dirname, 'public')));

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next(); // Zugriff erlaubt
    } else {
        console.warn(`isAdmin Check FAILED für Session ID: ${req.sessionID} - isAdmin Flag: ${req.session?.isAdmin} - URL: ${req.originalUrl} von IP ${req.ip}`);
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.'); // Zugriff verweigert
    }
}

// 5. Datenbank-Setup Funktion
const setupTables = async () => {
  try {
    // Tabelle für Mitarbeiter
    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mo_hours DOUBLE PRECISION DEFAULT 0,
        di_hours DOUBLE PRECISION DEFAULT 0,
        mi_hours DOUBLE PRECISION DEFAULT 0,
        do_hours DOUBLE PRECISION DEFAULT 0,
        fr_hours DOUBLE PRECISION DEFAULT 0
      );
    `);
    console.log("Tabelle 'employees' geprüft/erstellt.");

    // Tabelle für erfasste Arbeitszeiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        date DATE NOT NULL,
        starttime TIME,
        endtime TIME,
        hours DOUBLE PRECISION,
        comment TEXT
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_work_hours_name_date ON work_hours (LOWER(name), date);`);
    console.log("Tabelle 'work_hours' und Index geprüft/erstellt.");

    // Tabelle für Monatsbilanzen
    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        year_month DATE NOT NULL,
        difference DOUBLE PRECISION,
        carry_over DOUBLE PRECISION,
        UNIQUE (employee_id, year_month)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    console.log("Tabelle 'monthly_balance' und Index geprüft/erstellt.");

    // Tabelle für Abwesenheiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS absences (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')),
        credited_hours DOUBLE PRECISION NOT NULL,
        comment TEXT,
        UNIQUE (employee_id, date)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);`);
    console.log("Tabelle 'absences' und Index geprüft/erstellt.");

    // Tabelle für Sessions prüfen
    const sessionTableCheck = await db.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_sessions');`);
    if (!sessionTableCheck.rows[0].exists) {
        console.log("Session-Tabelle 'user_sessions' wird von connect-pg-simple erstellt...");
    } else {
        console.log("Session-Tabelle 'user_sessions' existiert.");
    }

  } catch (err) {
    console.error("!!! Kritischer Datenbank Setup Fehler:", err);
    process.exit(1);
  }
};

// 6. Datenbank-Setup ausführen
setupTables()
  .then(() => { console.log('>>> Datenbank Setup erfolgreich abgeschlossen.'); })
  .catch((err) => { console.error('!!! FEHLER beim Ausführen von setupTables:', err); process.exit(1); });
// ENDE server.js TEIL 2/4
// START server.js TEIL 3/4
// ==========================================
// Öffentliche Endpunkte (kein Login nötig)
// ==========================================

// Health Check Endpoint
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Liefert Liste aller Mitarbeiter (ID und Name)
app.get('/employees', async (req, res) => { /* ... unverändert ... */ try { const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC'); res.json(result.rows); } catch (err) { console.error("DB Fehler GET /employees:", err); res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.'); } });

// Prüft den letzten Eintrag eines Mitarbeiters, um den nächsten Buchungsstatus zu bestimmen
app.get('/next-booking-details', async (req, res) => { /* ... unverändert ... */ const { name } = req.query; if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' }); try { const query = ` SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE LOWER(name) = LOWER($1) ORDER BY date DESC, starttime DESC NULLS LAST LIMIT 1;`; const result = await db.query(query, [name.toLowerCase()]); let nextBooking = 'arbeitsbeginn', entryId = null, startDate = null, startTime = null; if (result.rows.length > 0) { const lastEntry = result.rows[0]; if (lastEntry.starttime_formatted && !lastEntry.endtime) { nextBooking = 'arbeitsende'; entryId = lastEntry.id; startDate = lastEntry.date instanceof Date ? lastEntry.date.toISOString().split('T')[0] : lastEntry.date; startTime = lastEntry.starttime_formatted; } } res.json({ nextBooking, id: entryId, startDate, startTime }); } catch (err) { console.error("Fehler /next-booking-details:", err); res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' }); } });

// Bucht den Arbeitsbeginn (mit Verhinderung von Doppelbuchungen)
app.post('/log-start', async (req, res) => { /* ... unverändert ... */ const { name, date, startTime } = req.body; if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) { return res.status(400).json({ message: 'Fehlende oder ungültige Daten (Name, Datum YYYY-MM-DD, Startzeit HH:MM).' }); } try { const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]); if (empCheck.rows.length === 0) { return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` }); } const dbEmployeeName = empCheck.rows[0].name; const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`; const checkOpenResult = await db.query(checkOpenQuery, [dbEmployeeName.toLowerCase(), date]); if (checkOpenResult.rows.length > 0) { return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Arbeitsbeginn.` }); } const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`; const checkCompleteResult = await db.query(checkCompleteQuery, [dbEmployeeName.toLowerCase(), date]); if (checkCompleteResult.rows.length > 0) { console.warn(`BLOCKIERT: Mitarbeiter ${dbEmployeeName} versucht erneuten Start am ${date}, obwohl bereits abgeschlossene Buchung existiert.`); return res.status(409).json({ message: `Für diesen Tag existiert bereits eine abgeschlossene Arbeitszeitbuchung. Mehrfachbuchungen pro Tag sind nicht erlaubt.` }); } const insertQuery = `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`; const insertResult = await db.query(insertQuery, [dbEmployeeName, date, startTime]); const newEntryId = insertResult.rows[0].id; console.log(`Start gebucht: ${dbEmployeeName}, ${date}, ${startTime} (ID: ${newEntryId})`); res.status(201).json({ id: newEntryId }); } catch (err) { console.error("Fehler /log-start:", err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' }); } });

// Bucht das Arbeitsende und berechnet die Stunden
app.put('/log-end/:id', async (req, res) => { /* ... unverändert ... */ const { id } = req.params; const { endTime, comment } = req.body; if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) { return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit HH:MM).' }); } const entryId = parseInt(id); try { const entryResult = await db.query( `SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE id = $1`, [entryId] ); if (entryResult.rows.length === 0) { return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` }); } const entry = entryResult.rows[0]; if (entry.endtime) { return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` }); } if (!entry.starttime_formatted) { return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden.` }); } const netHours = calculateWorkHours(entry.starttime_formatted, endTime); if (netHours < 0) { console.warn(`Negative Arbeitszeit für ID ${entryId} (${entry.starttime_formatted} - ${endTime}) berechnet. Speichere 0.`); } const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`; await db.query(updateQuery, [endTime, comment || null, netHours >= 0 ? netHours : 0, entryId]); console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Stunden: ${netHours.toFixed(2)})`); res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) }); } catch (err) { console.error(`Fehler /log-end/${entryId}:`, err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' }); } });

// Liefert Zusammenfassung der Stunden für einen Tag und den laufenden Monat
app.get('/summary-hours', async (req, res) => { /* ... unverändert ... */ const { name, date } = req.query; if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' }); } try { const dailyResult = await db.query( `SELECT SUM(hours) AS total_daily_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL`, [name.toLowerCase(), date] ); const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0; const yearMonthDay = date.split('-'); const year = parseInt(yearMonthDay[0]); const month = parseInt(yearMonthDay[1]); const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0]; const lastDayForQuery = date; const monthlyResult = await db.query( `SELECT SUM(hours) AS total_monthly_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`, [name.toLowerCase(), firstDayOfMonth, lastDayForQuery] ); const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0; res.json({ dailyHours, monthlyHours }); } catch (err) { console.error(`Fehler /summary-hours (${name}, ${date}):`, err); res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' }); } });

// ==========================================
// Admin Endpunkte (Login erforderlich via isAdmin Middleware)
// ==========================================

// Admin-Login
app.post("/admin-login", (req, res) => { /* ... unverändert ... */ const { password } = req.body; const adminPassword = process.env.ADMIN_PASSWORD; if (!adminPassword) { console.error("!!! ADMIN_PASSWORD ist nicht gesetzt!"); return res.status(500).send("Serverkonfigurationsfehler."); } if (!password) { return res.status(400).send("Passwort fehlt."); } if (password === adminPassword) { req.session.regenerate((errReg) => { if (errReg) { console.error("Fehler beim Regenerieren der Session:", errReg); return res.status(500).send("Session Fehler."); } req.session.isAdmin = true; req.session.save((errSave) => { if (errSave) { console.error("Fehler beim Speichern der Session:", errSave); return res.status(500).send("Session Speicherfehler."); } console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`); res.status(200).send("Admin erfolgreich angemeldet."); }); }); } else { console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`); res.status(401).send("Ungültiges Passwort."); } });

// Admin-Logout
app.post("/admin-logout", isAdmin, (req, res) => { /* ... unverändert ... */ if (req.session) { const sessionId = req.sessionID; req.session.destroy(err => { if (err) { console.error("Fehler beim Zerstören der Session:", err); return res.status(500).send("Fehler beim Logout."); } res.clearCookie('connect.sid'); console.log(`Admin abgemeldet (Session ID: ${sessionId}).`); return res.status(200).send("Erfolgreich abgemeldet."); }); } else { return res.status(200).send("Keine aktive Session zum Abmelden gefunden."); } });

// Arbeitszeiten für Admin anzeigen (mit Filterung, aufsteigend sortiert)
app.get('/admin-work-hours', isAdmin, async (req, res, next) => { // <<< next hinzugefügt für Error Handling
    const { employeeId, year, month } = req.query;
    const logPrefix = `[ROUTE:/admin-work-hours] EmpID: ${employeeId}, M: ${month}/${year}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    try { // <<< Komplette Route in try...catch
        let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
        const whereClauses = [];
        const queryParams = [];
        let paramIndex = 1;

        if (employeeId && employeeId !== 'all' && employeeId !== '') {
            const empIdInt = parseInt(employeeId);
            if (isNaN(empIdInt)) {
                 console.error(`${logPrefix} ERROR - Invalid employeeId.`);
                 return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});
            }
            whereClauses.push(`e.id = $${paramIndex++}`);
            queryParams.push(empIdInt);
        }
        if (year && month) {
            // ... (Datumsparameter hinzufügen wie zuvor) ...
            const parsedYear = parseInt(year); const parsedMonth = parseInt(month); if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) { console.error(`${logPrefix} ERROR - Invalid year/month.`); return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' }); } try { const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt'); const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0]; whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr); whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr); } catch(dateError) { console.error(`${logPrefix} ERROR - Date processing error:`, dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); }
        }

        let finalQuery = baseQuery;
        if (whereClauses.length > 0) { finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; }
        finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS FIRST;`;

        console.log(`${logPrefix} Executing query: ${finalQuery.substring(0, 200)}... Params: ${queryParams}`);
        const result = await db.query(finalQuery, queryParams); // DB Fehler wird von catch aufgefangen
        console.log(`${logPrefix} Query successful, ${result.rows.length} rows found.`);
        const formattedRows = result.rows.map(row => ({ ...row, date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date }));
        res.json(formattedRows); // Erfolg

    } catch (err) {
        // Fehler an den globalen Error Handler weitergeben
        console.error(`${logPrefix} ERROR - DB or processing error: ${err.message}`); // Loggen für Kontext
        next(err); // <<< Fehler weitergeben
    }
});
// ENDE server.js TEIL 3/4
// START server.js TEIL 4/4
// CSV-Download für Admin (berücksichtigt Filter, sortiert aufsteigend)
app.get('/admin-download-csv', isAdmin, async (req, res, next) => { // <<< next hinzugefügt
    const logPrefix = `[ROUTE:/admin-download-csv] Query: ${JSON.stringify(req.query)}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    try { // <<< Komplette Route in try...catch
        const { employeeId, year, month } = req.query;
        let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
        const whereClauses = [];
        const queryParams = [];
        let paramIndex = 1;
        let filterDesc = "";

        if (employeeId && employeeId !== 'all' && employeeId !== '') {
             // ... (Parameter hinzufügen wie zuvor) ...
             const empIdInt = parseInt(employeeId); if (isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'}); } whereClauses.push(`e.id = $${paramIndex++}`); queryParams.push(empIdInt); try { const nameRes = await db.query('SELECT name FROM employees WHERE id = $1', [empIdInt]); if(nameRes.rows.length > 0) filterDesc = nameRes.rows[0].name.replace(/[^a-z0-9]/gi, '_'); } catch {}
        } else { filterDesc = "alle_MA"; }

        if (year && month) {
            // ... (Datumsparameter hinzufügen wie zuvor) ...
            const parsedYear = parseInt(year); const parsedMonth = parseInt(month); if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) { console.error(`${logPrefix} ERROR - Invalid year/month.`); return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' }); } try { const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt'); const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0]; whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr); whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr); filterDesc += `_${year}_${String(parsedMonth).padStart(2,'0')}`; } catch(dateError) { console.error(`${logPrefix} ERROR - Date processing error:`, dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); }
        } else { filterDesc += "_alle_Zeiten"; }

        let finalQuery = baseQuery;
        if (whereClauses.length > 0) finalQuery += ` WHERE ${whereClauses.join(' AND ')}`;
        finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS FIRST;`;

        console.log(`${logPrefix} Executing query for CSV: ${finalQuery.substring(0, 200)}... Params: ${queryParams}`);
        const result = await db.query(finalQuery, queryParams);
        console.log(`${logPrefix} Query successful, ${result.rows.length} rows found. Generating CSV...`);

        // WICHTIG: Fehler in convertToCSV müssen hier abgefangen werden!
        const csvData = await convertToCSV(db, result.rows); // Fehler hier wird von catch aufgefangen

        const filename = `arbeitszeiten_${filterDesc}_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')])); // BOM für Excel
        console.log(`${logPrefix} CSV sent successfully.`);

    } catch (err) {
        // Fehler an den globalen Error Handler weitergeben
        console.error(`${logPrefix} ERROR - DB or CSV generation error: ${err.message}`); // Loggen
        next(err); // <<< Fehler weitergeben
    }
});

// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res, next) => { // <<< next hinzugefügt
    const logPrefix = `[ROUTE:/api/admin/update-hours] ID: ${req.body?.id}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`);
    try { // <<< Komplette Route in try...catch
        const { id, date, startTime, endTime, comment } = req.body;
        const entryId = parseInt(id);
        if (isNaN(entryId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).json({ message: 'Ungültige ID.' }); }
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`${logPrefix} ERROR - Invalid Date.`); return res.status(400).json({ message: 'Ungültiges Datum.' }); }
        if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) { console.error(`${logPrefix} ERROR - Invalid startTime.`); return res.status(400).json({ message: 'Ungültige Startzeit.' }); }
        if (!endTime || !/^\d{2}:\d{2}$/.test(endTime)) { console.error(`${logPrefix} ERROR - Invalid endTime.`); return res.status(400).json({ message: 'Ungültige Endzeit.' }); }

        const netHours = calculateWorkHours(startTime, endTime);
        if (netHours < 0) console.warn(`${logPrefix} Negative work hours calculated. Saving 0.`);

        console.log(`${logPrefix} Checking if entry exists...`);
        const checkResult = await db.query('SELECT 1 FROM work_hours WHERE id = $1', [entryId]);
        if (checkResult.rows.length === 0) { console.warn(`${logPrefix} Entry not found.`); return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` });}

        console.log(`${logPrefix} Updating entry in DB...`);
        const query = `UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6;`;
        const result = await db.query(query, [date, startTime, endTime, netHours >= 0 ? netHours : 0, comment || null, entryId]);

        if (result.rowCount > 0) {
            console.log(`${logPrefix} Update successful.`);
            res.status(200).send('Eintrag aktualisiert.');
        } else {
            console.warn(`${logPrefix} Update failed (rowCount=0).`);
            res.status(404).send(`Eintrag ID ${entryId} nicht aktualisiert.`); // Eigentlich unwahrscheinlich nach Check
        }
    } catch (err) {
        console.error(`${logPrefix} ERROR - DB or processing error: ${err.message}`);
        next(err); // <<< Fehler weitergeben
    }
});

// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res, next) => { // <<< next hinzugefügt
    const logPrefix = `[ROUTE:/api/admin/delete-hours] ID: ${req.params?.id}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    try { // <<< Komplette Route in try...catch
        const { id } = req.params;
        const entryId = parseInt(id);
        if (isNaN(entryId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.'); }

        console.log(`${logPrefix} Deleting entry from DB...`);
        const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]);
        if (result.rowCount > 0) {
            console.log(`${logPrefix} Delete successful.`);
            res.status(200).send('Eintrag gelöscht.');
        } else {
            console.warn(`${logPrefix} Entry not found.`);
            res.status(404).send(`Eintrag ID ${entryId} nicht gefunden.`);
        }
    } catch (err) {
        console.error(`${logPrefix} ERROR - DB Error: ${err.message}`);
        next(err); // <<< Fehler weitergeben
    }
});

// Admin: Alle Daten löschen (Arbeitszeiten, Bilanzen, Abwesenheiten)
app.delete('/adminDeleteData', isAdmin, async (req, res, next) => { // <<< next hinzugefügt
    /* ... unverändert ... */
    const logPrefix = `[ROUTE:/adminDeleteData] Session: ${req.sessionID} -`; console.warn(`${logPrefix} !!! DELETE ALL DATA REQUEST RECEIVED !!!`); let client; try { client = await db.connect(); await client.query('BEGIN'); console.warn(`${logPrefix} Deleting monthly_balance...`); const resultMB = await client.query('DELETE FROM monthly_balance'); console.warn(`${logPrefix} -> ${resultMB.rowCount} rows deleted.`); console.warn(`${logPrefix} Deleting absences...`); const resultAbs = await client.query('DELETE FROM absences'); console.warn(`${logPrefix} -> ${resultAbs.rowCount} rows deleted.`); console.warn(`${logPrefix} Deleting work_hours...`); const resultWH = await client.query('DELETE FROM work_hours'); console.warn(`${logPrefix} -> ${resultWH.rowCount} rows deleted.`); await client.query('COMMIT'); console.warn(`${logPrefix} !!! ALL DATA DELETED SUCCESSFULLY !!!`); res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiten, ${resultMB.rowCount} Bilanzen und ${resultAbs.rowCount} Abwesenheiten wurden gelöscht.`); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} !!! CRITICAL DB ERROR DURING DELETE ALL: ${err.message}`, err.stack); next(err); } finally { if (client) client.release(); }
});

// --- Mitarbeiterverwaltung ---
app.get('/admin/employees', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const logPrefix = `[ROUTE:/admin/employees GET] Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); console.log(`${logPrefix} Querying employees...`); const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC'); console.log(`${logPrefix} Query successful, found ${result.rows.length} employees.`); res.json(result.rows); } catch (err) { console.error(`[ROUTE:/admin/employees GET] ERROR - DB Error: ${err.message}`, err.stack); next(err); } });
app.post('/admin/employees', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const logPrefix = `[ROUTE:/admin/employees POST] Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`); const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body; const trimmedName = name ? name.trim() : ''; if (!trimmedName) { console.error(`${logPrefix} ERROR - Empty name.`); return res.status(400).send('Name darf nicht leer sein.'); } const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0); if (hours.some(h => h < 0)) { console.error(`${logPrefix} ERROR - Negative hours.`); return res.status(400).send('Stunden dürfen nicht negativ sein.');} console.log(`${logPrefix} Inserting new employee '${trimmedName}'...`); const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`; const result = await db.query(query, [trimmedName, ...hours]); console.log(`${logPrefix} Insert successful. ID: ${result.rows[0].id}`); res.status(201).json(result.rows[0]); } catch (err) { const logPrefix = `[ROUTE:/admin/employees POST] Session: ${req.sessionID} -`; if (err.code === '23505') { console.warn(`${logPrefix} Conflict - Employee name '${req.body.name}' already exists.`); res.status(409).send(`Mitarbeiter '${req.body.name}' existiert bereits.`); } else { console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); next(err); } } });
app.put('/admin/employees/:id', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch mit Transaction, next(err) */ let client; const logPrefix = `[ROUTE:/admin/employees PUT] ID: ${req.params?.id}, Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { id } = req.params; const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body; const employeeId = parseInt(id); const trimmedName = name ? name.trim() : ''; if (isNaN(employeeId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); await client.query('ROLLBACK'); return res.status(400).send('Ungültige ID.'); } if (!trimmedName) { console.error(`${logPrefix} ERROR - Empty name.`); await client.query('ROLLBACK'); return res.status(400).send('Name darf nicht leer sein.'); } const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0); if (hours.some(h => h < 0)) { console.error(`${logPrefix} ERROR - Negative hours.`); await client.query('ROLLBACK'); return res.status(400).send('Stunden dürfen nicht negativ sein.');} const oldNameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]); if (oldNameResult.rows.length === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee not found.`); return res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); } const oldName = oldNameResult.rows[0].name; const newName = trimmedName; console.log(`${logPrefix} Updating employee table... Old: ${oldName}, New: ${newName}`); const updateEmpQuery = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`; await client.query(updateEmpQuery, [newName, ...hours, employeeId]); if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) { console.log(`${logPrefix} Name changed, updating work_hours...`); const workHoursUpdateResult = await client.query(`UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`, [newName, oldName.toLowerCase()]); console.log(`${logPrefix} -> ${workHoursUpdateResult.rowCount} work_hours rows updated.`); } await client.query('COMMIT'); console.log(`${logPrefix} Transaction committed successfully.`); res.status(200).send('Mitarbeiterdaten aktualisiert.'); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR during transaction. Rolled back. Error: ${err.message}`, err.stack); if (err.code === '23505') { res.status(409).send(`Name '${req.body.name}' existiert bereits.`); } else { next(err); } } finally { if (client) client.release(); } });
app.delete('/admin/employees/:id', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch mit Transaction, next(err) */ let client; const logPrefix = `[ROUTE:/admin/employees DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { id } = req.params; const employeeId = parseInt(id); if (isNaN(employeeId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); await client.query('ROLLBACK'); return res.status(400).send('Ungültige ID.');} const nameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]); if (nameResult.rows.length === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee not found.`); return res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); } const employeeName = nameResult.rows[0].name; console.warn(`${logPrefix} Deleting work_hours for ${employeeName}...`); const workHoursDeleteResult = await client.query('DELETE FROM work_hours WHERE LOWER(name) = LOWER($1)', [employeeName.toLowerCase()]); console.warn(`${logPrefix} -> ${workHoursDeleteResult.rowCount} work_hours rows deleted.`); console.warn(`${logPrefix} Deleting employee ${employeeName} (ID: ${employeeId}) from employees table (cascades to absences, monthly_balance)...`); const deleteEmpResult = await client.query('DELETE FROM employees WHERE id = $1', [employeeId]); if (deleteEmpResult.rowCount > 0) { await client.query('COMMIT'); console.warn(`${logPrefix} !!! Employee and related data deleted successfully. Transaction committed. !!!`); res.status(200).send('Mitarbeiter und Daten gelöscht.'); } else { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee delete failed (rowCount=0). Rolled back.`); res.status(404).send(`MA ID ${employeeId} nicht gelöscht (nicht gefunden?).`); } } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} !!! CRITICAL ERROR during employee delete. Rolled back. Error: ${err.message}`, err.stack); if (err.code === '23503') { res.status(409).send('FK Fehler: Abhängige Daten existieren (sollte nicht passieren mit CASCADE).'); } else { next(err); } } finally { if (client) client.release(); } });

// --- Auswertungen ---
app.get('/calculate-monthly-balance', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const { name, year, month } = req.query; const logPrefix = `[ROUTE:/calculate-monthly-balance] MA: ${name}, Date: ${month}/${year}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); if (!name || !year || !month || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4 || isNaN(parseInt(month)) || month < 1 || month > 12) { console.error(`${logPrefix} ERROR - Invalid input.`); return res.status(400).json({ message: "Ungültige Eingabe: Name, Jahr (YYYY) und Monat (1-12) erforderlich." }); } console.log(`${logPrefix} Calling calculateMonthlyData...`); const result = await calculateMonthlyData(db, name, year, month); console.log(`${logPrefix} calculateMonthlyData successful. Sending response.`); res.json(result); } catch (err) { const logPrefix = `[ROUTE:/calculate-monthly-balance] MA: ${req.query.name}, Date: ${req.query.month}/${req.query.year}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`); if (err.message && err.message.toLowerCase().includes("nicht gefunden")) { res.status(404).json({ message: err.message }); } else { next(err); } } });
app.get('/calculate-period-balance', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const { name, year, periodType, periodValue } = req.query; const logPrefix = `[ROUTE:/calculate-period-balance] MA: ${name}, Year: ${year}, Type: ${periodType}, Val: ${periodValue}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); if (!name || !year || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4) { console.error(`${logPrefix} ERROR - Invalid name or year.`); return res.status(400).json({ message: "Ungültige Eingabe: Name und Jahr (YYYY) erforderlich." }); } const periodTypeUpper = periodType ? periodType.toUpperCase() : null; if (!periodTypeUpper || !['QUARTER', 'YEAR'].includes(periodTypeUpper)) { console.error(`${logPrefix} ERROR - Invalid periodType.`); return res.status(400).json({ message: "Ungültiger Periodentyp. Erlaubt sind 'QUARTER' oder 'YEAR'." }); } let parsedPeriodValue = null; if (periodTypeUpper === 'QUARTER') { parsedPeriodValue = parseInt(periodValue); if (!periodValue || isNaN(parsedPeriodValue) || parsedPeriodValue < 1 || parsedPeriodValue > 4) { console.error(`${logPrefix} ERROR - Invalid periodValue for QUARTER.`); return res.status(400).json({ message: "Ungültiges Quartal (1-4) für Periodentyp 'QUARTER' erforderlich." }); } } console.log(`${logPrefix} Calling calculatePeriodData...`); const result = await calculatePeriodData(db, name, year, periodTypeUpper, parsedPeriodValue); console.log(`${logPrefix} calculatePeriodData successful. Sending response.`); res.json(result); } catch (err) { const logPrefix = `[ROUTE:/calculate-period-balance] MA: ${req.query.name}, Year: ${req.query.year}, Type: ${req.query.periodType}, Val: ${req.query.periodValue}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`); if (err.message && err.message.toLowerCase().includes("nicht gefunden")) { res.status(404).json({ message: err.message }); } else { next(err); } } });

// --- Abwesenheiten ---
app.get('/admin/absences', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const { employeeId } = req.query; const empIdInt = parseInt(employeeId); const logPrefix = `[ROUTE:/admin/absences] EmpID: ${employeeId}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); if (!employeeId || isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Gültige numerische employeeId als Query-Parameter erforderlich.' }); } console.log(`${logPrefix} Querying absences from DB...`); const query = `SELECT id, date, absence_type, credited_hours, comment FROM absences WHERE employee_id = $1 ORDER BY date ASC`; const result = await db.query(query, [empIdInt]); console.log(`${logPrefix} DB query successful, found ${result.rows.length} entries. Formatting and sending response.`); const formattedResult = result.rows.map(row => ({ ...row, date: (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date) })); res.json(formattedResult); } catch (err) { const logPrefix = `[ROUTE:/admin/absences] EmpID: ${req.query.employeeId}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`, err.stack); next(err); } });
app.post('/admin/absences', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch mit Transaction, next(err) */ let client; const logPrefix = `[ROUTE:/admin/absences POST] Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { employeeId, date, absenceType, comment } = req.body; const empIdInt = parseInt(employeeId); if (!employeeId || isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); await client.query('ROLLBACK'); return res.status(400).json({ message: 'Gültige numerische employeeId erforderlich.' }); } if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`${logPrefix} ERROR - Invalid date.`); await client.query('ROLLBACK'); return res.status(400).json({ message: 'Gültiges Datum im Format YYYY-MM-DD erforderlich.' }); } if (!absenceType || !['VACATION', 'SICK', 'PUBLIC_HOLIDAY'].includes(absenceType.toUpperCase())) { console.error(`${logPrefix} ERROR - Invalid absenceType.`); await client.query('ROLLBACK'); return res.status(400).json({ message: "Ungültiger absenceType. Erlaubt: 'VACATION', 'SICK', 'PUBLIC_HOLIDAY'." }); } const normalizedAbsenceType = absenceType.toUpperCase(); const targetDate = new Date(date + 'T00:00:00Z'); const dayOfWeek = targetDate.getUTCDay(); if (dayOfWeek === 0 || dayOfWeek === 6) { const fd = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'}); console.warn(`${logPrefix} Attempt to book absence on weekend (${fd}).`); await client.query('ROLLBACK'); return res.status(400).json({ message: `Abwesenheiten können nicht am Wochenende (${fd}) gebucht werden.` }); } if (normalizedAbsenceType === 'PUBLIC_HOLIDAY') { const isHoliday = hd.isHoliday(targetDate); if (!isHoliday || isHoliday.type !== 'public') { const fd = targetDate.toLocaleDateString('de-DE',{timeZone:'UTC'}); console.warn(`${logPrefix} Attempt to book non-public-holiday ${fd} as PUBLIC_HOLIDAY for MA ${empIdInt}. Actual type: ${isHoliday?.type || 'none'}`); await client.query('ROLLBACK'); return res.status(400).json({ message: `Das Datum ${fd} ist laut System kein gesetzlicher Feiertag in NRW.` }); } } console.log(`${logPrefix} Fetching employee data for ID ${empIdInt}...`); const empResult = await client.query('SELECT * FROM employees WHERE id = $1', [empIdInt]); if (empResult.rows.length === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee not found.`); return res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden.` }); } const employeeData = empResult.rows[0]; console.log(`${logPrefix} Calculating expected hours for ${date}...`); const expectedHoursForDay = getExpectedHours(employeeData, date); let credited_hours = expectedHoursForDay; if (normalizedAbsenceType !== 'PUBLIC_HOLIDAY' && expectedHoursForDay <= 0) { const fd = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'}); await client.query('ROLLBACK'); console.warn(`${logPrefix} Cannot book absence, employee has 0 expected hours on ${fd}.`); return res.status(400).json({ message: `Buchung nicht möglich: Mitarbeiter ${employeeData.name} hat an diesem Tag (${fd}) keine Soll-Stunden.` }); } credited_hours = Math.max(0, credited_hours); console.log(`${logPrefix} Inserting absence (Type: ${normalizedAbsenceType}, Credited: ${credited_hours})...`); const insertQuery = `INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id, date, absence_type, credited_hours, comment;`; const insertResult = await client.query(insertQuery, [empIdInt, date, normalizedAbsenceType, credited_hours, comment || null]); await client.query('COMMIT'); console.log(`${logPrefix} Transaction committed. Absence ID: ${insertResult.rows[0].id}`); const createdAbsence = { ...insertResult.rows[0], date: insertResult.rows[0].date.toISOString().split('T')[0], credited_hours: parseFloat(insertResult.rows[0].credited_hours) || 0 }; res.status(201).json(createdAbsence); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR during transaction. Rolled back. Error: ${err.message}`, err.stack); if (err.code === '23505') { const fd = new Date(req.body.date+'T00:00:00Z').toLocaleDateString('de-DE',{timeZone:'UTC'}); res.status(409).json({ message: `Für diesen Mitarbeiter existiert bereits ein Abwesenheitseintrag am ${fd}.` }); } else if (err.code === '23503') { res.status(404).json({ message: `Mitarbeiter mit ID ${req.body.employeeId} nicht gefunden (FK Fehler).`}); } else { next(err); } } finally { if (client) client.release(); } });
app.delete('/admin/absences/:id', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const logPrefix = `[ROUTE:/admin/absences DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); const { id } = req.params; const absenceId = parseInt(id); if (isNaN(absenceId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige Abwesenheits-ID.');} console.log(`${logPrefix} Deleting absence from DB...`); const result = await db.query('DELETE FROM absences WHERE id = $1', [absenceId]); if (result.rowCount > 0) { console.log(`${logPrefix} Delete successful.`); res.status(200).send('Abwesenheitseintrag erfolgreich gelöscht.'); } else { console.warn(`${logPrefix} Absence not found.`); res.status(404).send(`Abwesenheitseintrag mit ID ${absenceId} nicht gefunden.`); } } catch (err) { const logPrefix = `[ROUTE:/admin/absences DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); next(err); } });
app.post('/admin/generate-holidays', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch mit Transaction, next(err) */ let client; const logPrefix = `[ROUTE:/admin/generate-holidays POST] Year: ${req.body?.year}, Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { year } = req.body; const currentYear = new Date().getFullYear(); const minYear = currentYear - 5; const maxYear = currentYear + 5; const targetYear = parseInt(year); if (!year || isNaN(targetYear) || targetYear < minYear || targetYear > maxYear) { console.error(`${logPrefix} ERROR - Invalid year.`); await client.query('ROLLBACK'); return res.status(400).json({ message: `Ungültiges oder fehlendes Jahr. Bitte ein Jahr zwischen ${minYear} und ${maxYear} angeben.` }); } console.log(`${logPrefix} Starting holiday generation for NRW, year ${targetYear}...`); let generatedCount = 0; let skippedCount = 0; let processedEmployees = 0; console.log(`${logPrefix} Fetching employees...`); const empResult = await client.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name'); const employees = empResult.rows; processedEmployees = employees.length; if (processedEmployees === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} No employees found. Aborting generation.`); return res.status(404).json({ message: "Keine Mitarbeiter gefunden, für die Feiertage generiert werden könnten." }); } console.log(`${logPrefix} -> ${processedEmployees} employees found.`); console.log(`${logPrefix} Fetching public holidays for ${targetYear}...`); const holidaysOfYear = hd.getHolidays(targetYear); const publicHolidays = holidaysOfYear.filter(h => h.type === 'public'); console.log(`${logPrefix} -> ${publicHolidays.length} public holidays found.`); const insertQuery = `INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, 'PUBLIC_HOLIDAY', $3, $4) ON CONFLICT (employee_id, date) DO NOTHING;`; for (const holiday of publicHolidays) { const holidayDateString = holiday.date.split(' ')[0]; const holidayDate = new Date(holidayDateString + 'T00:00:00Z'); const dayOfWeek = holidayDate.getUTCDay(); if (dayOfWeek === 0 || dayOfWeek === 6) { continue; } for (const employee of employees) { const expectedHours = getExpectedHours(employee, holidayDateString); if (expectedHours > 0) { const result = await client.query(insertQuery, [ employee.id, holidayDateString, expectedHours, holiday.name ]); if (result.rowCount > 0) { generatedCount++; } else { skippedCount++; } } } } await client.query('COMMIT'); console.log(`${logPrefix} Transaction committed. Generated: ${generatedCount}, Skipped: ${skippedCount}.`); res.status(200).json({ message: `Feiertage für ${targetYear} erfolgreich generiert/geprüft.`, generated: generatedCount, skipped: skippedCount, employees: processedEmployees }); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} !!! CRITICAL ERROR during holiday generation. Rolled back. Error: ${err.message}`, err.stack); next(err); } finally { if (client) client.release(); } });
app.delete('/admin/delete-public-holidays', isAdmin, async (req, res, next) => { /* ... wie oben: in try/catch, next(err) */ try { const logPrefix = `[ROUTE:/admin/delete-public-holidays DELETE] Session: ${req.sessionID} -`; console.warn(`${logPrefix} !!! DELETE ALL PUBLIC HOLIDAY ENTRIES REQUEST RECEIVED !!!`); console.log(`${logPrefix} Deleting all entries with absence_type = 'PUBLIC_HOLIDAY' from DB...`); const result = await db.query(`DELETE FROM absences WHERE absence_type = 'PUBLIC_HOLIDAY'`); console.warn(`${logPrefix} Delete successful. ${result.rowCount} 'PUBLIC_HOLIDAY' entries deleted.`); res.status(200).json({ message: `Erfolgreich ${result.rowCount} Abwesenheitseinträge vom Typ 'Feiertag' gelöscht.` }); } catch (err) { const logPrefix = `[ROUTE:/admin/delete-public-holidays DELETE] Session: ${req.sessionID} -`; console.error(`${logPrefix} !!! CRITICAL ERROR during public holiday delete. Error: ${err.message}`, err.stack); next(err); } });

// --- PDF Router ---
try {
    app.use('/api/pdf', monthlyPdfRouter(db)); // Übergibt die initialisierte DB-Instanz
} catch(routerError) {
    console.error("!!! Fehler beim Einbinden des PDF-Routers:", routerError);
    // Optional: Prozess beenden oder Fallback implementieren
}

// --- Global Error Handler (NEU!) ---
// Dieser Handler fängt alle Fehler ab, die in den Routen mit next(err) weitergegeben werden
// oder die von Express selbst nicht behandelt werden (z.B. Fehler in Middleware nach Routen).
app.use((err, req, res, next) => {
    // Logge den vollständigen Fehler auf dem Server (SEHR WICHTIG!)
    console.error("!!! UNHANDLED ERROR Caught by Global Handler !!!");
    console.error(`Route: ${req.method} ${req.originalUrl}`);
    // Sicherstellen, dass 'err' ein Objekt ist und einen Stack hat, sonst nur die Fehlermeldung loggen
    if (err instanceof Error) {
        console.error("Error Stack:", err.stack);
    } else {
        console.error("Error:", err);
    }

    // Sende eine generische Fehlermeldung an den Client
    // In Produktion sollten keine Stack-Traces oder detaillierte Fehlermeldungen gesendet werden
    if (!res.headersSent) {
         res.status(500).send('Ein unerwarteter interner Serverfehler ist aufgetreten.');
    } else {
         // Wenn Header schon gesendet wurden, kann man nur die Verbindung schließen
         next(err); // Übergibt an den Standard-Express-Handler (schließt i.d.R. die Verbindung)
    }
});
// --- ENDE Global Error Handler ---


// --- Server Start ---
app.listen(port, () => { /* ... unverändert ... */ console.log(`=======================================================`); console.log(` Server läuft auf Port ${port}`); console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`); console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (Passwort fehlt!)'}`); if(db && typeof db.options === 'object') { console.log(` Datenbank verbunden (Pool erstellt): Host=${process.env.PGHOST || db.options.host || '??'}, Port=${process.env.PGPORT || db.options.port || '??'}, DB=${process.env.PGDATABASE || db.options.database || '??'}`); } else if (db) { console.warn("!!! DB Pool Objekt 'db' existiert, aber Status unklar."); } else { console.error("!!! KRITISCH: DB Pool ('db') konnte nicht initialisiert werden!"); } console.log(` Feiertagsmodul: DE / NW`); console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`); console.log(` Frontend aus: '${path.join(__dirname, 'public')}'`); console.log(` Trust Proxy Setting: ${app.get('trust proxy')}`); console.log(` Session Cookie Settings: secure=${process.env.NODE_ENV === 'production'}, sameSite='${app.get('session')?.cookie?.sameSite || 'lax (Standard?)'}'`); console.log(`=======================================================`); });
// ENDE server.js TEIL 4/4
