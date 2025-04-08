// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session); // Für PostgreSQL Session Store
const path = require('path');
const app = express();

// Vertraue dem Proxy (wichtig für Railway/Heroku etc.)
app.set('trust proxy', 1);

const port = process.env.PORT || 3000; // Port wird korrekt von Railway via env bezogen

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // Stellt Frontend-Dateien bereit

// PostgreSQL Datenbank einrichten
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL-Konfiguration für Produktion (z.B. Railway, Heroku)
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Session Store konfigurieren (Persistent mit PostgreSQL)
const sessionStore = new pgSession({
  pool : db,                // Bestehende DB-Pool-Instanz verwenden
  tableName : 'user_sessions', // Name der Session-Tabelle in der DB
  createTableIfMissing: true // Erstellt Tabelle automatisch
  // ttl: 1000 * 60 * 60 * 24 // Optional: Session-Lebensdauer in Sekunden (z.B. 1 Tag)
});

// Session-Middleware konfigurieren mit persistentem Store und sicheren Einstellungen
app.use(session({
  store: sessionStore, // Den PostgreSQL-Store verwenden
  secret: process.env.SESSION_SECRET || 'fallback-geheimnis-unbedingt-aendern', // Aus .env laden!
  resave: false,
  saveUninitialized: false, // Empfohlen: Keine Session ohne Login speichern
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Cookie nur über HTTPS senden (wenn in Produktion)
    sameSite: 'lax', // Guter Standardwert gegen CSRF
    httpOnly: true, // Verhindert Zugriff auf Cookie über clientseitiges JS
    // maxAge: ... // Optional: Lebensdauer des Cookies setzen
   }
}));

// --- Datenbank Tabellen Setup ---
// (Angepasst für bessere Fehlerbehandlung und Konsistenz)
const setupTables = async () => {
  try {
    // Session-Tabelle wird von connect-pg-simple automatisch erstellt (createTableIfMissing: true)
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY, 
        name TEXT NOT NULL, 
        date DATE NOT NULL,
        hours DOUBLE PRECISION, 
        break_time DOUBLE PRECISION, 
        comment TEXT,
        starttime TIME, 
        endtime TIME 
      );`);
    console.log("Tabelle work_hours erfolgreich geprüft/erstellt.");

    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY, 
        name TEXT NOT NULL UNIQUE, 
        mo_hours DOUBLE PRECISION,
        di_hours DOUBLE PRECISION, 
        mi_hours DOUBLE PRECISION, 
        do_hours DOUBLE PRECISION, 
        fr_hours DOUBLE PRECISION
      );`);
    console.log("Tabelle employees erfolgreich geprüft/erstellt.");

    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY, 
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        year_month DATE NOT NULL, 
        difference DOUBLE PRECISION, 
        carry_over DOUBLE PRECISION,
        UNIQUE (employee_id, year_month)
      );`);
    console.log("Tabelle monthly_balance erfolgreich geprüft/erstellt.");
  } catch (err) {
    console.error("!!! Kritischer Fehler beim Erstellen der Datenbanktabellen:", err);
    process.exit(1);
  }
};

// --- Middleware für Admin-Check ---
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    console.warn(`isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin Flag: ${req.session ? req.session.isAdmin : 'Session nicht vorhanden'}, Path: ${req.originalUrl}`);
    res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich.');
  }
}

// --------------------------
// Hilfsfunktionen für Zeitberechnung
// --------------------------
function parseTime(timeStr) { 
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':'); 
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}
function calculateWorkHours(startTime, endTime) { 
  if (!startTime || !endTime) return 0; 
  const startMinutes = parseTime(startTime); 
  const endMinutes = parseTime(endTime);
  if (endMinutes < startMinutes) { 
    console.warn("Arbeitsende liegt vor Arbeitsbeginn - Berechnung könnte falsch sein.");
  } 
  const diffInMin = endMinutes - startMinutes; 
  return diffInMin / 60;
}
function getExpectedHours(employeeData, dateStr) { 
  if (!employeeData || !dateStr) return 0; 
  const d = new Date(dateStr); 
  const day = d.getUTCDay();
  switch (day) { 
    case 1: return employeeData.mo_hours || 0; 
    case 2: return employeeData.di_hours || 0; 
    case 3: return employeeData.mi_hours || 0; 
    case 4: return employeeData.do_hours || 0; 
    case 5: return employeeData.fr_hours || 0; 
    default: return 0;
  } 
}

// Konvertiert DB-Daten in CSV
function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  csvRows.push([ "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Pause (Minuten)", "SollArbeitszeit", "IstArbeitszeit", "Differenz", "Bemerkung" ].join(','));
  for (const row of data) {
    let dateFormatted = "";
    if (row.date) { 
      try { 
        const dateObj = new Date(row.date); 
        const year = dateObj.getUTCFullYear();
        const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0'); 
        const day = String(dateObj.getUTCDate()).padStart(2, '0'); 
        dateFormatted = `${day}.${month}.${year}`;
      } catch (e) { 
        console.error("Fehler beim Formatieren des Datums für CSV:", row.date, e); 
        dateFormatted = row.date;
      }
    }
    const startTimeFormatted = row.starttime || ""; 
    const endTimeFormatted = row.endtime || "";
    const breakMinutes = row.break_time ? (row.break_time * 60).toFixed(0) : "0"; 
    const istHours = row.hours || 0;
    const expected = getExpectedHours(row, row.date);
    const diff = istHours - expected;
    const istFormatted = istHours.toFixed(2); 
    const expectedFormatted = expected.toFixed(2);
    const diffFormatted = diff.toFixed(2);
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
    const values = [ row.name, dateFormatted, startTimeFormatted, endTimeFormatted, breakMinutes, expectedFormatted, istFormatted, diffFormatted, commentFormatted ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

// ==========================================
// Health Check Endpunkt
// ==========================================
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// ==========================================
// Neuer Endpunkt: /current-open-entry
// Prüft, ob es für den angegebenen Mitarbeiter heute einen offenen Eintrag gibt
// ==========================================
app.get('/current-open-entry', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  try {
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') as "starttime"
      FROM work_hours
      WHERE LOWER(name) = LOWER($1)
        AND date = CURRENT_DATE
        AND endtime IS NULL
      ORDER BY id DESC
      LIMIT 1
    `;
    const result = await db.query(query, [name]);
    if (result.rows.length > 0) {
      return res.json(result.rows[0]);
    } else {
      return res.json(null);
    }
  } catch (err) {
    console.error("Fehler in /current-open-entry:", err);
    return res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// API Endpunkte für sofortiges Speichern
// ==========================================

// POST /log-start : Speichert den Arbeitsbeginn
app.post('/log-start', async (req, res) => {
  const { name, date, startTime } = req.body;
  if (!name || !date || !startTime) { 
    return res.status(400).json({ message: 'Name, Datum und Startzeit sind erforderlich.' });
  }

  try {
    // Prüfen, ob es bereits einen offenen Eintrag für diesen Mitarbeiter am angegebenen Datum gibt
    const checkQuery = `
      SELECT id FROM work_hours
      WHERE LOWER(name) = LOWER($1)
        AND date = $2
        AND endtime IS NULL
    `;
    const checkResult = await db.query(checkQuery, [name, date]);
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'Es existiert bereits ein offener Eintrag für diesen Tag.' });
    }

    const insertQuery = `
      INSERT INTO work_hours (name, date, starttime)
      VALUES ($1, $2, $3)
      RETURNING id;
    `;
    const result = await db.query(insertQuery, [name, date, startTime]);

    if (result.rows.length > 0) {
      const newEntryId = result.rows[0].id;
      console.log(`Arbeitsbeginn für ${name} am ${date} um ${startTime} gespeichert (ID: ${newEntryId}).`);
      return res.status(201).json({ id: newEntryId });
    } else {
      throw new Error("Eintrag konnte nicht erstellt werden, keine ID zurückgegeben.");
    }
  } catch (err) {
    console.error("Fehler beim Speichern des Arbeitsbeginns:", err);
    return res.status(500).json({
      message: 'Fehler beim Speichern des Arbeitsbeginns auf dem Server.'
    });
  }
});

// PUT /log-end/:id : Speichert das Arbeitsende, Pause und Kommentar für einen Eintrag
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, breakTime, comment } = req.body;
  if (!endTime) { return res.status(400).json({ message: 'Endzeit ist erforderlich.' }); }
  if (!id || isNaN(parseInt(id))) { return res.status(400).json({ message: 'Gültige Eintrags-ID ist erforderlich.' }); }
  const entryId = parseInt(id);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60.0;
  try {
    const timeResult = await db.query('SELECT starttime FROM work_hours WHERE id = $1', [entryId]);
    if (timeResult.rows.length === 0) { return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` }); }
    const startTime = timeResult.rows[0].starttime;
    const totalHours = calculateWorkHours(startTime, endTime);
    if (totalHours < 0) { return res.status(400).json({ message: 'Arbeitsende darf nicht vor Arbeitsbeginn liegen.' }); }
    const netHours = Math.max(0, totalHours - breakTimeHours);
    const updateQuery = `
      UPDATE work_hours 
      SET endtime = $1, break_time = $2, comment = $3, hours = $4 
      WHERE id = $5;
    `;
    await db.query(updateQuery, [endTime, breakTimeHours, comment, netHours, entryId]);
    console.log(`Arbeitsende für ID ${entryId} um ${endTime} gespeichert (Netto Std: ${netHours.toFixed(2)}).`);
    res.status(200).send('Arbeitsende erfolgreich gespeichert.');
  } catch (err) {
    console.error(`Fehler beim Speichern des Arbeitsendes für ID ${entryId}:`, err);
    res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsendes auf dem Server.' });
  }
});

// --------------------------
// Weitere API-Endpunkte zum Abrufen von Daten, Admin-Login, Mitarbeiterverwaltung, Monatsabschluss etc.
// (Unverändert aus deiner bisherigen Version)
// --------------------------

// GET /get-all-hours : Holt alle Stunden für einen Mitarbeiter
app.get('/get-all-hours', (req, res) => {
  const { name } = req.query;
  if (!name) { return res.status(400).send('Name ist erforderlich.'); }
  const query = `
    SELECT id, name, date, hours, break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime", 
           TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours 
    WHERE LOWER(name) = LOWER($1) 
    ORDER BY date ASC, starttime ASC;
  `;
  db.query(query, [name])
    .then(result => {
      const rowsWithMinutes = result.rows.map(row => ({
        ...row,
        break_time: Math.round((row.break_time || 0) * 60)
      }));
      res.json(rowsWithMinutes);
    })
    .catch(err => { 
      console.error("DB Fehler in /get-all-hours:", err); 
      res.status(500).send('Fehler beim Abrufen der Daten.');
    });
});

// GET /get-hours : Holt einen spezifischen Eintrag
app.get('/get-hours', (req, res) => {
  const { name, date } = req.query;
  const query = `
    SELECT id, name, date, hours, break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime", 
           TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours 
    WHERE LOWER(name) = LOWER($1) AND date = $2;
  `;
  db.query(query, [name, date])
    .then(result => {
      if (result.rows.length === 0) { return res.status(404).send('Keine Daten gefunden.'); }
      const rowWithMinutes = {
        ...result.rows[0],
        break_time: Math.round((result.rows[0].break_time || 0) * 60)
      };
      res.json(rowWithMinutes);
    })
    .catch(err => { 
      console.error("DB Fehler in /get-hours:", err); 
      res.status(500).send('Fehler beim Abrufen der Daten.');
    });
});

// GET /employees (Öffentlich für Dropdown)
app.get('/employees', (req, res) => {
  const query = 'SELECT id, name FROM employees ORDER BY name ASC';
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => { 
      console.error("DB Fehler in GET /employees:", err); 
      res.status(500).send('Fehler beim Abrufen der Mitarbeiter.');
    });
});

// Admin-Login
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
      console.error("FEHLER: ADMIN_PASSWORD ist nicht in den Umgebungsvariablen gesetzt!");
      return res.status(500).send("Server-Konfigurationsfehler.");
  }
  if (password && password === adminPassword) {
    req.session.isAdmin = true;
    req.session.save(err => {
      if (err) {
        console.error("Fehler beim Speichern der Session:", err);
        req.session.isAdmin = false;
        return res.status(500).send('Fehler bei der Serververarbeitung (Session).');
      }
      console.log("Admin-Login erfolgreich, Session gespeichert. isAdmin:", req.session.isAdmin);
      res.send('Admin erfolgreich angemeldet.');
    });
  } else {
    req.session.isAdmin = false;
    res.status(401).send('Ungültiges Passwort.');
  }
});

// Weitere Admin-Endpunkte (Arbeitszeiten, CSV-Download, Mitarbeiterverwaltung, Monatsabschluss, etc.) bleiben unverändert
// (Die restlichen Endpunkte sind wie in deiner aktuellen Version vorhanden)

// --- Hauptfunktion zum Starten des Servers ---
async function startServer() {
  try {
    await setupTables();
    console.log("Datenbank-Setup abgeschlossen.");

    if(!process.env.DATABASE_URL) { console.warn("WARNUNG: Kein DATABASE_URL in Umgebungsvariablen gefunden."); }
    if(!process.env.SESSION_SECRET) { console.warn("WARNUNG: Kein SESSION_SECRET in Umgebungsvariablen gefunden."); }
    if(!process.env.ADMIN_PASSWORD) { console.warn("WARNUNG: Kein ADMIN_PASSWORD in Umgebungsvariablen gefunden."); }
    if(process.env.NODE_ENV !== 'production') { console.warn("WARNUNG: Server läuft nicht im Produktionsmodus (NODE_ENV!=production)."); }

    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`Server läuft auf Port: ${port}`);
    });

    const gracefulShutdown = async (signal) => {
      console.log(`---> Graceful shutdown Funktion gestartet für Signal: ${signal}`);
      server.close(async (err) => {
        if (err) {
          console.error("Fehler beim Schließen des HTTP-Servers:", err);
        } else {
          console.log("HTTP-Server erfolgreich geschlossen.");
        }
        try {
          await db.end();
          console.log("Datenbank-Pool erfolgreich geschlossen.");
          console.log("Graceful shutdown abgeschlossen.");
          process.exit(err ? 1 : 0);
        } catch (dbErr) {
          console.error("Fehler beim Schließen des Datenbank-Pools:", dbErr);
          process.exit(1);
        }
      });
      setTimeout(() => {
        console.error("Graceful shutdown timed out nach 10 Sekunden. Forcing exit.");
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => {
       console.log(`---> SIGTERM Signal empfangen! Rufe gracefulShutdown auf...`);
       gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
       console.log(`---> SIGINT Signal empfangen! Rufe gracefulShutdown auf...`);
       gracefulShutdown('SIGINT');
    });
  } catch (error) {
    console.error("!!! Kritischer Fehler beim Starten des Servers:", error);
    process.exit(1);
  }
}

startServer();
