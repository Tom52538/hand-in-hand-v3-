// server.js

// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

// Benötigte Module importieren
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cors = require("cors");

// === Importiere den PDF-Router ===
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');


const app = express();

// Importiere externe Berechnungsfunktionen
const { calculateMonthlyData, getExpectedHours, calculatePeriodData } = require('./utils/calculationUtils');

// --- HILFSFUNKTIONEN ---
function parseTime(timeStr) {
  // ... (unverändert)
  if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  // ... (unverändert)
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  let diffInMin = endMinutes - startMinutes;
  if (diffInMin < 0) {
    // console.warn(`Mögliche Arbeit über Mitternacht erkannt (${startTime} - ${endTime}). Addiere 24 Stunden.`); // Optional: Logging reduzieren
    diffInMin += 24 * 60;
  }
  if (diffInMin > 24 * 60) {
      console.warn(`Berechnete Arbeitszeit über 24h (${(diffInMin/60).toFixed(2)}h) für ${startTime}-${endTime}. Prüfen! Setze auf 0.`);
      return 0;
  }
  return diffInMin / 60;
}

async function convertToCSV(db, data) {
    // ... (unverändert)
    if (!data || data.length === 0) return '';
    const csvRows = [];
    const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std", "Differenz", "Bemerkung"];
    csvRows.push(headers.join(','));
    const employeeNames = [...new Set(data.map(row => row.name))].filter(Boolean);
    let employeesData = {};
    if (employeeNames.length > 0) {
        try {
            const empQuery = `SELECT name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees WHERE name = ANY($1::text[])`;
            const empResult = await db.query(empQuery, [employeeNames]);
            empResult.rows.forEach(emp => {
                employeesData[emp.name.toLowerCase()] = emp;
            });
        } catch(dbError) {
            console.error("Fehler beim Abrufen der Mitarbeiterdaten für CSV:", dbError);
        }
    }
    for (const row of data) {
        let dateFormatted = "";
        let dateStringForCalc = null;
        if (row.date) {
            try {
                const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
                dateFormatted = dateObj.toLocaleDateString('de-DE', { timeZone: 'UTC' });
                dateStringForCalc = dateObj.toISOString().split('T')[0];
            } catch (e) {
                dateFormatted = String(row.date);
                console.warn("CSV Datumsformat Fehler:", row.date, e);
            }
        }
        const startTimeFormatted = row.startTime || "";
        const endTimeFormatted = row.endTime || "";
        const istHours = parseFloat(row.hours) || 0;
        let expected = 0;
        const employee = row.name ? employeesData[row.name.toLowerCase()] : null;
        if (employee && dateStringForCalc && typeof getExpectedHours === 'function') {
            try {
                expected = getExpectedHours(employee, dateStringForCalc);
            } catch (e) {
                console.error(`Fehler beim Holen der Soll-Stunden für CSV (MA: ${row.name}, Datum: ${dateStringForCalc}):`, e);
            }
        }
        const diff = istHours - expected;
        const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
        const values = [
            row.id, row.name || '', dateFormatted, startTimeFormatted, endTimeFormatted,
            istHours.toFixed(2), expected.toFixed(2), diff.toFixed(2), commentFormatted
        ];
        csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}
// --- ENDE HILFSFUNKTIONEN ---

// CORS-Konfiguration
app.use(cors({ /* ... (unverändert) */
  origin: "*",
  credentials: true
}));
app.set('trust proxy', 1);
const port = process.env.PORT || 8080;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// PostgreSQL-Datenbankverbindung Pool
const db = new Pool({ /* ... (unverändert) */
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
db.on('error', (err, client) => { /* ... (unverändert) */
  console.error('Unerwarteter Fehler im PostgreSQL Idle Client', err);
  process.exit(-1);
});

// Session Store Konfiguration
const sessionStore = new pgSession({ /* ... (unverändert) */
  pool: db,
  tableName: 'user_sessions',
  createTableIfMissing: true,
});
app.use(session({ /* ... (unverändert) */
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-geheimnis',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  },
}));

// --- Datenbank-Tabellen Setup (Beim Start prüfen/erstellen) ---
const setupTables = async () => {
  try {
    // employees Tabelle (unverändert)
    await db.query(`CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      mo_hours DOUBLE PRECISION DEFAULT 0,
      di_hours DOUBLE PRECISION DEFAULT 0,
      mi_hours DOUBLE PRECISION DEFAULT 0,
      do_hours DOUBLE PRECISION DEFAULT 0,
      fr_hours DOUBLE PRECISION DEFAULT 0
    );`);
    console.log("Tabelle employees geprüft/erstellt.");

    // work_hours Tabelle (unverändert)
    await db.query(`CREATE TABLE IF NOT EXISTS work_hours (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      date DATE NOT NULL,
      starttime TIME,
      endtime TIME,
      hours DOUBLE PRECISION,
      comment TEXT
    );`);
    console.log("Tabelle work_hours geprüft/erstellt.");

    // monthly_balance Tabelle (unverändert)
    await db.query(`CREATE TABLE IF NOT EXISTS monthly_balance (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      year_month DATE NOT NULL,
      difference DOUBLE PRECISION,
      carry_over DOUBLE PRECISION,
      UNIQUE (employee_id, year_month)
    );`);
    console.log("Tabelle monthly_balance geprüft/erstellt.");
    await db.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    console.log("Index für monthly_balance geprüft/erstellt.");

    // *** NEU: absences Tabelle ***
    await db.query(`
      CREATE TABLE IF NOT EXISTS absences (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')), -- Typ der Abwesenheit
        credited_hours DOUBLE PRECISION NOT NULL, -- Gutgeschriebene Stunden für diesen Tag
        comment TEXT, -- Optionaler Kommentar
        UNIQUE (employee_id, date) -- Eindeutig pro Mitarbeiter und Tag
      );
    `);
    console.log("Tabelle absences geprüft/erstellt.");

    // *** NEU: Index für absences Tabelle ***
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);
    `);
    console.log("Index für absences geprüft/erstellt.");
    // *** ENDE NEU ***

  } catch (err) {
    console.error("!!! Datenbank Setup Fehler:", err);
    process.exit(1);
  }
};

setupTables(); // Tabellen beim Serverstart initialisieren

// Middleware für Admin-Check
function isAdmin(req, res, next) { /* ... (unverändert) */
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    console.warn(`Zugriffsversuch auf Admin-Route ohne Admin-Session: ${req.originalUrl} von IP ${req.ip}`);
    res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
  }
}

// ==========================================
// Öffentliche Endpunkte (Kein Login nötig)
// ==========================================
// Health Check, /employees, /next-booking-details, /log-start, /log-end, /summary-hours
// bleiben unverändert.

// Health Check Endpunkt
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Mitarbeiterliste für Dropdown im Frontend
app.get('/employees', async (req, res) => { /* ... (unverändert) */
  try {
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Details für nächsten Buchungsschritt
app.get('/next-booking-details', async (req, res) => { /* ... (unverändert) */
  const { name } = req.query;
  if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' });
  try {
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
      FROM work_hours WHERE LOWER(name) = LOWER($1) ORDER BY date DESC, starttime DESC NULLS LAST LIMIT 1;`;
    const result = await db.query(query, [name.toLowerCase()]);
    let nextBooking = 'arbeitsbeginn', entryId = null, startDate = null, startTime = null;
    if (result.rows.length > 0) {
      const last = result.rows[0];
      if (last.starttime_formatted && !last.endtime) {
        nextBooking = 'arbeitsende'; entryId = last.id;
        startDate = last.date instanceof Date ? last.date.toISOString().split('T')[0] : last.date;
        startTime = last.starttime_formatted;
      }
    }
    res.json({ nextBooking, id: entryId, startDate, startTime });
  } catch (err) {
    console.error("Fehler /next-booking-details:", err);
    res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
  }
});

// Arbeitsbeginn loggen
app.post('/log-start', async (req, res) => { /* ... (unverändert - inkl. Prüfungen) */
    const { name, date, startTime } = req.body;
    if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten.' });
    }
    try {
        const empCheck = await db.query('SELECT id FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
        if (empCheck.rows.length === 0) return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
        const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
        const checkOpenResult = await db.query(checkOpenQuery, [name.toLowerCase(), date]);
        if (checkOpenResult.rows.length > 0) return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Eintrag.` });
        const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
        const checkCompleteResult = await db.query(checkCompleteQuery, [name.toLowerCase(), date]);
        if (checkCompleteResult.rows.length > 0) return res.status(409).json({ message: `An diesem Tag wurde bereits eine vollständige Arbeitszeit erfasst.` });

        const insert = await db.query(
            `INSERT INTO work_hours (name, date, starttime) VALUES ((SELECT name FROM employees WHERE LOWER(name)=LOWER($1)), $2, $3) RETURNING id;`,
            [name.toLowerCase(), date, startTime]
        );
        console.log(`Start gebucht: ${name}, ${date}, ${startTime} (ID: ${insert.rows[0].id})`);
        res.status(201).json({ id: insert.rows[0].id });
    } catch (err) {
        console.error("Fehler /log-start:", err);
        res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' });
    }
});

// Arbeitsende loggen
app.put('/log-end/:id', async (req, res) => { /* ... (unverändert) */
  const { id } = req.params;
  const { endTime, comment } = req.body;
  if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten.' });
  }
  const entryId = parseInt(id);
  try {
    const entryResult = await db.query('SELECT TO_CHAR(starttime, \'HH24:MI\') AS starttime_formatted, endtime FROM work_hours WHERE id = $1', [entryId]);
    if (entryResult.rows.length === 0) return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` });
    const entry = entryResult.rows[0];
    if (entry.endtime) return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` });
    if (!entry.starttime_formatted) return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden.` });
    const netHours = calculateWorkHours(entry.starttime_formatted, endTime);
    await db.query( `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`, [endTime, comment || '', netHours, entryId]);
    console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Berechnete Stunden: ${netHours.toFixed(2)})`);
    res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) });
  } catch (err) {
    console.error(`Fehler /log-end/${entryId}:`, err);
    res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' });
  }
});

// Zusammenfassung Stunden (Tag/Monat)
app.get('/summary-hours', async (req, res) => { /* ... (unverändert) */
    const { name, date } = req.query;
    if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
    }
    try {
        const dailyResult = await db.query( `SELECT hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL AND endtime IS NOT NULL ORDER BY endtime DESC LIMIT 1`, [name.toLowerCase(), date]);
        const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].hours) || 0) : 0;
        const yearMonthDay = date.split('-');
        const year = parseInt(yearMonthDay[0]); const month = parseInt(yearMonthDay[1]);
        const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
        const lastDayForQuery = date;
        const monthlyResult = await db.query( `SELECT SUM(hours) AS total_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`, [name.toLowerCase(), firstDayOfMonth, lastDayForQuery]);
        const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_hours ? (parseFloat(monthlyResult.rows[0].total_hours) || 0) : 0;
        // console.log(`Zusammenfassung ${name}: Tag ${date}=${dailyHours.toFixed(2)}h, Monat ${year}-${String(month).padStart(2,'0')}=${monthlyHours.toFixed(2)}h`); // Weniger Logging
        res.json({ dailyHours, monthlyHours });
    } catch (err) {
        console.error(`Fehler /summary-hours (${name}, ${date}):`, err);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' });
    }
});

// ==========================================
// Admin Endpunkte (Login erforderlich)
// ==========================================
// Admin-Login, Admin-Logout bleiben unverändert

// Admin-Login
app.post("/admin-login", (req, res) => { /* ... (unverändert) */
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) { console.error("Admin-Passwort nicht in .env gesetzt!"); return res.status(500).send("Serverkonfigurationsfehler."); }
  if (!password) { return res.status(400).send("Passwort fehlt."); }
  if (password === adminPassword) {
    req.session.regenerate((err) => {
      if (err) { console.error("Session Regenerate Fehler:", err); return res.status(500).send("Session Fehler."); }
      req.session.isAdmin = true;
      req.session.save((saveErr) => {
        if (saveErr) { console.error("Session Save Fehler nach Login:", saveErr); return res.status(500).send("Session Speicherfehler."); }
        console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`);
        res.status(200).send("Admin erfolgreich angemeldet.");
      });
    });
  } else {
    console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`);
    res.status(401).send("Ungültiges Passwort.");
  }
});

// Admin-Logout
app.post("/admin-logout", isAdmin, (req, res) => { /* ... (unverändert) */
    if (req.session) {
        const sessionId = req.sessionID;
        req.session.destroy(err => {
            if (err) { console.error("Fehler beim Zerstören der Session:", err); return res.status(500).send("Fehler beim Logout."); }
            res.clearCookie('connect.sid');
            console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
            return res.status(200).send("Erfolgreich abgemeldet.");
        });
    } else { return res.status(200).send("Keine aktive Session zum Abmelden."); }
});
// Admin-Ansicht aller Arbeitszeiten
app.get('/admin-work-hours', isAdmin, async (req, res) => { /* ... (unverändert) */
  try {
    const query = `SELECT id, name, date, hours, comment, TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime" FROM work_hours ORDER BY date DESC, name ASC, starttime ASC;`;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) { console.error("DB Fehler GET /admin-work-hours:", err); res.status(500).send('Serverfehler beim Laden der Arbeitszeiten.'); }
});

// CSV-Download aller Arbeitszeiten
app.get('/admin-download-csv', isAdmin, async (req, res) => { /* ... (unverändert) */
  try {
      const query = `SELECT w.id, w.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`;
      const result = await db.query(query);
      const csvData = await convertToCSV(db, result.rows);
      const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));
  } catch (err) { console.error("DB Fehler GET /admin-download-csv:", err); res.status(500).send('Serverfehler beim Erstellen der CSV-Datei.'); }
});

// Einzelnen Arbeitszeiteintrag updaten
app.put('/api/admin/update-hours', isAdmin, async (req, res) => { /* ... (unverändert) */
  const { id, name, date, startTime, endTime, comment } = req.body;
  if (isNaN(parseInt(id)) || !name || !date || !startTime || !endTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).send('Ungültige oder fehlende Daten.');
  }
  const netHours = calculateWorkHours(startTime, endTime);
  try {
     const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
     if (empCheck.rows.length === 0) return res.status(404).send(`Mitarbeiter '${name}' für Update nicht gefunden.`);
     const dbEmployeeName = empCheck.rows[0].name;
     const query = `UPDATE work_hours SET name = $1, date = $2, starttime = $3, endtime = $4, hours = $5, comment = $6 WHERE id = $7;`;
     const result = await db.query(query, [dbEmployeeName, date, startTime, endTime, netHours, comment || '', parseInt(id)]);
     if (result.rowCount > 0) { console.log(`Admin Update für work_hours ID ${id} erfolgreich.`); res.status(200).send('Arbeitszeiteintrag erfolgreich aktualisiert.'); }
     else { res.status(404).send(`Arbeitszeiteintrag mit ID ${id} nicht gefunden.`); }
  } catch (err) { console.error("DB Fehler PUT /api/admin/update-hours:", err); res.status(500).send('Serverfehler beim Aktualisieren des Eintrags.'); }
});

// Einzelnen Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => { /* ... (unverändert) */
  const { id } = req.params;
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID übergeben.');
  try {
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [parseInt(id)]);
    if (result.rowCount > 0) { console.log(`Admin Delete für work_hours ID ${id} erfolgreich.`); res.status(200).send('Eintrag erfolgreich gelöscht.'); }
    else { res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`); }
  } catch (err) { console.error("DB Fehler DELETE /api/admin/delete-hours:", err); res.status(500).send('Serverfehler beim Löschen des Eintrags.'); }
});

// Alle Arbeitszeiten löschen (inkl. Monatsbilanzen)
app.delete('/adminDeleteData', isAdmin, async (req, res) => { /* ... (unverändert) */
  console.warn("!!! Versuch zum Löschen ALLER Arbeitszeiten durch Admin !!!");
  try {
    const resultWH = await db.query('DELETE FROM work_hours');
    console.log(`!!! Admin hat ${resultWH.rowCount} Arbeitszeiteinträge gelöscht !!!`);
    const resultMB = await db.query('DELETE FROM monthly_balance');
    console.log(`!!! Admin hat ${resultMB.rowCount} Monatsbilanz-Einträge gelöscht !!!`);
    // *** NEU: Auch Abwesenheiten löschen ***
    const resultAbs = await db.query('DELETE FROM absences');
    console.log(`!!! Admin hat ${resultAbs.rowCount} Abwesenheits-Einträge gelöscht !!!`);
    res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiteinträge, ${resultMB.rowCount} Monatsbilanzen und ${resultAbs.rowCount} Abwesenheiten wurden gelöscht.`);
  } catch (err) { console.error("DB Fehler /adminDeleteData:", err); res.status(500).send('Serverfehler beim Löschen aller Daten.'); }
});

// --- Admin: Mitarbeiterverwaltung ---
// GET /admin/employees (unverändert)
app.get('/admin/employees', isAdmin, async (req, res) => { /* ... (unverändert) */
  try { const result = await db.query('SELECT * FROM employees ORDER BY name ASC'); res.json(result.rows); }
  catch (err) { console.error("DB Fehler GET /admin/employees:", err); res.status(500).send('Serverfehler beim Laden der Mitarbeiter.'); }
});

// POST /admin/employees (unverändert)
app.post('/admin/employees', isAdmin, async (req, res) => { /* ... (unverändert) */
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : '';
  if (!trimmedName) return res.status(400).send('Mitarbeitername darf nicht leer sein.');
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
  try {
    const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`;
    const result = await db.query(query, [trimmedName, ...hours]);
    console.log(`Admin Add MA: ${trimmedName}`); res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { console.warn(`Versuch, existierenden Mitarbeiter hinzuzufügen: ${trimmedName}`); res.status(409).send(`Ein Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`); }
    else { console.error("DB Fehler POST /admin/employees:", err); res.status(500).send('Serverfehler beim Hinzufügen des Mitarbeiters.'); }
  }
});

// PUT /admin/employees/:id (unverändert - inkl. Update in work_hours)
app.put('/admin/employees/:id', isAdmin, async (req, res) => { /* ... (unverändert) */
    const { id } = req.params; const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
    const trimmedName = name ? name.trim() : '';
    if (isNaN(parseInt(id))) return res.status(400).send('Ungültige Mitarbeiter-ID.');
    if (!trimmedName) return res.status(400).send('Mitarbeitername darf nicht leer sein.');
    const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
    try {
        const oldNameResult = await db.query('SELECT name FROM employees WHERE id = $1', [parseInt(id)]);
        const oldName = oldNameResult.rows.length > 0 ? oldNameResult.rows[0].name : null; const newName = trimmedName;
        const query = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
        const result = await db.query(query, [newName, ...hours, parseInt(id)]);
        if (result.rowCount > 0) {
             console.log(`Admin Update MA ID ${id}. Alter Name: ${oldName}, Neuer Name: ${newName}`);
             if (oldName && oldName !== newName) {
                 console.log(`Aktualisiere Namen in work_hours von '${oldName}' zu '${newName}'...`);
                 const workHoursUpdateResult = await db.query(`UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`, [newName, oldName.toLowerCase()]);
                 console.log(`${workHoursUpdateResult.rowCount} Einträge in work_hours aktualisiert.`);
                 // *** NEU: Namen auch in absences aktualisieren ***
                 // Note: Absences uses employee_id, so no name update needed here if schema is followed.
                 // If absences used name:
                 // const absenceUpdateResult = await db.query(`UPDATE absences SET name = $1 WHERE LOWER(name) = LOWER($2)`, [newName, oldName.toLowerCase()]);
                 // console.log(`${absenceUpdateResult.rowCount} Einträge in absences aktualisiert.`);
             }
             res.status(200).send('Mitarbeiterdaten erfolgreich aktualisiert.');
        } else { res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`); }
    } catch (err) {
        if (err.code === '23505') { console.warn(`Versuch, Mitarbeiter ID ${id} auf existierenden Namen umzubenennen: ${trimmedName}`); res.status(409).send(`Ein anderer Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`); }
        else { console.error(`DB Fehler PUT /admin/employees/${id}:`, err); res.status(500).send('Serverfehler beim Aktualisieren der Mitarbeiterdaten.'); }
    }
});

// DELETE /admin/employees/:id (unverändert - inkl. Löschen abhängiger Daten)
app.delete('/admin/employees/:id', isAdmin, async (req, res) => { /* ... (unverändert) */
    const { id } = req.params; if (isNaN(parseInt(id))) return res.status(400).send('Ungültige Mitarbeiter-ID.');
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const nameResult = await client.query('SELECT name FROM employees WHERE id = $1', [parseInt(id)]);
        if (nameResult.rows.length === 0) { await client.query('ROLLBACK'); client.release(); return res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`); }
        const employeeName = nameResult.rows[0].name;
        console.log(`Versuche Mitarbeiter ${employeeName} (ID: ${id}) zu löschen...`);
        console.log(`Lösche Arbeitszeiten für ${employeeName}...`);
        const workHoursDeleteResult = await client.query('DELETE FROM work_hours WHERE LOWER(name) = LOWER($1)', [employeeName.toLowerCase()]);
        console.log(`${workHoursDeleteResult.rowCount} Arbeitszeit-Einträge gelöscht.`);
        // Monatsbilanzen & Abwesenheiten werden durch ON DELETE CASCADE gelöscht
        console.log(`Lösche Monatsbilanzen und Abwesenheiten für MA ID ${id} (via CASCADE)...`);
        console.log(`Lösche Mitarbeiter ${employeeName} (ID: ${id}) selbst...`);
        const result = await client.query('DELETE FROM employees WHERE id = $1', [parseInt(id)]); // Cascade löscht abhängige Daten in monthly_balance und absences
        await client.query('COMMIT');
        if (result.rowCount > 0) {
            console.log(`Admin Delete MA ID ${id} (${employeeName}) erfolgreich abgeschlossen.`);
            res.status(200).send('Mitarbeiter und alle zugehörigen Daten (Arbeitszeiten, Monatsbilanzen, Abwesenheiten) erfolgreich gelöscht.');
        } else { await client.query('ROLLBACK'); res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden (trotz vorheriger Prüfung).`); }
    } catch (err) {
        await client.query('ROLLBACK'); console.error(`DB Fehler DELETE /admin/employees/${id}:`, err);
        if (err.code === '23503') { res.status(409).send('Fehler: Mitarbeiter konnte nicht gelöscht werden, da noch abhängige Daten existieren (FK-Constraint).'); }
        else { res.status(500).send('Serverfehler beim Löschen des Mitarbeiters.'); }
    } finally { client.release(); }
});

// === Endpunkte für Auswertungen (unverändert) ===
// GET /calculate-monthly-balance
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => { /* ... (unverändert) */
  const { name, year, month } = req.query;
  if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
      return res.status(400).json({ message: "Ungültige Eingabe. Benötigt: name, year, month (1-12)." });
  }
  try {
    const result = await calculateMonthlyData(db, name, year, month); // Ruft jetzt die aktualisierte Funktion auf
    console.log(`Admin Monatsauswertung berechnet für: ${result.employeeName || name} (${month}/${year})`);
    res.json(result);
  } catch (err) {
    console.error(`Fehler /calculate-monthly-balance (Name: ${name}, ${month}/${year}):`, err);
    if (err.message.includes("Mitarbeiter nicht gefunden")) { res.status(404).json({ message: err.message }); }
    else { res.status(500).json({ message: `Serverfehler bei der Berechnung der Monatsbilanz: ${err.message}` }); }
  }
});

// GET /calculate-period-balance
app.get('/calculate-period-balance', isAdmin, async (req, res) => { /* ... (unverändert) */
    const { name, year, periodType, periodValue } = req.query;
    if (!name || !year || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
        return res.status(400).json({ message: "Ungültige Eingabe. Benötigt: name, year, periodType ('QUARTER' oder 'YEAR')." });
    }
    if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
         return res.status(400).json({ message: "Ungültige Eingabe. Für periodType 'QUARTER' wird periodValue (1-4) benötigt." });
    }
    if (isNaN(parseInt(year))) return res.status(400).json({ message: "Ungültiges Jahr angegeben." });
    try {
        const result = await calculatePeriodData(db, name, year, periodType.toUpperCase(), periodValue); // Ruft jetzt die aktualisierte Funktion auf
        console.log(`Admin Periodenauswertung berechnet für: ${result.employeeName || name} (${year} ${result.periodIdentifier})`);
        res.json(result);
    } catch (err) {
        console.error(`Fehler /calculate-period-balance (Name: ${name}, ${year}, ${periodType}, ${periodValue}):`, err);
         if (err.message.includes("Mitarbeiter nicht gefunden")) { res.status(404).json({ message: err.message }); }
         else { res.status(500).json({ message: `Serverfehler bei der Berechnung der Periodenbilanz: ${err.message}` }); }
    }
});

// === PDF Router ===
app.use('/api/pdf', monthlyPdfRouter(db));

// === Server Start ===
app.listen(port, () => { /* ... (unverändert) */
  console.log(`Server läuft auf Port ${port}`);
  console.log(`Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Admin-Routen sind ${process.env.ADMIN_PASSWORD ? 'aktiviert' : 'DEAKTIVIERT (ADMIN_PASSWORD fehlt)'}`);
  if(db && db.options) console.log(`Datenbank verbunden mit: ${db.options.host || 'localhost'}:${db.options.port || 5432}, DB: ${db.options.database}`);
});
