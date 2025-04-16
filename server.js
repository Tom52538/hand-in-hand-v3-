// server.js - KORRIGIERTE VERSION (Trust Proxy)

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

// NEU: Datenbankverbindung herstellen
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

// *** KORREKTUR START ***
// NEU: Express anweisen, dem Proxy zu vertrauen (WICHTIG für Secure Cookies auf Railway/Heroku etc.)
// '1' bedeutet, dem ersten Proxy-Hop wird vertraut.
app.set('trust proxy', 1);
// *** KORREKTUR ENDE ***

// 3. Globale Variablen und Hilfsfunktionen
const hd = new Holidays('DE', 'NW');
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils');
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint'); // Pfad ggf. anpassen

// Hilfsfunktionen (parseTime, calculateWorkHours, convertToCSV)
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
      diffInMin += 24 * 60;
      // console.log(`Arbeitszeit über Mitternacht erkannt (${startTime} - ${endTime}).`); // Weniger verbose Log
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

    for (const row of data) {
        let dateFormatted = "";
        let dateForCalc = null;
        if (row.date) {
        try {
            const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
            dateForCalc = dateObj.toISOString().split('T')[0];
            const year = dateObj.getUTCFullYear();
            const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getUTCDate()).padStart(2, '0');
            dateFormatted = `${day}.${month}.${year}`;
        } catch (e) { dateFormatted = String(row.date); }
        }
        const startTimeFormatted = row.startTime || "";
        const endTimeFormatted = row.endTime || "";
        const istHours = parseFloat(row.hours) || 0;
        let expectedHours = 0;
        const employeeData = employeeMap.get(String(row.name).toLowerCase());
        if(employeeData && dateForCalc && typeof getExpectedHours === 'function') {
            try {
                const absenceCheck = await database.query('SELECT 1 FROM absences WHERE employee_id = $1 AND date = $2', [employeeData.id, dateForCalc]);
                if (absenceCheck.rows.length === 0) {
                    expectedHours = getExpectedHours(employeeData, dateForCalc);
                }
            } catch (e) { console.error(`Fehler Soll-Std CSV (MA: ${row.name}, D: ${dateForCalc}):`, e); }
        }
        const diffHours = istHours - expectedHours;
        const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
        const values = [ row.id, row.name, dateFormatted, startTimeFormatted, endTimeFormatted, istHours.toFixed(2), expectedHours.toFixed(2), diffHours.toFixed(2), commentFormatted ];
        csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}
// server.js - KORRIGIERTE VERSION (Trust Proxy) - Teil 2

// 4. Middleware konfigurieren
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*', // Sicherer machen für Produktion! z.B. URL deines Frontends
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
        httpOnly: true, // Verhindert Zugriff via JS im Browser (Sicherheit+)
        // *** KORREKTUR START ***
        sameSite: 'lax' // Explizit setzen ('lax' ist guter Standard, verhindert Senden bei Cross-Site-Navigation)
                       // 'strict' wäre noch sicherer, könnte aber bei manchen OAuth-Flows etc. stören
                       // 'none' nur nötig bei komplexen cross-domain iframes etc. und erfordert secure: true
        // *** KORREKTUR ENDE ***
    }
}));

// Statische Dateien ausliefern
app.use(express.static(path.join(__dirname, 'public')));

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
    // Prüfe ob die Session existiert UND ob isAdmin gesetzt ist
    if (req.session && req.session.isAdmin === true) {
        // console.log(`isAdmin Check OK für Session ID: ${req.sessionID}`); // Debug Log (kann später entfernt werden)
        next(); // Zugriff erlaubt
    } else {
        console.warn(`isAdmin Check FAILED für Session ID: ${req.sessionID} - isAdmin Flag: ${req.session?.isAdmin} - URL: ${req.originalUrl} von IP ${req.ip}`);
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.'); // Zugriff verweigert
    }
}
// server.js - KORRIGIERTE VERSION (Trust Proxy) - Teil 3

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
  .then(() => {
    console.log('>>> Datenbank Setup erfolgreich abgeschlossen.');
  })
  .catch((err) => {
    console.error('!!! FEHLER beim Ausführen von setupTables:', err);
    process.exit(1);
  });
// server.js - KORRIGIERTE VERSION (Trust Proxy) - Teil 4

// ==========================================
// Öffentliche Endpunkte (kein Login nötig)
// ==========================================

// Health Check Endpoint
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Liefert Liste aller Mitarbeiter (ID und Name)
app.get('/employees', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Prüft den letzten Eintrag eines Mitarbeiters, um den nächsten Buchungsstatus zu bestimmen
app.get('/next-booking-details', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' });
  try {
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
      FROM work_hours WHERE LOWER(name) = LOWER($1) ORDER BY date DESC, starttime DESC NULLS LAST LIMIT 1;`;
    const result = await db.query(query, [name.toLowerCase()]);
    let nextBooking = 'arbeitsbeginn', entryId = null, startDate = null, startTime = null;
    if (result.rows.length > 0) {
      const lastEntry = result.rows[0];
      if (lastEntry.starttime_formatted && !lastEntry.endtime) {
        nextBooking = 'arbeitsende'; entryId = lastEntry.id;
        startDate = lastEntry.date instanceof Date ? lastEntry.date.toISOString().split('T')[0] : lastEntry.date;
        startTime = lastEntry.starttime_formatted;
      }
    }
    res.json({ nextBooking, id: entryId, startDate, startTime });
  } catch (err) {
    console.error("Fehler /next-booking-details:", err);
    res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
  }
});

// Bucht den Arbeitsbeginn
app.post('/log-start', async (req, res) => {
    const { name, date, startTime } = req.body;
    if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten (Name, Datum YYYY-MM-DD, Startzeit HH:MM).' });
    }
    try {
        const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
        if (empCheck.rows.length === 0) return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
        const dbEmployeeName = empCheck.rows[0].name;
        const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
        const checkOpenResult = await db.query(checkOpenQuery, [dbEmployeeName.toLowerCase(), date]);
        if (checkOpenResult.rows.length > 0) return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Arbeitsbeginn.` });
        // Prüfung auf abgeschlossenen Eintrag entfernt/auskommentiert für Mehrfachbuchungen
        // const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
        // const checkCompleteResult = await db.query(checkCompleteQuery, [dbEmployeeName.toLowerCase(), date]);
        // if (checkCompleteResult.rows.length > 0) console.warn(`Warnung: Mitarbeiter ${dbEmployeeName} bucht erneut Start am ${date}, obwohl bereits ein abgeschlossener Eintrag existiert.`);
        const insertQuery = `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`;
        const insertResult = await db.query(insertQuery, [dbEmployeeName, date, startTime]);
        const newEntryId = insertResult.rows[0].id;
        console.log(`Start gebucht: ${dbEmployeeName}, ${date}, ${startTime} (ID: ${newEntryId})`);
        res.status(201).json({ id: newEntryId });
    } catch (err) { console.error("Fehler /log-start:", err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' }); }
});

// Bucht das Arbeitsende und berechnet die Stunden
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, comment } = req.body;
  if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit HH:MM).' });
  }
  const entryId = parseInt(id);
  try {
    const entryResult = await db.query( `SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE id = $1`, [entryId] );
    if (entryResult.rows.length === 0) return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
    const entry = entryResult.rows[0];
    if (entry.endtime) return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` });
    if (!entry.starttime_formatted) return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden.` });
    const netHours = calculateWorkHours(entry.starttime_formatted, endTime);
    if (netHours < 0) { console.warn(`Negative Arbeitszeit für ID ${entryId} (${entry.starttime_formatted} - ${endTime}). Speichere 0.`); }
    const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`;
    await db.query(updateQuery, [endTime, comment || null, netHours >= 0 ? netHours : 0, entryId]);
    console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Stunden: ${netHours.toFixed(2)})`);
    res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) });
  } catch (err) { console.error(`Fehler /log-end/${entryId}:`, err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' }); }
});

// Liefert Zusammenfassung der Stunden für einen Tag und den laufenden Monat
app.get('/summary-hours', async (req, res) => {
  const { name, date } = req.query;
  if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
  }
  try {
    const dailyResult = await db.query( `SELECT SUM(hours) AS total_daily_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL`, [name.toLowerCase(), date] );
    const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0;
    const yearMonthDay = date.split('-'); const year = parseInt(yearMonthDay[0]); const month = parseInt(yearMonthDay[1]);
    const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
    const lastDayForQuery = date;
    const monthlyResult = await db.query( `SELECT SUM(hours) AS total_monthly_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`, [name.toLowerCase(), firstDayOfMonth, lastDayForQuery] );
    const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0;
    res.json({ dailyHours, monthlyHours });
  } catch (err) { console.error(`Fehler /summary-hours (${name}, ${date}):`, err); res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' }); }
});
// server.js - KORRIGIERTE VERSION (Trust Proxy) - Teil 5

// ==========================================
// Admin Endpunkte (Login erforderlich via isAdmin Middleware)
// ==========================================

// Admin-Login
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) { console.error("!!! ADMIN_PASSWORD ist nicht gesetzt!"); return res.status(500).send("Serverkonfigurationsfehler."); }
  if (!password) { return res.status(400).send("Passwort fehlt."); }
  if (password === adminPassword) {
    req.session.regenerate((errReg) => {
      if (errReg) { console.error("Fehler beim Regenerieren der Session:", errReg); return res.status(500).send("Session Fehler."); }
      req.session.isAdmin = true;
      req.session.save((errSave) => {
        if (errSave) { console.error("Fehler beim Speichern der Session:", errSave); return res.status(500).send("Session Speicherfehler."); }
        console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`);
        res.status(200).send("Admin erfolgreich angemeldet.");
      });
    });
  } else { console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`); res.status(401).send("Ungültiges Passwort."); }
});

// Admin-Logout
app.post("/admin-logout", isAdmin, (req, res) => {
  if (req.session) {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
      if (err) { console.error("Fehler beim Zerstören der Session:", err); return res.status(500).send("Fehler beim Logout."); }
      res.clearCookie('connect.sid'); // Name des Session-Cookies anpassen, falls geändert
      console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else { return res.status(200).send("Keine aktive Session zum Abmelden gefunden."); }
});


// Arbeitszeiten für Admin anzeigen (mit Filterung)
app.get('/admin-work-hours', isAdmin, async (req, res) => {
    const { employeeId, year, month } = req.query;
    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
    const whereClauses = []; const queryParams = []; let paramIndex = 1;
    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId); if (isNaN(empIdInt)) return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});
        whereClauses.push(`e.id = $${paramIndex++}`); queryParams.push(empIdInt);
    }
    if (year && month) {
        const parsedYear = parseInt(year); const parsedMonth = parseInt(month);
        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' });
        try {
            const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt');
            const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0];
            whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr); whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr);
        } catch(dateError) { console.error("Datumsfehler Filter:", dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); }
    }
    let finalQuery = baseQuery; if (whereClauses.length > 0) finalQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    finalQuery += ` ORDER BY w.date DESC, e.name ASC, w.starttime ASC NULLS LAST;`;
    try {
        const result = await db.query(finalQuery, queryParams);
        const formattedRows = result.rows.map(row => ({ ...row, date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date }));
        res.json(formattedRows);
    } catch (err) { console.error("DB Fehler GET /admin-work-hours (gefiltert):", err); res.status(500).send('Serverfehler beim Laden der gefilterten Arbeitszeiten.'); }
});

// CSV-Download für Admin (berücksichtigt Filter)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
    const { employeeId, year, month } = req.query;
    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
    const whereClauses = []; const queryParams = []; let paramIndex = 1; let filterDesc = "";
    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId); if (isNaN(empIdInt)) return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});
        whereClauses.push(`e.id = $${paramIndex++}`); queryParams.push(empIdInt);
        try { const nameRes = await db.query('SELECT name FROM employees WHERE id = $1', [empIdInt]); if(nameRes.rows.length > 0) filterDesc = nameRes.rows[0].name.replace(/[^a-z0-9]/gi, '_'); } catch {}
    } else { filterDesc = "alle_MA"; }
    if (year && month) {
        const parsedYear = parseInt(year); const parsedMonth = parseInt(month); if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' });
        try { const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt'); const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0]; whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr); whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr); filterDesc += `_${year}_${String(parsedMonth).padStart(2,'0')}`; } catch(dateError) { console.error("CSV Datumsfehler Filter:", dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); }
    } else { filterDesc += "_alle_Zeiten"; }
    let finalQuery = baseQuery; if (whereClauses.length > 0) finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS LAST;`;
    try {
        const result = await db.query(finalQuery, queryParams); const csvData = await convertToCSV(db, result.rows);
        const filename = `arbeitszeiten_${filterDesc}_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));
    } catch (err) { console.error("DB Fehler GET /admin-download-csv:", err); res.status(500).send('Serverfehler beim Erstellen des CSV-Exports.'); }
});

// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  const { id, date, startTime, endTime, comment } = req.body; const entryId = parseInt(id);
  if (isNaN(entryId)) return res.status(400).json({ message: 'Ungültige ID.' }); if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'Ungültiges Datum.' }); if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) return res.status(400).json({ message: 'Ungültige Startzeit.' }); if (!endTime || !/^\d{2}:\d{2}$/.test(endTime)) return res.status(400).json({ message: 'Ungültige Endzeit.' });
  const netHours = calculateWorkHours(startTime, endTime); if (netHours < 0) console.warn(`Admin Update ID ${entryId}: Negative Arbeitszeit. Speichere 0.`);
  try {
      const checkResult = await db.query('SELECT 1 FROM work_hours WHERE id = $1', [entryId]); if (checkResult.rows.length === 0) return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` });
      const query = `UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6;`;
      const result = await db.query(query, [date, startTime, endTime, netHours >= 0 ? netHours : 0, comment || null, entryId]);
      if (result.rowCount > 0) { console.log(`Admin Update work_hours ID ${entryId}`); res.status(200).send('Eintrag aktualisiert.'); } else { res.status(404).send(`Eintrag ID ${entryId} nicht aktualisiert.`); }
  } catch (err) { console.error(`DB Fehler PUT /api/admin/update-hours (ID: ${entryId}):`, err); res.status(500).send('Serverfehler Update.'); }
});

// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params; const entryId = parseInt(id); if (isNaN(entryId)) return res.status(400).send('Ungültige ID.');
  try {
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]);
    if (result.rowCount > 0) { console.log(`Admin Delete work_hours ID ${entryId}`); res.status(200).send('Eintrag gelöscht.'); } else { res.status(404).send(`Eintrag ID ${entryId} nicht gefunden.`); }
  } catch (err) { console.error(`DB Fehler DELETE /api/admin/delete-hours (ID: ${entryId}):`, err); res.status(500).send('Serverfehler Löschen.'); }
});

// Admin: Alle Daten löschen
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  console.warn("!!! ACHTUNG: Admin löscht ALLE Arbeits-, Bilanz- und Abwesenheitsdaten via /adminDeleteData !!!");
  const confirmation = req.body.confirmation; // Erwarte Bestätigung im Body
  if (confirmation !== 'LÖSCHEN') return res.status(403).send("Bestätigung 'LÖSCHEN' im Request Body fehlt. Abbruch.");
  let client;
  try {
      client = await db.connect(); await client.query('BEGIN');
      const resultMB = await client.query('DELETE FROM monthly_balance'); console.log(` -> ${resultMB.rowCount} Monatsbilanzen gelöscht.`);
      const resultAbs = await client.query('DELETE FROM absences'); console.log(` -> ${resultAbs.rowCount} Abwesenheiten gelöscht.`);
      const resultWH = await client.query('DELETE FROM work_hours'); console.log(` -> ${resultWH.rowCount} Arbeitszeiten gelöscht.`);
      await client.query('COMMIT'); console.log("!!! Alle Daten erfolgreich gelöscht !!!");
      res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiten, ${resultMB.rowCount} Bilanzen und ${resultAbs.rowCount} Abwesenheiten wurden gelöscht.`);
  } catch (err) { if (client) await client.query('ROLLBACK'); console.error("!!! Kritischer DB Fehler bei /adminDeleteData:", err); res.status(500).send('Serverfehler beim Löschen. Transaktion zurückgerollt.'); } finally { if (client) client.release(); }
});

// --- Mitarbeiterverwaltung ---
// GET /admin/employees, POST /admin/employees, PUT /admin/employees/:id, DELETE /admin/employees/:id
// (Code unverändert - siehe vorherige Versionen)
app.get('/admin/employees', isAdmin, async (req, res) => { /* ... */ });
app.post('/admin/employees', isAdmin, async (req, res) => { /* ... */ });
app.put('/admin/employees/:id', isAdmin, async (req, res) => { /* ... */ });
app.delete('/admin/employees/:id', isAdmin, async (req, res) => { /* ... */ });


// --- Auswertungen ---
// GET /calculate-monthly-balance, GET /calculate-period-balance
// (Code unverändert)
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => { /* ... */ });
app.get('/calculate-period-balance', isAdmin, async (req, res) => { /* ... */ });


// --- Abwesenheiten ---
// GET /admin/absences, POST /admin/absences, DELETE /admin/absences/:id, POST /admin/generate-holidays
// (Code unverändert)
app.get('/admin/absences', isAdmin, async (req, res) => { /* ... */ });
app.post('/admin/absences', isAdmin, async (req, res) => { /* ... */ });
app.delete('/admin/absences/:id', isAdmin, async (req, res) => { /* ... */ });
app.post('/admin/generate-holidays', isAdmin, async (req, res) => { /* ... */ });

// --- PDF Router ---
try {
    app.use('/api/pdf', monthlyPdfRouter(db));
} catch(routerError) { console.error("!!! Fehler beim Einbinden des PDF-Routers:", routerError); }


// --- Server Start ---
app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (Passwort fehlt!)'}`);
  if(db && typeof db.options === 'object') { console.log(` Datenbank verbunden (Pool erstellt): Host=${process.env.PGHOST || db.options.host || '??'}, Port=${process.env.PGPORT || db.options.port || '??'}, DB=${process.env.PGDATABASE || db.options.database || '??'}`); }
  else if (db) { console.warn("!!! DB Pool Objekt 'db' existiert, aber Status unklar."); }
  else { console.error("!!! KRITISCH: DB Pool ('db') konnte nicht initialisiert werden!"); }
  console.log(` Feiertagsmodul: DE / NW`);
  console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(` Frontend aus: '${path.join(__dirname, 'public')}'`);
  console.log(` Trust Proxy Setting: ${app.get('trust proxy')}`); // Logge trust proxy setting
  console.log(` Session Cookie Settings: secure=${process.env.NODE_ENV === 'production'}, sameSite='${app.get('session')?.cookie.sameSite || 'lax (default)'}'`); // Logge Cookie Settings
  console.log(`=======================================================`);
});
