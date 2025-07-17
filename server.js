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
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    maxAge: 1000 * 60 * 3, // 3 Minuten Session-Timeout
    httpOnly: true, 
    sameSite: 'lax' 
  }
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
app.post("/admin-logout", isAdmin, (req, res, next) => {
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

// --- Heartbeat Endpoint für Auto-Logout ---
app.post("/api/heartbeat", (req, res) => {
  if (req.session && (req.session.isEmployee || req.session.isAdmin)) {
    // Session ist gültig - erneuere sie
    req.session.touch(); // Setzt lastAccess auf aktuellen Zeitpunkt
    res.status(200).json({ 
      status: 'alive',
      isEmployee: !!req.session.isEmployee,
      isAdmin: !!req.session.isAdmin,
      employeeName: req.session.employeeName || null
    });
  } else {
    // Session ungültig
    res.status(401).json({ status: 'expired' });
  }
});

// --- Mitarbeiter-API-Endpunkte (nur mit isEmployee) ---

// GET /api/employee/next-booking-details - Prüft nächste Buchungsaktion
app.get('/api/employee/next-booking-details', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    
    // Prüfe auf offenen Eintrag (starttime vorhanden, aber endtime fehlt)
    const openEntryQuery = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') as startTime
      FROM work_hours 
      WHERE LOWER(name) = LOWER($1) 
        AND starttime IS NOT NULL 
        AND endtime IS NULL
      ORDER BY date DESC, starttime DESC 
      LIMIT 1
    `;
    
    const openEntryResult = await db.query(openEntryQuery, [employeeName]);
    
    if (openEntryResult.rows.length > 0) {
      // Es gibt einen offenen Eintrag -> Arbeitsende buchen
      const openEntry = openEntryResult.rows[0];
      
      // Datum als String formatieren (YYYY-MM-DD)
      let startDateStr = openEntry.date;
      if (openEntry.date instanceof Date) {
        startDateStr = openEntry.date.toISOString().split('T')[0];
      } else if (typeof openEntry.date === 'string') {
        startDateStr = openEntry.date.split('T')[0];
      }
      
      res.json({
        nextBooking: 'arbeitsende',
        id: openEntry.id,
        startDate: startDateStr,
        startTime: openEntry.starttime
      });
    } else {
      // Kein offener Eintrag -> Arbeitsbeginn buchen
      res.json({
        nextBooking: 'arbeitsbeginn'
      });
    }
  } catch (err) {
    console.error('Fehler bei next-booking-details:', err);
    next(err);
  }
});

// POST /api/employee/log-start - Startet Arbeitszeit
app.post('/api/employee/log-start', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const { date, startTime } = req.body;
    
    if (!date || !startTime) {
      return res.status(400).json({ message: 'Datum und Startzeit sind erforderlich.' });
    }
    
    // Prüfe ob bereits ein offener Eintrag für heute existiert
    const existingQuery = `
      SELECT id FROM work_hours 
      WHERE LOWER(name) = LOWER($1) 
        AND date = $2 
        AND starttime IS NOT NULL 
        AND endtime IS NULL
    `;
    const existingResult = await db.query(existingQuery, [employeeName, date]);
    
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ message: 'Es existiert bereits ein offener Arbeitsbeginn für heute.' });
    }
    
    // Neuen Eintrag erstellen
    const insertQuery = `
      INSERT INTO work_hours (name, date, starttime) 
      VALUES ($1, $2, $3) 
      RETURNING id
    `;
    const insertResult = await db.query(insertQuery, [employeeName, date, startTime]);
    
    res.status(201).json({
      message: 'Arbeitsbeginn erfolgreich gebucht.',
      id: insertResult.rows[0].id
    });
  } catch (err) {
    console.error('Fehler bei log-start:', err);
    next(err);
  }
});

// PUT /api/employee/log-end/:id - Beendet Arbeitszeit
app.put('/api/employee/log-end/:id', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const entryId = req.params.id;
    const { endTime, comment } = req.body;
    
    if (!endTime) {
      return res.status(400).json({ message: 'Endzeit ist erforderlich.' });
    }
    
    // Prüfe ob der Eintrag existiert und dem Mitarbeiter gehört
    const checkQuery = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') as starttime
      FROM work_hours 
      WHERE id = $1 
        AND LOWER(name) = LOWER($2)
        AND starttime IS NOT NULL 
        AND endtime IS NULL
    `;
    const checkResult = await db.query(checkQuery, [entryId, employeeName]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ message: 'Offener Arbeitseintrag nicht gefunden oder gehört nicht zu diesem Mitarbeiter.' });
    }
    
    const entry = checkResult.rows[0];
    const hours = calculateWorkHours(entry.starttime, endTime);
    
    // Eintrag aktualisieren
    const updateQuery = `
      UPDATE work_hours 
      SET endtime = $1, hours = $2, comment = $3
      WHERE id = $4
      RETURNING id
    `;
    await db.query(updateQuery, [endTime, hours, comment || null, entryId]);
    
    res.json({
      message: 'Arbeitsende erfolgreich gebucht.',
      hours: hours
    });
  } catch (err) {
    console.error('Fehler bei log-end:', err);
    next(err);
  }
});

// GET /api/employee/summary-hours - Zeigt Tages- und Monatsübersicht
app.get('/api/employee/summary-hours', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ message: 'Datum ist erforderlich.' });
    }
    
    // Tagesstunden berechnen
    const dailyQuery = `
      SELECT COALESCE(SUM(hours), 0) as daily_hours
      FROM work_hours 
      WHERE LOWER(name) = LOWER($1) 
        AND date = $2
        AND hours IS NOT NULL
    `;
    const dailyResult = await db.query(dailyQuery, [employeeName, date]);
    const dailyHours = parseFloat(dailyResult.rows[0].daily_hours) || 0;
    
    // Monatsstunden berechnen
    const dateObj = new Date(date + 'T00:00:00Z');
    const year = dateObj.getUTCFullYear();
    const month = dateObj.getUTCMonth() + 1;
    
    const monthlyQuery = `
      SELECT COALESCE(SUM(hours), 0) as monthly_hours
      FROM work_hours 
      WHERE LOWER(name) = LOWER($1) 
        AND EXTRACT(YEAR FROM date) = $2
        AND EXTRACT(MONTH FROM date) = $3
        AND hours IS NOT NULL
    `;
    const monthlyResult = await db.query(monthlyQuery, [employeeName, year, month]);
    const monthlyHours = parseFloat(monthlyResult.rows[0].monthly_hours) || 0;
    
    res.json({
      dailyHours: dailyHours,
      monthlyHours: monthlyHours
    });
  } catch (err) {
    console.error('Fehler bei summary-hours:', err);
    next(err);
  }
});

// --- Admin-Endpunkte (nur mit isAdmin) ---
app.get('/admin-work-hours', isAdmin, async (req, res, next) => {
  try {
    const { year, month, employeeId } = req.query;
    if (!year || !month) {
      return res.status(400).json({ message: 'Jahr und Monat sind erforderlich.' });
    }

    let query = `
      SELECT w.id, e.name, w.date, w.hours, w.comment,
             TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
             TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
      FROM work_hours w
      JOIN employees e ON LOWER(w.name) = LOWER(e.name)
      WHERE EXTRACT(YEAR FROM w.date) = $1 AND EXTRACT(MONTH FROM w.date) = $2
    `;
    const params = [year, month];

    if (employeeId && employeeId !== 'all') {
      query += ' AND e.id = $3';
      params.push(employeeId);
    }

    query += ' ORDER BY w.date ASC, e.name ASC';

    const { rows } = await db.query(query, params);
    
    // Datum als String formatieren für jede Zeile
    const formattedRows = rows.map(row => ({
      ...row,
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : (typeof row.date === 'string' ? row.date.split('T')[0] : row.date)
    }));
    
    res.json(formattedRows);
  } catch (err) {
    next(err);
  }
});

app.get('/admin/employees', isAdmin, async (req, res, next) => {
    try {
        const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

app.post('/admin/employees', isAdmin, async (req, res, next) => {
    try {
        const { name, password, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
        const password_hash = await bcrypt.hash(password, 10);
        const result = await db.query(
            'INSERT INTO employees (name, password_hash, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [name, password_hash, mo_hours, di_hours, mi_hours, do_hours, fr_hours]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(409).send('Ein Mitarbeiter mit diesem Namen existiert bereits.');
        }
        next(err);
    }
});

app.put('/admin/employees/:id', isAdmin, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, newPassword, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
        let password_hash;
        if (newPassword) {
            password_hash = await bcrypt.hash(newPassword, 10);
        }

        const currentEmployee = await db.query('SELECT password_hash FROM employees WHERE id = $1', [id]);

        const result = await db.query(
            `UPDATE employees SET name = $1, password_hash = $2, mo_hours = $3, di_hours = $4, mi_hours = $5, do_hours = $6, fr_hours = $7 WHERE id = $8 RETURNING *`,
            [name, newPassword ? password_hash : currentEmployee.rows[0].password_hash, mo_hours, di_hours, mi_hours, do_hours, fr_hours, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(409).send('Ein anderer Mitarbeiter mit diesem Namen existiert bereits.');
        }
        next(err);
    }
});

app.delete('/admin/employees/:id', isAdmin, async (req, res, next) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM employees WHERE id = $1', [id]);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

app.get('/admin/absences', isAdmin, async (req, res, next) => {
    try {
        const { employeeId } = req.query;
        const result = await db.query('SELECT * FROM absences WHERE employee_id = $1 ORDER BY date DESC', [employeeId]);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

app.post('/admin/absences', isAdmin, async (req, res, next) => {
    try {
        const { employeeId, date, absenceType, comment } = req.body;
        const employee = await db.query('SELECT * FROM employees WHERE id = $1', [employeeId]);
        if (employee.rows.length === 0) {
            return res.status(404).json({ message: 'Mitarbeiter nicht gefunden.' });
        }
        const credited_hours = getExpectedHours(employee.rows[0], date);
        const result = await db.query(
            'INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [employeeId, date, absenceType, credited_hours, comment]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(409).json({ message: 'Für diesen Tag existiert bereits ein Abwesenheitseintrag.' });
        }
        next(err);
    }
});

app.delete('/admin/absences/:id', isAdmin, async (req, res, next) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM absences WHERE id = $1', [id]);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

app.post('/admin/generate-holidays', isAdmin, async (req, res, next) => {
    try {
        const { year } = req.body;
        const holidays = new Holidays('DE', 'NW');
        const allHolidays = holidays.getHolidays(year);
        const employees = await db.query('SELECT * FROM employees');
        let generated = 0;
        let skipped = 0;

        for (const employee of employees.rows) {
            for (const holiday of allHolidays) {
                const date = new Date(holiday.date);
                const dayOfWeek = date.getDay();
                if (dayOfWeek > 0 && dayOfWeek < 6) { // Monday to Friday
                    const expectedHours = getExpectedHours(employee, holiday.date);
                    if (expectedHours > 0) {
                        try {
                            await db.query(
                                'INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5)',
                                [employee.id, holiday.date, 'PUBLIC_HOLIDAY', expectedHours, holiday.name]
                            );
                            generated++;
                        } catch (err) {
                            if (err.code === '23505') { // Unique violation
                                skipped++;
                            } else {
                                throw err;
                            }
                        }
                    }
                }
            }
        }
        res.json({ message: `Feiertage für ${year} generiert.`, generated, skipped, employees: employees.rows.length });
    } catch (err) {
        next(err);
    }
});

app.delete('/admin/delete-public-holidays', isAdmin, async (req, res, next) => {
    try {
        const result = await db.query("DELETE FROM absences WHERE absence_type = 'PUBLIC_HOLIDAY'");
        res.json({ message: `${result.rowCount} Feiertagseinträge gelöscht.` });
    } catch (err) {
        next(err);
    }
});

app.get('/calculate-monthly-balance', isAdmin, async (req, res, next) => {
    try {
        const { name, year, month } = req.query;
        const data = await calculateMonthlyData(db, name, year, month);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

app.get('/calculate-period-balance', isAdmin, async (req, res, next) => {
    try {
        const { name, year, periodType, periodValue } = req.query;
        const data = await calculatePeriodData(db, name, year, periodType, periodValue);
        res.json(data);
    } catch (err) {
        next(err);
    }
});

app.put('/api/admin/update-hours', isAdmin, async (req, res, next) => {
    try {
        const { id, date, startTime, endTime, comment } = req.body;
        const hours = calculateWorkHours(startTime, endTime);
        const result = await db.query(
            'UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6 RETURNING *',
            [date, startTime, endTime, hours, comment, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res, next) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM work_hours WHERE id = $1', [id]);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

app.delete('/adminDeleteData', isAdmin, async (req, res, next) => {
    try {
        await db.query('DELETE FROM work_hours');
        await db.query('DELETE FROM monthly_balance');
        await db.query('DELETE FROM absences');
        res.send('Alle Arbeits-, Bilanz- und Abwesenheitsdaten wurden gelöscht.');
    } catch (err) {
        next(err);
    }
});

app.get('/admin-download-csv', isAdmin, async (req, res, next) => {
    try {
        const { year, month, employeeId } = req.query;
        let query = `
            SELECT w.id, e.name, w.date, w.hours, w.comment,
                   TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
                   TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
            FROM work_hours w
            JOIN employees e ON LOWER(w.name) = LOWER(e.name)
        `;
        const params = [];
        const whereClauses = [];

        if (year && month) {
            whereClauses.push(`EXTRACT(YEAR FROM w.date) = ${params.length + 1} AND EXTRACT(MONTH FROM w.date) = ${params.length + 2}`);
            params.push(year, month);
        }

        if (employeeId && employeeId !== 'all') {
            whereClauses.push(`e.id = ${params.length + 1}`);
            params.push(employeeId);
        }

        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }

        query += ' ORDER BY w.date ASC, e.name ASC';

        const { rows } = await db.query(query, params);
        const csv = await convertToCSV(db, rows);

        res.header('Content-Type', 'text/csv');
        res.attachment('work_hours.csv');
        res.send(csv);
    } catch (err) {
        next(err);
    }
});

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
