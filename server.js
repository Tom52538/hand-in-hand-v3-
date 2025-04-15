// server.js

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cors = require("cors");
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
const app = express();
// Stelle sicher, dass die *korrigierte* calculationUtils geladen wird
const { calculateMonthlyData, getExpectedHours, calculatePeriodData } = require('./utils/calculationUtils');

// *** NEU: date-holidays importieren ***
const Holidays = require('date-holidays');
// *** NEU: Initialisiere für NRW ***
// Wird später in der Route verwendet
const hd = new Holidays('DE', 'NW');


// --- HILFSFUNKTIONEN ---
// parseTime, calculateWorkHours, convertToCSV... (unverändert)
function parseTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return 0;
    const [hh, mm] = timeStr.split(':');
    return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const startMinutes = parseTime(startTime);
    const endMinutes = parseTime(endTime);
    let diffInMin = endMinutes - startMinutes;
    if (diffInMin < 0) { diffInMin += 24 * 60; }
    if (diffInMin > 24 * 60) { console.warn(`Arbeitszeit > 24h für ${startTime}-${endTime}. Setze auf 0.`); return 0; }
    return diffInMin / 60;
}

async function convertToCSV(db, data) {
    if (!data || data.length === 0) return '';
    const csvRows = [];
    const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std (Standard)", "Differenz (vs. Standard)", "Bemerkung"];
    csvRows.push(headers.join(','));
    const employeeNames = [...new Set(data.map(row => row.name))].filter(Boolean);
    let employeesData = {};
    if (employeeNames.length > 0) {
      try {
          const empQuery = `SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees WHERE name = ANY($1::text[])`;
          const empResult = await db.query(empQuery, [employeeNames]);
          empResult.rows.forEach(emp => { employeesData[emp.name.toLowerCase()] = emp; });
      } catch(dbError) {
          console.error("Fehler Abrufen MA-Daten für CSV:", dbError);
      }
    }
    for (const row of data) {
      let dateFormatted = "", dateStringForCalc = null;
      if (row.date) {
        try {
            const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date.split('T')[0] + 'T00:00:00Z');
            dateFormatted = dateObj.toLocaleDateString('de-DE', { timeZone: 'UTC' });
            dateStringForCalc = dateObj.toISOString().split('T')[0];
        } catch (e) { dateFormatted = String(row.date); console.warn("CSV Datumsformat Fehler:", row.date, e); }
      }
      const startTimeFormatted = row.startTime || "";
      const endTimeFormatted = row.endTime || "";
      const istHours = parseFloat(row.hours) || 0;
      let expected = 0;
      const employee = row.name ? employeesData[row.name.toLowerCase()] : null;
      if (employee && dateStringForCalc && typeof getExpectedHours === 'function') {
          try { expected = getExpectedHours(employee, dateStringForCalc); }
          catch (e) { console.error(`Fehler Soll-Std CSV (MA: ${row.name}, Datum: ${dateStringForCalc}):`, e); }
      }
      const diff = istHours - expected;
      const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
      const values = [ row.id, row.name || '', dateFormatted, startTimeFormatted, endTimeFormatted, istHours.toFixed(2), expected.toFixed(2), diff.toFixed(2), commentFormatted ];
      csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}


// Middleware, DB Pool, Session Setup
app.use(cors({ origin: "*", credentials: true }));
app.set('trust proxy', 1);
const port = process.env.PORT || 8080;
app.use(bodyParser.json());
app.use(express.static('public'));
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, });
db.on('error', (err, client) => { console.error('Unerwarteter Fehler im PostgreSQL Idle Client', err); process.exit(-1); });
const sessionStore = new pgSession({ pool : db, tableName : 'user_sessions', createTableIfMissing: true });
app.use(session({ store: sessionStore, secret: process.env.SESSION_SECRET || 'ein-sehr-geheimes-geheimnis-das-man-aendern-sollte', resave: false, saveUninitialized: false, cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax' } }));
// Datenbank-Setup Funktion
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
        -- Zukünftig evtl.: bundesland VARCHAR(2) DEFAULT 'NW'
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

  } catch (err) {
    console.error("!!! Kritischer Datenbank Setup Fehler:", err);
    process.exit(1);
  }
};

setupTables();

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    console.warn(`Zugriffsversuch auf Admin-Route ohne Admin-Session: ${req.originalUrl} von IP ${req.ip}`);
    res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
  }
}

// ==========================================
// Öffentliche Endpunkte (kein Login nötig)
// ==========================================
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
// Prüft den letzten Eintrag eines Mitarbeiters
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

// Bucht den Arbeitsbeginn
app.post('/log-start', async (req, res) => {
  const { name, date, startTime } = req.body;
  if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten.' });
  }
  try {
      const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
      if (empCheck.rows.length === 0) return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
      const dbEmployeeName = empCheck.rows[0].name;
      const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
      const checkOpenResult = await db.query(checkOpenQuery, [dbEmployeeName.toLowerCase(), date]);
      if (checkOpenResult.rows.length > 0) return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Eintrag.` });
      const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
      const checkCompleteResult = await db.query(checkCompleteQuery, [dbEmployeeName.toLowerCase(), date]);
      if (checkCompleteResult.rows.length > 0) return res.status(409).json({ message: `An diesem Tag wurde bereits eine vollständige Arbeitszeit erfasst.` });
      const insert = await db.query(`INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`, [dbEmployeeName, date, startTime]);
      console.log(`Start gebucht: ${dbEmployeeName}, ${date}, ${startTime} (ID: ${insert.rows[0].id})`);
      res.status(201).json({ id: insert.rows[0].id });
  } catch (err) { console.error("Fehler /log-start:", err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' }); }
});

// Bucht das Arbeitsende
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, comment } = req.body;
  if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten.' });
  }
  const entryId = parseInt(id);
  try {
      const entryResult = await db.query(`SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE id = $1`, [entryId]);
      if (entryResult.rows.length === 0) return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
      const entry = entryResult.rows[0];
      if (entry.endtime) return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` });
      if (!entry.starttime_formatted) return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden.` });
      const netHours = calculateWorkHours(entry.starttime_formatted, endTime);
      await db.query(`UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`, [endTime, comment || '', netHours, entryId]);
      console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Stunden: ${netHours.toFixed(2)})`);
      res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) });
  } catch (err) { console.error(`Fehler /log-end/${entryId}:`, err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' }); }
});

// Liefert Zusammenfassung der Stunden
app.get('/summary-hours', async (req, res) => {
  const { name, date } = req.query;
  if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
  }
  try {
      const dailyResult = await db.query(`SELECT SUM(hours) AS total_daily_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL AND endtime IS NOT NULL`, [name.toLowerCase(), date]);
      const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0;
      const yearMonthDay = date.split('-'); const year = parseInt(yearMonthDay[0]); const month = parseInt(yearMonthDay[1]);
      const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
      const lastDayForQuery = date;
      const monthlyResult = await db.query(`SELECT SUM(hours) AS total_monthly_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`, [name.toLowerCase(), firstDayOfMonth, lastDayForQuery]);
      const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0;
      res.json({ dailyHours, monthlyHours });
  } catch (err) { console.error(`Fehler /summary-hours (${name}, ${date}):`, err); res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' }); }
});
// ==========================================
// Admin Endpunkte (Login erforderlich)
// ==========================================

// Admin-Login
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) { console.error("ADMIN_PASSWORD nicht gesetzt!"); return res.status(500).send("Serverkonfigurationsfehler."); }
  if (!password) { return res.status(400).send("Passwort fehlt."); }
  if (password === adminPassword) {
      req.session.regenerate((err) => {
          if (err) { console.error("Session Regenerate Fehler:", err); return res.status(500).send("Session Fehler."); }
          req.session.isAdmin = true;
          req.session.save((saveErr) => {
              if (saveErr) { console.error("Session Save Fehler:", saveErr); return res.status(500).send("Session Speicherfehler."); }
              console.log(`Admin angemeldet. Session ID: ${req.sessionID}`);
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
      if (err) { console.error("Session Destroy Fehler:", err); return res.status(500).send("Fehler beim Logout."); }
      res.clearCookie('connect.sid');
      console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else { return res.status(200).send("Keine aktive Session."); }
});

// Arbeitszeiten für Admin anzeigen (mit Filterung)
app.get('/admin-work-hours', isAdmin, async (req, res) => {
    const { employeeId, year, month } = req.query;
    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment,
                       TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
                     FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
    const whereClauses = []; const queryParams = []; let paramIndex = 1;
    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId);
        if (isNaN(empIdInt)) return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});
        whereClauses.push(`e.id = $${paramIndex++}`); queryParams.push(empIdInt);
    }
    if (year && month) {
        const parsedYear = parseInt(year); const parsedMonth = parseInt(month);
        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) {
             return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' });
        }
        try {
            const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
            const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
             if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt');
            const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0];
            whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr);
            whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr);
        } catch(dateError) { console.error("Datumsfehler Filter:", dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); }
    }
    let finalQuery = baseQuery;
    if (whereClauses.length > 0) { finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; }
    finalQuery += ` ORDER BY w.date DESC, e.name ASC, w.starttime ASC;`;
    try {
        const result = await db.query(finalQuery, queryParams);
        res.json(result.rows);
    } catch (err) { console.error("DB Fehler GET /admin-work-hours (gefiltert):", err); res.status(500).send('Serverfehler beim Laden der Arbeitszeiten.'); }
});
// CSV-Download für Admin
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  // TODO: Filterung berücksichtigen? Aktuell alle Daten.
  try {
    const query = `
        SELECT w.id, w.name, w.date, w.hours, w.comment,
               TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
        FROM work_hours w ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`;
    const result = await db.query(query);
    const csvData = await convertToCSV(db, result.rows);
    const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));
  } catch (err) { console.error("DB Fehler GET /admin-download-csv:", err); res.status(500).send('Serverfehler CSV.'); }
});

// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  const { id, date, startTime, endTime, comment } = req.body;
  if (isNaN(parseInt(id)) || !date || !startTime || !endTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Ungültige Daten.' });
  }
  const netHours = calculateWorkHours(startTime, endTime); const entryId = parseInt(id);
  try {
      const checkResult = await db.query('SELECT name FROM work_hours WHERE id = $1', [entryId]);
       if (checkResult.rows.length === 0) return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` });
      const query = `UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6;`;
      const result = await db.query(query, [date, startTime, endTime, netHours, comment || '', entryId]);
      if (result.rowCount > 0) { console.log(`Admin Update work_hours ID ${entryId}`); res.status(200).send('Eintrag aktualisiert.'); }
      else { res.status(404).send(`Eintrag ID ${entryId} nicht gefunden (Update).`); }
  } catch (err) { console.error(`DB Fehler PUT /api/admin/update-hours (ID: ${entryId}):`, err); res.status(500).send('Serverfehler Update.'); }
});

// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params; if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.'); const entryId = parseInt(id);
  try {
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]);
    if (result.rowCount > 0) { console.log(`Admin Delete work_hours ID ${entryId}`); res.status(200).send('Eintrag gelöscht.'); }
    else { res.status(404).send(`Eintrag ID ${entryId} nicht gefunden.`); }
  } catch (err) { console.error(`DB Fehler DELETE /api/admin/delete-hours (ID: ${entryId}):`, err); res.status(500).send('Serverfehler Löschen.'); }
});

// Admin: Alle Daten löschen
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  console.warn("!!! ACHTUNG: Admin löscht ALLE Arbeits-, Bilanz- und Abwesenheitsdaten !!!");
  try {
      const resultMB = await db.query('DELETE FROM monthly_balance'); console.log(`!!! ${resultMB.rowCount} Monatsbilanzen gelöscht !!!`);
      const resultAbs = await db.query('DELETE FROM absences'); console.log(`!!! ${resultAbs.rowCount} Abwesenheiten gelöscht !!!`);
      const resultWH = await db.query('DELETE FROM work_hours'); console.log(`!!! ${resultWH.rowCount} Arbeitszeiten gelöscht !!!`);
      res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiten, ${resultMB.rowCount} Bilanzen und ${resultAbs.rowCount} Abwesenheiten gelöscht.`);
  } catch (err) { console.error("DB Fehler bei /adminDeleteData:", err); res.status(500).send('Serverfehler Löschen aller Daten.'); }
});
// === Mitarbeiterverwaltung ===

// Admin: Liste aller Mitarbeiter holen
app.get('/admin/employees', isAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) { console.error("DB Fehler GET /admin/employees:", err); res.status(500).send('Serverfehler Laden MA.'); }
});

// Admin: Neuen Mitarbeiter hinzufügen
app.post('/admin/employees', isAdmin, async (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : '';
  if (!trimmedName) return res.status(400).send('Name darf nicht leer sein.');
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
  try {
    const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`;
    const result = await db.query(query, [trimmedName, ...hours]);
    console.log(`Admin Add MA: ${trimmedName}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { console.warn(`Versuch, existierenden MA hinzuzufügen: ${trimmedName}`); res.status(409).send(`Mitarbeiter '${trimmedName}' existiert bereits.`); }
    else { console.error("DB Fehler POST /admin/employees:", err); res.status(500).send('Serverfehler Hinzufügen MA.'); }
  }
});

// Admin: Mitarbeiterdaten aktualisieren
app.put('/admin/employees/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : ''; const employeeId = parseInt(id);
  if (isNaN(employeeId)) return res.status(400).send('Ungültige ID.');
  if (!trimmedName) return res.status(400).send('Name darf nicht leer sein.');
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
  let client;
  try {
      client = await db.connect(); await client.query('BEGIN');
      const oldNameResult = await client.query('SELECT name FROM employees WHERE id = $1', [employeeId]);
      if (oldNameResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); }
      const oldName = oldNameResult.rows[0].name; const newName = trimmedName;
      const updateQuery = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
      await client.query(updateQuery, [newName, ...hours, employeeId]);
      if (oldName && oldName !== newName) {
          console.log(`Update Namen in work_hours von '${oldName}' zu '${newName}'...`);
          const workHoursUpdateResult = await client.query(`UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`, [newName, oldName.toLowerCase()]);
          console.log(`${workHoursUpdateResult.rowCount} Einträge in work_hours aktualisiert.`);
      }
      await client.query('COMMIT');
      console.log(`Admin Update MA ID ${employeeId}. Alt: ${oldName}, Neu: ${newName}`);
      res.status(200).send('Mitarbeiterdaten aktualisiert.');
  } catch (err) {
      if (client) await client.query('ROLLBACK');
      if (err.code === '23505') { console.warn(`Namenskonflikt Update MA ID ${employeeId}: ${trimmedName}`); res.status(409).send(`Name '${trimmedName}' existiert bereits.`); }
      else { console.error(`DB Fehler PUT /admin/employees/${employeeId}:`, err); res.status(500).send('Serverfehler Update MA.'); }
  } finally { if (client) client.release(); }
});

// Admin: Mitarbeiter löschen
app.delete('/admin/employees/:id', isAdmin, async (req, res) => {
  const { id } = req.params; if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.'); const employeeId = parseInt(id);
  let client;
  try {
    client = await db.connect(); await client.query('BEGIN');
    const nameResult = await client.query('SELECT name FROM employees WHERE id = $1', [employeeId]);
    if (nameResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); }
    const employeeName = nameResult.rows[0].name; console.log(`Lösche MA ${employeeName} (ID: ${employeeId})...`);
    console.log(`Lösche Arbeitszeiten für ${employeeName}...`);
    const workHoursDeleteResult = await client.query('DELETE FROM work_hours WHERE LOWER(name) = LOWER($1)', [employeeName.toLowerCase()]);
    console.log(`${workHoursDeleteResult.rowCount} Arbeitszeiten gelöscht.`);
    console.log(`Lösche MA ${employeeName} (ID: ${employeeId}) und kaskadierende Daten...`);
    const result = await client.query('DELETE FROM employees WHERE id = $1', [employeeId]);
    await client.query('COMMIT');
    if (result.rowCount > 0) { console.log(`Admin Delete MA ID ${employeeId} (${employeeName}) OK.`); res.status(200).send('Mitarbeiter und Daten gelöscht.'); }
    else { console.warn(`MA ID ${employeeId} nicht gefunden beim Löschen.`); res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); }
  } catch (err) {
    if (client) await client.query('ROLLBACK'); console.error(`DB Fehler DELETE /admin/employees/${employeeId}:`, err);
    if (err.code === '23503') { res.status(409).send('FK Fehler: Abhängige Daten existieren.'); }
    else { res.status(500).send('Serverfehler Löschen MA.'); }
  } finally { if (client) client.release(); }
});
// === Auswertungen ===

// Admin: Monatsauswertung berechnen
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;
  if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
    return res.status(400).json({ message: "Ungültige Eingabe." });
  }
  try {
    const result = await calculateMonthlyData(db, name, year, month);
    console.log(`Admin Monatsauswertung: ${result.employeeName || name} (${month}/${year})`);
    res.json(result);
  } catch (err) {
    console.error(`Fehler /calc-monthly (Name: ${name}, ${month}/${year}):`, err);
    if (err.message.includes("nicht gefunden")) { res.status(404).json({ message: err.message }); }
    else { res.status(500).json({ message: `Serverfehler: ${err.message}` }); }
  }
});

// Admin: Periodenauswertung (Quartal/Jahr) berechnen
app.get('/calculate-period-balance', isAdmin, async (req, res) => {
  const { name, year, periodType, periodValue } = req.query;
  if (!name || !year || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
    return res.status(400).json({ message: "Ungültige Eingabe." });
  }
  if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
    return res.status(400).json({ message: "Ungültiges Quartal." });
  }
  if (isNaN(parseInt(year))) return res.status(400).json({ message: "Ungültiges Jahr." });
  try {
    const result = await calculatePeriodData(db, name, year, periodType.toUpperCase(), periodValue);
    console.log(`Admin Periodenauswertung: ${result.employeeName || name} (${year} ${result.periodIdentifier})`);
    res.json(result);
  } catch (err) {
    console.error(`Fehler /calc-period (Name: ${name}, ${year}, ${periodType}, ${periodValue}):`, err);
    if (err.message.includes("nicht gefunden")) { res.status(404).json({ message: err.message }); }
    else { res.status(500).json({ message: `Serverfehler: ${err.message}` }); }
  }
});
// === Abwesenheiten ===

// GET: Abwesenheiten für einen Mitarbeiter abrufen
app.get('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId } = req.query;
    if (!employeeId || isNaN(parseInt(employeeId))) {
        return res.status(400).json({ message: 'Gültige employeeId erforderlich.' });
    }
    const empIdInt = parseInt(employeeId);
    try {
        const query = `SELECT id, date, absence_type, credited_hours, comment FROM absences WHERE employee_id = $1 ORDER BY date DESC`;
        const result = await db.query(query, [empIdInt]);
        const formattedResult = result.rows.map(row => ({
            ...row, date: (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date)
        }));
        res.json(formattedResult);
    } catch (err) { console.error(`Fehler GET /admin/absences (ID: ${empIdInt}):`, err); res.status(500).json({ message: 'Serverfehler Laden Abw.' }); }
});

// POST: Neue Abwesenheit hinzufügen
app.post('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId, date, absenceType, comment } = req.body;
    if (!employeeId || isNaN(parseInt(employeeId)) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !absenceType) {
        return res.status(400).json({ message: 'Fehlende/ungültige Daten.' });
    }
    if (!['VACATION', 'SICK', 'PUBLIC_HOLIDAY'].includes(absenceType)) {
        return res.status(400).json({ message: 'Ungültiger absenceType.' });
    }
    const empIdInt = parseInt(employeeId);
    const targetDate = new Date(date + 'T00:00:00Z'); const dayOfWeek = targetDate.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) { return res.status(400).json({ message: 'Keine Abwesenheiten am Wochenende.' }); }

    // *** NEU: Prüfung auf Feiertag, falls Typ PUBLIC_HOLIDAY gewählt wurde ***
    if (absenceType === 'PUBLIC_HOLIDAY') {
        const isHoliday = hd.isHoliday(targetDate); // hd wurde oben initialisiert
        if (!isHoliday) {
             const formattedTargetDate = targetDate.toLocaleDateString('de-DE',{timeZone:'UTC'});
             console.warn(`Admin versucht ${formattedTargetDate} als Feiertag für MA ${empIdInt} zu buchen, aber isHoliday()=false.`);
             return res.status(400).json({ message: `Datum ${formattedTargetDate} ist laut System kein Feiertag in NRW.` });
        }
        // Optional: Feiertagsnamen als Kommentar hinzufügen, falls keiner gesetzt
        // if (!comment && isHoliday.name) {
        //     comment = isHoliday.name;
        // }
    }
    // *** ENDE Prüfung Feiertag ***

    let client;
    try {
        client = await db.connect();
        const empResult = await client.query('SELECT * FROM employees WHERE id = $1', [empIdInt]);
        if (empResult.rows.length === 0) return res.status(404).json({ message: `MA ID ${empIdInt} nicht gefunden.` });
        const employeeData = empResult.rows[0];
        const credited_hours = getExpectedHours(employeeData, date);
        if (credited_hours <= 0 && absenceType !== 'PUBLIC_HOLIDAY') {
            return res.status(400).json({ message: `Keine Soll-Std an diesem Tag (${targetDate.toLocaleDateString('de-DE', {weekday: 'long', timeZone:'UTC'})}). Abwesenheit nicht gebucht.` });
        }
        const finalCreditedHours = Math.max(0, credited_hours); // Für Feiertag an Tag ohne Soll => 0 Gutschrift

        const insertQuery = `INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id, date, absence_type, credited_hours, comment;`;
        const insertResult = await client.query(insertQuery, [empIdInt, date, absenceType, finalCreditedHours, comment || null]);
        const createdAbsence = { ...insertResult.rows[0], date: insertResult.rows[0].date.toISOString().split('T')[0], credited_hours: parseFloat(insertResult.rows[0].credited_hours) || 0 };
        console.log(`Admin Add Absence: MA ID ${empIdInt}, Date ${date}, Type ${absenceType}, Hours ${finalCreditedHours.toFixed(2)}`);
        res.status(201).json(createdAbsence);
    } catch (err) {
        if (err.code === '23505') { const fd = new Date(date+'T00:00:00Z').toLocaleDateString('de-DE',{timeZone:'UTC'}); res.status(409).json({ message: `Doppelter Eintrag am ${fd}.` }); }
        else if (err.code === '23503') { res.status(404).json({ message: `MA ID ${empIdInt} nicht gefunden (FK).`}); }
        else { console.error(`Fehler POST /admin/absences (MA ID: ${empIdInt}, Date: ${date}):`, err); res.status(500).json({ message: 'Serverfehler Hinzufügen Abw.' }); }
    } finally { if (client) client.release(); }
});

// DELETE: Abwesenheit löschen
app.delete('/admin/absences/:id', isAdmin, async (req, res) => {
    const { id } = req.params; if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.'); const absenceId = parseInt(id);
    try {
        const result = await db.query('DELETE FROM absences WHERE id = $1', [absenceId]);
        if (result.rowCount > 0) { console.log(`Admin Delete Absence ID ${absenceId}`); res.status(200).send('Abwesenheit gelöscht.'); }
        else { res.status(404).send(`Abwesenheit ID ${absenceId} nicht gefunden.`); }
    } catch (err) { console.error(`Fehler DELETE /admin/absences/${absenceId}:`, err); res.status(500).send('Serverfehler Löschen Abw.'); }
});
// *** NEUE ROUTE: Feiertage automatisch generieren ***
app.post('/admin/generate-holidays', isAdmin, async (req, res) => {
    const { year } = req.body;
    const currentYear = new Date().getFullYear();

    // Validierung des Jahres
    if (!year || isNaN(parseInt(year)) || year < currentYear - 5 || year > currentYear + 5) { // Erlaube Generierung für +/- 5 Jahre
        return res.status(400).json({ message: `Ungültiges oder fehlendes Jahr angegeben. Bitte ein Jahr zwischen ${currentYear - 5} und ${currentYear + 5} wählen.` });
    }
    const targetYear = parseInt(year);

    console.log(`Starte Generierung der Feiertage für NRW im Jahr ${targetYear}...`);
    let client; // Datenbank-Client für Transaktion
    let generatedCount = 0;
    let skippedCount = 0;
    let processedEmployees = 0;

    try {
        client = await db.connect(); // Verbindung für Transaktion holen
        await client.query('BEGIN'); // Transaktion starten

        // 1. Alle aktiven Mitarbeiter holen (inkl. ihrer Soll-Stunden)
        const empResult = await client.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name');
        const employees = empResult.rows;
        processedEmployees = employees.length;
        if (processedEmployees === 0) {
             await client.query('ROLLBACK'); // Keine Mitarbeiter, nichts zu tun
             return res.status(404).json({ message: "Keine Mitarbeiter gefunden, für die Feiertage generiert werden könnten." });
        }
        console.log(`   - ${processedEmployees} Mitarbeiter gefunden.`);

        // 2. Feiertage für NRW im Zieljahr holen
        const holidays = hd.getHolidays(targetYear); // hd wurde oben initialisiert
        console.log(`   - ${holidays.length} potenzielle Feiertage für ${targetYear} in NRW gefunden.`);

        // Query für das Einfügen vorbereiten (mit ON CONFLICT)
        const insertQuery = `
            INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment)
            VALUES ($1, $2, 'PUBLIC_HOLIDAY', $3, $4)
            ON CONFLICT (employee_id, date) DO NOTHING;
        `; // Wenn ein Eintrag für den Tag/MA schon existiert, passiert nichts

        // 3. Durch jeden Feiertag iterieren
        for (const holiday of holidays) {
            const holidayDate = new Date(holiday.date); // Datumsobjekt aus String erstellen
            const holidayDateString = holiday.date.split('T')[0]; // YYYY-MM-DD Format
            const dayOfWeek = holidayDate.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa

            // Überspringe Wochenenden (Sa/So)
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                console.log(`   - Überspringe Feiertag '${holiday.name}' am ${holidayDateString} (Wochenende).`);
                continue;
            }

            // 4. Durch jeden Mitarbeiter iterieren
            for (const employee of employees) {
                // Ermittle die Soll-Stunden des Mitarbeiters für diesen Wochentag
                const expectedHours = getExpectedHours(employee, holidayDateString);

                // Nur wenn der Mitarbeiter an diesem Tag normalerweise arbeiten würde (>0 Soll-Stunden)
                if (expectedHours > 0) {
                    // Versuche, den Eintrag einzufügen
                    const result = await client.query(insertQuery, [
                        employee.id,
                        holidayDateString,
                        expectedHours, // Gutschrift = Normale Soll-Stunden
                        holiday.name    // Name des Feiertags als Kommentar
                    ]);
                    if (result.rowCount > 0) {
                        generatedCount++; // Zähle erfolgreiche Einfügungen
                        // console.log(`   - Feiertag '${holiday.name}' für ${employee.name} am ${holidayDateString} hinzugefügt.`);
                    } else {
                        skippedCount++; // Zähle Einträge, die übersprungen wurden (wegen ON CONFLICT)
                         // console.log(`   - Feiertag '${holiday.name}' für ${employee.name} am ${holidayDateString} existierte bereits.`);
                    }
                } else {
                    // Mitarbeiter arbeitet an diesem Wochentag normalerweise nicht
                    // console.log(`   - Überspringe Feiertag '${holiday.name}' für ${employee.name} am ${holidayDateString} (keine Soll-Stunden).`);
                }
            }
        }

        await client.query('COMMIT'); // Transaktion erfolgreich abschließen
        console.log(`Feiertagsgenerierung für ${targetYear} abgeschlossen. ${generatedCount} Einträge erstellt, ${skippedCount} übersprungen (existierten bereits).`);
        res.status(200).json({
            message: `Feiertage für ${targetYear} erfolgreich generiert.`,
            generated: generatedCount,
            skipped: skippedCount,
            employees: processedEmployees
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Transaktion bei Fehler abbrechen
        console.error(`Fehler bei der Feiertagsgenerierung für Jahr ${targetYear}:`, err);
        res.status(500).json({ message: 'Serverfehler bei der Feiertagsgenerierung.' });
    } finally {
        if (client) client.release(); // Verbindung immer freigeben
    }
});
// *** ENDE NEUE ROUTE Feiertage generieren ***
// === PDF Router ===
// Stelle sicher, dass die calculationUtils korrekt übergeben werden
app.use('/api/pdf', monthlyPdfRouter(db)); // monthlyPdfRouter benötigt die DB-Verbindung
// === Server Start ===
app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (ADMIN_PASSWORD fehlt!)'}`);
  if(db && db.options) {
    console.log(` Datenbank verbunden: Host=${db.options.host || 'localhost'}, Port=${db.options.port || 5432}, DB=${db.options.database}`);
  } else {
      console.warn("!!! Datenbankverbindung scheint nicht initialisiert zu sein !!!");
  }
  console.log(` Feiertagsmodul initialisiert für: DE / NW`); // Hinweis auf Feiertagsmodul
  console.log(`=======================================================`);
});
