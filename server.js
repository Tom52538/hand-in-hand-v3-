// server.js – Complete version with dynamic session timeouts and strict daily validation (Updated: 17.07.2025)

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

// --- Database Connection ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false } // Enable for Railway/Prod if needed
});

// --- Express App Initialization ---
const app = express();
const port = process.env.PORT || 3000;
app.set('trust proxy', 1);

// --- Helper Functions & Modules ---
const hd = new Holidays('DE', 'NW');
let calculateMonthlyData, calculatePeriodData, getExpectedHours, monthlyPdfRouter;
try {
  ({ calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils'));
  monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
} catch (e) {
  console.error("Error loading helper modules:", e);
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
    console.error("Error fetching employee data for CSV target hours:", e);
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

// --- UPDATED: Dynamic Session Configuration ---
app.use(session({
  store: new pgSession({ pool: db, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-secret-fuer-dev',
  resave: false,
  saveUninitialized: false,
  rolling: true, // Enable rolling sessions - important for dynamic timeouts
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    maxAge: 1000 * 60 * 3, // Default: 3 minutes (will be overridden dynamically)
    httpOnly: true, 
    sameSite: 'lax' 
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Middleware ---
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/admin')) {
      res.status(403).json({ message: 'Access denied. Admin login required.' });
    } else {
      res.redirect('/');
    }
  }
}
function isEmployee(req, res, next) {
  if (req.session && req.session.isEmployee === true && req.session.employeeId) {
    next();
  } else {
    res.status(401).json({ message: 'Authentication required. Please log in.' });
  }
}

// --- Database Setup Function ---
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
    console.error("Critical database setup error:", err);
    process.exit(1);
  }
};

// --- Public and Authentication Routes ---
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
    return res.status(400).json({ message: "Employee name and password required." });
  }
  try {
    const findUserQuery = 'SELECT id, name, password_hash FROM employees WHERE LOWER(name) = LOWER($1)';
    const userResult = await db.query(findUserQuery, [employeeName]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid employee name or password." });
    }
    const user = userResult.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ message: "Login not possible for this employee. Please contact admin." });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (match) {
      req.session.regenerate((errReg) => {
        if (errReg) return res.status(500).json({ message: "Internal server error during login (Session Regenerate)." });
        req.session.isEmployee = true;
        req.session.employeeId = user.id;
        req.session.employeeName = user.name;
        
        // UPDATED: Set dynamic session timeout for employees (3 minutes)
        req.session.cookie.maxAge = 1000 * 60 * 3; // 3 minutes for employees
        
        req.session.save((errSave) => {
          if (errSave) return res.status(500).json({ message: "Internal server error during login (Session Save)." });
          res.status(200).json({
            message: "Login successful.",
            employee: { id: user.id, name: user.name }
          });
        });
      });
    } else {
      res.status(401).json({ message: "Invalid employee name or password." });
    }
  } catch (err) {
    next(err);
  }
});

app.post("/logout", isEmployee, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.status(200).json({ message: "Successfully logged out." });
  });
});

app.post("/admin-login", (req, res, next) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return res.status(500).send("Server configuration error.");
  if (!password) return res.status(400).send("Password missing.");
  if (password === adminPassword) {
    req.session.regenerate((errReg) => {
      if (errReg) return next(errReg);
      req.session.isAdmin = true;
      
      // UPDATED: Set dynamic session timeout for admin (30 minutes)
      req.session.cookie.maxAge = 1000 * 60 * 30; // 30 minutes for admin
      
      req.session.save((errSave) => {
        if (errSave) return next(errSave);
        res.status(200).send("Admin successfully logged in.");
      });
    });
  } else {
    res.status(401).send("Invalid password.");
  }
});

app.post("/admin-logout", isAdmin, (req, res, next) => {
  if (req.session) {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      return res.status(200).send("Successfully logged out.");
    });
  } else {
    return res.status(200).send("No active session found to log out.");
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

// --- UPDATED: Enhanced Heartbeat Endpoint with Dynamic Timeout Renewal ---
app.post("/api/heartbeat", (req, res) => {
  if (req.session && (req.session.isEmployee || req.session.isAdmin)) {
    // UPDATED: Dynamically renew session with correct timeout based on role
    if (req.session.isAdmin) {
      req.session.cookie.maxAge = 1000 * 60 * 30; // Admin: 30 minutes
    } else if (req.session.isEmployee) {
      req.session.cookie.maxAge = 1000 * 60 * 3;  // Employee: 3 minutes
    }
    
    // Refresh session activity
    req.session.touch();
    
    res.status(200).json({ 
      status: 'alive',
      isEmployee: !!req.session.isEmployee,
      isAdmin: !!req.session.isAdmin,
      employeeName: req.session.employeeName || null,
      // UPDATED: Send timeout info to frontend for dynamic heartbeat intervals
      sessionTimeout: req.session.cookie.maxAge,
      heartbeatInterval: req.session.isAdmin ? 300000 : 90000 // Admin: 5min, Employee: 90sec
    });
  } else {
    // Session invalid
    res.status(401).json({ status: 'expired' });
  }
});

// --- Employee API Endpoints (with isEmployee middleware) ---

// GET /api/employee/next-booking-details - Check next booking action
app.get('/api/employee/next-booking-details', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    
    // Check for open entry (starttime present but endtime missing)
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
      // Open entry exists -> book work end
      const openEntry = openEntryResult.rows[0];
      
      // Format date as string (YYYY-MM-DD)
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
      // No open entry -> book work start
      res.json({
        nextBooking: 'arbeitsbeginn'
      });
    }
  } catch (err) {
    console.error('Error in next-booking-details:', err);
    next(err);
  }
});

// POST /api/employee/log-start - Start work time with STRICT DAILY VALIDATION
app.post('/api/employee/log-start', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const { date, startTime } = req.body;
    
    if (!date || !startTime) {
      return res.status(400).json({ message: 'Date and start time are required.' });
    }
    
    // STRICT VALIDATION: Check for ANY existing entries on the same day
    const dailyValidationQuery = `
      SELECT id, TO_CHAR(starttime, 'HH24:MI') as starttime, 
             TO_CHAR(endtime, 'HH24:MI') as endtime,
             hours
      FROM work_hours 
      WHERE LOWER(name) = LOWER($1) AND date = $2
      ORDER BY starttime ASC
    `;
    
    const dailyEntries = await db.query(dailyValidationQuery, [employeeName, date]);
    
    if (dailyEntries.rows.length > 0) {
      // Check for complete entries (both start and end time)
      const completeEntries = dailyEntries.rows.filter(entry => entry.endtime);
      const openEntries = dailyEntries.rows.filter(entry => !entry.endtime);
      
      if (completeEntries.length > 0) {
        // Complete entry exists - STRICT RULE: Only one work period per day
        const completeEntry = completeEntries[0];
        const formattedDate = new Date(date + 'T00:00:00Z').toLocaleDateString('de-DE');
        return res.status(409).json({ 
          message: `🚫 Arbeitszeit für ${formattedDate} bereits vollständig erfasst (${completeEntry.starttime} - ${completeEntry.endtime}, ${parseFloat(completeEntry.hours || 0).toFixed(2)} Std.). Neue Buchung nicht möglich.\n\n💡 Bei Korrekturen wenden Sie sich an den Administrator.`,
          errorType: 'DAILY_LIMIT_REACHED',
          existingEntry: {
            startTime: completeEntry.starttime,
            endTime: completeEntry.endtime,
            hours: completeEntry.hours
          }
        });
      }
      
      if (openEntries.length > 0) {
        // Open entry exists
        const openEntry = openEntries[0];
        const formattedDate = new Date(date + 'T00:00:00Z').toLocaleDateString('de-DE');
        return res.status(409).json({ 
          message: `⚠️ Bereits offener Arbeitsbeginn für ${formattedDate} um ${openEntry.starttime} Uhr vorhanden.\n\nBitte zuerst das Arbeitsende buchen, bevor ein neuer Arbeitsbeginn erfasst werden kann.`,
          errorType: 'OPEN_ENTRY_EXISTS',
          openEntryId: openEntry.id,
          openStartTime: openEntry.starttime
        });
      }
    }
    
    // No conflicts - proceed with creating new entry
    const insertQuery = `
      INSERT INTO work_hours (name, date, starttime) 
      VALUES ($1, $2, $3) 
      RETURNING id
    `;
    const insertResult = await db.query(insertQuery, [employeeName, date, startTime]);
    
    console.log(`✅ Work start logged: ${employeeName} on ${date} at ${startTime} (ID: ${insertResult.rows[0].id})`);
    
    res.status(201).json({
      message: 'Arbeitsbeginn erfolgreich gebucht.',
      id: insertResult.rows[0].id
    });
  } catch (err) {
    console.error('Error in log-start:', err);
    next(err);
  }
});

// PUT /api/employee/log-end/:id - End work time
app.put('/api/employee/log-end/:id', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const entryId = req.params.id;
    const { endTime, comment } = req.body;
    
    if (!endTime) {
      return res.status(400).json({ message: 'End time is required.' });
    }
    
    // Check if entry exists and belongs to employee
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
      return res.status(404).json({ message: 'Open work entry not found or does not belong to this employee.' });
    }
    
    const entry = checkResult.rows[0];
    const hours = calculateWorkHours(entry.starttime, endTime);
    
    // Update entry
    const updateQuery = `
      UPDATE work_hours 
      SET endtime = $1, hours = $2, comment = $3
      WHERE id = $4
      RETURNING id, date
    `;
    const updateResult = await db.query(updateQuery, [endTime, hours, comment || null, entryId]);
    
    console.log(`✅ Work end logged: ${employeeName} entry ID ${entryId}, ${hours.toFixed(2)} hours total`);
    
    res.json({
      message: 'Arbeitsende erfolgreich gebucht.',
      hours: hours
    });
  } catch (err) {
    console.error('Error in log-end:', err);
    next(err);
  }
});

// GET /api/employee/summary-hours - Show daily and monthly overview
app.get('/api/employee/summary-hours', isEmployee, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ message: 'Date is required.' });
    }
    
    // Calculate daily hours
    const dailyQuery = `
      SELECT COALESCE(SUM(hours), 0) as daily_hours
      FROM work_hours 
      WHERE LOWER(name) = LOWER($1) 
        AND date = $2
        AND hours IS NOT NULL
    `;
    const dailyResult = await db.query(dailyQuery, [employeeName, date]);
    const dailyHours = parseFloat(dailyResult.rows[0].daily_hours) || 0;
    
    // Calculate monthly hours
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
    console.error('Error in summary-hours:', err);
    next(err);
  }
});

// --- Admin Endpoints (with isAdmin middleware) ---
app.get('/admin-work-hours', isAdmin, async (req, res, next) => {
  try {
    const { year, month, employeeId } = req.query;
    if (!year || !month) {
      return res.status(400).json({ message: 'Year and month are required.' });
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
    
    // Format date as string for each row
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
            return res.status(409).send('An employee with this name already exists.');
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
            return res.status(409).send('Another employee with this name already exists.');
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
            return res.status(404).json({ message: 'Employee not found.' });
        }
        const credited_hours = getExpectedHours(employee.rows[0], date);
        const result = await db.query(
            'INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [employeeId, date, absenceType, credited_hours, comment]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(409).json({ message: 'An absence entry already exists for this day.' });
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
        res.json({ message: `Holidays generated for ${year}.`, generated, skipped, employees: employees.rows.length });
    } catch (err) {
        next(err);
    }
});

app.delete('/admin/delete-public-holidays', isAdmin, async (req, res, next) => {
    try {
        const result = await db.query("DELETE FROM absences WHERE absence_type = 'PUBLIC_HOLIDAY'");
        res.json({ message: `${result.rowCount} holiday entries deleted.` });
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

// UPDATED: Admin Update Hours with STRICT DAILY VALIDATION
app.put('/api/admin/update-hours', isAdmin, async (req, res, next) => {
    try {
        const { id, date, startTime, endTime, comment } = req.body;
        
        if (!id || !date || !startTime || !endTime) {
            return res.status(400).json({ message: 'ID, date, start time, and end time are required.' });
        }
        
        // Get current entry info to check if we're changing the date
        const currentEntryQuery = 'SELECT name, date FROM work_hours WHERE id = $1';
        const currentEntryResult = await db.query(currentEntryQuery, [id]);
        
        if (currentEntryResult.rows.length === 0) {
            return res.status(404).json({ message: 'Work hours entry not found.' });
        }
        
        const currentEntry = currentEntryResult.rows[0];
        const currentDate = currentEntry.date instanceof Date ? 
            currentEntry.date.toISOString().split('T')[0] : 
            currentEntry.date.split('T')[0];
        
        // If date is being changed, validate the new date doesn't have conflicts
        if (currentDate !== date) {
            const conflictCheckQuery = `
                SELECT id, TO_CHAR(starttime, 'HH24:MI') as starttime, 
                       TO_CHAR(endtime, 'HH24:MI') as endtime
                FROM work_hours 
                WHERE LOWER(name) = LOWER($1) AND date = $2 AND id != $3
            `;
            
            const conflicts = await db.query(conflictCheckQuery, [currentEntry.name, date, id]);
            
            if (conflicts.rows.length > 0) {
                const conflict = conflicts.rows[0];
                const formattedDate = new Date(date + 'T00:00:00Z').toLocaleDateString('de-DE');
                return res.status(409).json({ 
                    message: `❌ Konflikt: Für ${formattedDate} existiert bereits ein Arbeitszeiteneintrag (${conflict.starttime} - ${conflict.endtime || '???'}).\n\nNur ein Arbeitszeitraum pro Tag und Mitarbeiter ist erlaubt.`,
                    errorType: 'DATE_CONFLICT',
                    conflictingEntry: conflict
                });
            }
        }
        
        const hours = calculateWorkHours(startTime, endTime);
        const result = await db.query(
            'UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6 RETURNING *',
            [date, startTime, endTime, hours, comment, id]
        );
        
        console.log(`✅ Admin updated work hours: ID ${id}, ${hours.toFixed(2)} hours`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error in admin update-hours:', err);
        next(err);
    }
});

app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await db.query('DELETE FROM work_hours WHERE id = $1 RETURNING name, date', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Work hours entry not found.' });
        }
        
        console.log(`✅ Admin deleted work hours: ID ${id} (${result.rows[0].name}, ${result.rows[0].date})`);
        res.status(204).send();
    } catch (err) {
        console.error('Error in admin delete-hours:', err);
        next(err);
    }
});

app.delete('/adminDeleteData', isAdmin, async (req, res, next) => {
    try {
        const workHoursResult = await db.query('DELETE FROM work_hours RETURNING id');
        const balanceResult = await db.query('DELETE FROM monthly_balance RETURNING id');
        const absencesResult = await db.query('DELETE FROM absences RETURNING id');
        
        const deletedCounts = {
            workHours: workHoursResult.rows.length,
            balances: balanceResult.rows.length,
            absences: absencesResult.rows.length
        };
        
        console.log(`✅ Admin deleted all data: ${deletedCounts.workHours} work entries, ${deletedCounts.balances} balance entries, ${deletedCounts.absences} absence entries`);
        
        res.send(`All work, balance and absence data has been deleted. (${deletedCounts.workHours} work entries, ${deletedCounts.balances} balance entries, ${deletedCounts.absences} absence entries)`);
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
  console.error("Error loading PDF router:", routerError);
}

// --- Global Error Handler ---
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  if (!res.headersSent) {
    res.status(500).send('An unexpected internal server error occurred.');
  } else {
    next(err);
  }
});

// --- Database Setup & Server Start ---
setupTables()
  .then(() => { console.log('>>> Database setup successfully completed (after server start).'); })
  .catch((err) => { console.error('ERROR executing setupTables (after server start):', err); });

app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server running on port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin Login: ${process.env.ADMIN_PASSWORD ? 'ENABLED' : 'DISABLED (Password missing!)'}`);
  console.log(` Holiday Module: DE / NW`);
  console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(` Frontend from: '${path.join(__dirname, 'public')}'`);
  console.log(` 🔥 DYNAMIC SESSION TIMEOUTS ENABLED:`);
  console.log(`    - Employees: 3 minutes (90s heartbeat)`);
  console.log(`    - Admin: 30 minutes (5min heartbeat)`);
  console.log(` 🚫 STRICT DAILY VALIDATION ENABLED:`);
  console.log(`    - Maximum 1 work period per employee per day`);
  console.log(`    - No multiple bookings allowed`);
  console.log(`=======================================================`);
});
