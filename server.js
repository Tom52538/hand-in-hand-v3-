// server.js - Erneut geprüfte Version (Schritt 1 + Schritt 2 Backend + Korr. Start)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const dotenv = require('dotenv');
const Holidays = require('date-holidays');
const { Pool } = require('pg');
const bcrypt = require('bcrypt'); // Für Passwort-Hashing

dotenv.config();

// Datenbankverbindung herstellen
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { // Ggf. für lokale Entwicklung oder bestimmte Hoster anpassen
  //   rejectUnauthorized: false
  // }
});

// Datenbankverbindung testen (nur beim Start)
db.connect((err, client, release) => {
  if (err) {
    // Nur loggen, nicht beenden, da setupTables es erneut versucht
    console.error('!!! Fehler beim ersten Verbindungsversuch mit der Datenbank (wird im Setup erneut versucht):', err.stack);
  } else {
    console.log('>>> Datenbank beim ersten Test erfolgreich verbunden.');
    release();
  }
});

// Express App initialisieren
const app = express();
const port = process.env.PORT || 3000;

// Express anweisen, dem Proxy zu vertrauen
app.set('trust proxy', 1);

// Globale Variablen und Hilfsfunktionen
const hd = new Holidays('DE', 'NW');
let calculateMonthlyData, calculatePeriodData, getExpectedHours, monthlyPdfRouter;
try {
  ({ calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils'));
  monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
} catch (e) {
  console.error("!!! FEHLER beim Laden von Hilfsmodulen (calculationUtils / monthlyPdfEndpoint):", e);
  console.error("!!! Stellen Sie sicher, dass die Dateien './utils/calculationUtils.js' und './routes/monthlyPdfEndpoint.js' existieren und korrekt exportieren.");
  process.exit(1);
}

const csvDateOptions = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };

function parseTime(timeStr) { if (!timeStr || !timeStr.includes(':')) return 0; const [hh, mm] = timeStr.split(':'); return parseInt(hh, 10) * 60 + parseInt(mm, 10); }
function calculateWorkHours(startTime, endTime) { if (!startTime || !endTime) return 0; const startMinutes = parseTime(startTime); const endMinutes = parseTime(endTime); let diffInMin = endMinutes - startMinutes; if (diffInMin < 0) { diffInMin += 24 * 60; } return diffInMin / 60; }
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
        if (!isNaN(dateObj.getTime())) {
          dateFormatted = dateObj.toLocaleDateString('de-DE', csvDateOptions);
        } else {
          dateFormatted = String(row.date);
        }
      } catch (e) {
        dateFormatted = String(row.date);
        console.warn("Fehler bei CSV-Datumsformatierung:", row.date, e);
      }
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
      } catch (e) {
        console.error(`Fehler Soll-Std CSV (MA: ${row.name}, D: ${dateForCalc}):`, e);
      }
    }
    const diffHours = istHours - expectedHours;
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
    const values = [
      row.id,
      row.name,
      dateFormatted,
      startTimeFormatted,
      endTimeFormatted,
      istHours.toFixed(2),
      expectedHours.toFixed(2),
      diffHours.toFixed(2),
      commentFormatted
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

// Middleware konfigurieren
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  store: new pgSession({ pool: db, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-secret-fuer-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24, httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// AUTHENTIFIZIERUNGS-MIDDLEWARE
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    console.warn(`isAdmin Check FAILED für Session ID: ${req.sessionID} - URL: ${req.originalUrl} von IP ${req.ip}`);
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/admin')) {
      res.status(403).json({ message: 'Zugriff verweigert. Admin-Login erforderlich.' });
    } else {
      res.redirect('/');
    }
  }
}
function isEmployee(req, res, next) {
  if (req.session && req.session.isEmployee === true && req.session.employeeId) {
    next();
  } else {
    console.warn(`isEmployee Check FAILED für Session ID: ${req.sessionID} - URL: ${req.originalUrl} von IP ${req.ip}`);
    res.status(401).json({ message: 'Authentifizierung erforderlich. Bitte anmelden.' });
  }
}

// ... (Restliche Setup- und Datenbank-Initialisierung bleibt wie im Anhang)

// ==========================================
// ÖFFENTLICHE/AUTHENTIFIZIERUNGS-ROUTEN
// ==========================================

app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ... (andere öffentliche Routen wie /employees, /login, /logout, /admin-login bleiben wie gehabt)

// --- HIER DIE ANGEPASSTE ADMIN-LOGOUT-ROUTE ---
app.post("/admin-logout", (req, res, next) => {
  if (req.session) {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
      if (err) {
        console.error("Fehler beim Zerstören der Session:", err);
        return next(err);
      }
      res.clearCookie('connect.sid');
      console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else {
    return res.status(200).send("Keine aktive Session zum Abmelden gefunden.");
  }
});
// --- ENDE DER ANGEPASSTEN ROUTE ---

// ... (alle weiteren API- und Admin-Endpunkte, CSV, PDF, Error-Handler, Serverstart etc. wie im Anhang)

// --- Global Error Handler ---
app.use((err, req, res, next) => {
  console.error("!!! UNHANDLED ERROR Caught by Global Handler !!!");
  console.error(`Route: ${req.method} ${req.originalUrl}`);
  if (err instanceof Error) {
    console.error("Error Stack:", err.stack);
  } else {
    console.error("Error:", err);
  }
  if (!res.headersSent) {
    res.status(500).send('Ein unerwarteter interner Serverfehler ist aufgetreten.');
  } else {
    next(err);
  }
});

// --- Datenbank-Setup ausführen (parallel zum Server-Start) ---
setupTables()
  .then(() => { console.log('>>> Datenbank Setup erfolgreich abgeschlossen (nach Serverstart).'); })
  .catch((err) => { console.error('!!! FEHLER beim Ausführen von setupTables (nach Serverstart):', err); });

// --- Server Start (Sofort) ---
app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (Passwort fehlt!)'}`);
  if(db && typeof db.options === 'object') {
    const host = process.env.PGHOST || db.options.host || '??';
    const portNum = process.env.PGPORT || db.options.port || '??';
    const database = process.env.PGDATABASE || db.options.database || '??';
    console.log(` Datenbank verbunden (Pool erstellt): Host=${host}, Port=${portNum}, DB=${database}`);
  } else if (db) {
    console.warn("!!! DB Pool Objekt 'db' existiert, aber Status unklar.");
  } else {
    console.error("!!! KRITISCH: DB Pool ('db') konnte nicht initialisiert werden!");
  }
  console.log(` Feiertagsmodul: DE / NW`);
  console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(` Frontend aus: '${path.join(__dirname, 'public')}'`);
  console.log(` Trust Proxy Setting: ${app.get('trust proxy')}`);
  let sessionCookieSecure = process.env.NODE_ENV === 'production';
  let sessionCookieSameSite = 'lax';
  try {
    if (app.settings && app.settings.session && typeof app.settings.session.cookie === 'object' && app.settings.session.cookie !== null) {
      if (app.settings.session.cookie.hasOwnProperty('secure')) {
        sessionCookieSecure = app.settings.session.cookie.secure;
      }
      if (app.settings.session.cookie.hasOwnProperty('sameSite')) {
        sessionCookieSameSite = app.settings.session.cookie.sameSite;
      }
    }
  } catch (e) {
    console.warn("Warnung: Konnte Session-Cookie-Details nicht vollständig lesen.", e.message);
  }
  console.log(` Session Cookie Settings: secure=${sessionCookieSecure}, sameSite='${sessionCookieSameSite}'`);
  console.log(`=======================================================`);
});
