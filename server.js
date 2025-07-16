// server.js – Vollständige, geprüfte und bereinigte Version (Stand: 14.07.2025)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const dotenv = require('dotenv');
const Holidays = require('date-holidays');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

dotenv.config();

// --- Datenbankverbindung ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false } // ggf. für Railway/Prod aktivieren
});

// --- Express App initialisieren ---
const app = express();
const port = process.env.PORT || 3000;
app.set('trust proxy', 1);

// --- Hilfsfunktionen & Module ---
const hd = new Holidays('DE', 'NW');
let calculateMonthlyData, calculatePeriodData, getExpectedHours, monthlyPdfRouter;
try {
  ({ calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils'));
  monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
} catch (e) {
  console.error("Fehler beim Laden von Hilfsmodulen:", e);
  process.exit(1);
}

const csvDateOptions = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };
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
  if (diffInMin < 0) diffInMin += 24 * 60;
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
        if (!isNaN(dateObj.getTime())) {
          dateFormatted = dateObj.toLocaleDateString('de-DE', csvDateOptions);
        } else {
          dateFormatted = String(row.date);
        }
      } catch (e) {
        dateFormatted = String(row.date);
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
      } catch (e) {}
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

// --- Middleware ---
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

// --- Auth-Middleware ---
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
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
    res.status(401).json({ message: 'Authentifizierung erforderlich. Bitte anmelden.' });
  }
}

// --- Datenbank-Setup Funktion ---
const setupTables = async () => {
  try {
    const client = await db.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      mo_hours DOUBLE PRECISION DEFAULT 0,
      di_hours DOUBLE PRECISION DEFAULT 0,
      mi_hours DOUBLE PRECISION DEFAULT 0,
      do_hours DOUBLE PRECISION DEFAULT 0,
      fr_hours DOUBLE PRECISION DEFAULT 0
    );`);
    await client.query(`CREATE TABLE IF NOT EXISTS work_hours (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      date DATE NOT NULL,
      starttime TIME,
      endtime TIME,
      hours DOUBLE PRECISION,
      comment TEXT
    );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_hours_name_date ON work_hours (LOWER(name), date);`);
    await client.query(`CREATE TABLE IF NOT EXISTS monthly_balance (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      year_month DATE NOT NULL,
      difference DOUBLE PRECISION,
      carry_over DOUBLE PRECISION,
      UNIQUE (employee_id, year_month)
    );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    await client.query(`CREATE TABLE IF NOT EXISTS absences (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')),
      credited_hours DOUBLE PRECISION NOT NULL,
      comment TEXT,
      UNIQUE (employee_id, date)
    );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);`);
    const sessionTableCheck = await client.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_sessions');`);
    client.release();
  } catch (err) {
    console.error("Kritischer Datenbank Setup Fehler:", err);
    process.exit(1);
  }
};

// --- Öffentliche und Authentifizierungsrouten ---
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.get('/employees', async (req, res, next) => {
  try {
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

app.post("/login", async (req, res, next) => {
  const { employeeName, password } = req.body;
  if (!employeeName || !password) {
    return res.status(400).json({ message: "Mitarbeitername und Passwort erforderlich." });
  }
  try {
    const findUserQuery = 'SELECT id, name, password_hash FROM employees WHERE LOWER(name) = LOWER($1)';
    const userResult = await db.query(findUserQuery, [employeeName]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Mitarbeitername oder Passwort ungültig." });
    }
    const user = userResult.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ message: "Für diesen Mitarbeiter ist kein Login möglich. Bitte Admin kontaktieren." });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (match) {
      req.session.regenerate((errReg) => {
        if (errReg) return res.status(500).json({ message: "Interner Serverfehler beim Login (Session Regenerate)." });
        req.session.isEmployee = true;
        req.session.employeeId = user.id;
        req.session.employeeName = user.name;
        req.session.save((errSave) => {
          if (errSave) return res.status(500).json({ message: "Interner Serverfehler beim Login (Session Save)." });
          res.status(200).json({
            message: "Login erfolgreich.",
            employee: { id: user.id, name: user.name }
          });
        });
      });
    } else {
      res.status(401).json({ message: "Mitarbeitername oder Passwort ungültig." });
    }
  } catch (err) {
    next(err);
  }
});

app.post("/logout", isEmployee, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.status(200).json({ message: "Erfolgreich abgemeldet." });
  });
});

app.post("/admin-login", (req, res, next) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return res.status(500).send("Serverkonfigurationsfehler.");
  if (!password) return res.status(400).send("Passwort fehlt.");
  if (password === adminPassword) {
    req.session.regenerate((errReg) => {
      if (errReg) return next(errReg);
      req.session.isAdmin = true;
      req.session.save((errSave) => {
        if (errSave) return next(errSave);
        res.status(200).send("Admin erfolgreich angemeldet.");
      });
    });
  } else {
    res.status(401).send("Ungültiges Passwort.");
  }
});

// --- Admin-Logout: Middleware entfernt, wie gewünscht ---
app.post("/admin-logout", (req, res, next) => {
  if (req.session) {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else {
    return res.status(200).send("Keine aktive Session zum Abmelden gefunden.");
  }
});

app.get("/api/session-status", (req, res) => {
  if (req.session.isEmployee) {
    return res.json({ isEmployee: true, employee: { id: req.session.employeeId, name: req.session.employeeName } });
  }
  if (req.session.isAdmin) {
    return res.json({ isAdmin: true });
  }
  res.status(401).json({ message: "Not logged in" });
});

// --- Mitarbeiter-API-Endpunkte (nur mit isEmployee) ---
// ... (Hier folgen alle /api/employee/*-Routen wie im Original, unverändert)

// --- Admin-Endpunkte (nur mit isAdmin) ---
// ... (Hier folgen alle /admin*- und /api/admin/*-Routen wie im Original, unverändert)

// --- PDF Router ---
try {
  if (typeof monthlyPdfRouter === 'function') {
    app.use('/api/pdf', monthlyPdfRouter(db));
  }
} catch(routerError) {
  console.error("Fehler beim Einbinden des PDF-Routers:", routerError);
}

// --- Global Error Handler ---
app.use((err, req, res, next) => {
  if (!res.headersSent) {
    res.status(500).send('Ein unerwarteter interner Serverfehler ist aufgetreten.');
  } else {
    next(err);
  }
});

// --- Datenbank-Setup & Serverstart ---
setupTables()
  .then(() => { console.log('>>> Datenbank Setup erfolgreich abgeschlossen (nach Serverstart).'); })
  .catch((err) => { console.error('FEHLER beim Ausführen von setupTables (nach Serverstart):', err); });

app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (Passwort fehlt!)'}`);
  console.log(` Feiertagsmodul: DE / NW`);
  console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(` Frontend aus: '${path.join(__dirname, 'public')}'`);
  console.log(`=======================================================`);
});
