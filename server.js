// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const app = express();

app.set('trust proxy', 1); // Vertrauen des Proxys (wichtig z. B. für Heroku/Railway)

const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // Frontend-Dateien aus dem Ordner "public"

// PostgreSQL-Datenbank einrichten
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Session Store konfigurieren
const sessionStore = new pgSession({
  pool: db,
  tableName: 'user_sessions',
  createTableIfMissing: true
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'fallback-geheimnis-unbedingt-aendern',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    httpOnly: true
  }
}));

// --- Datenbank Tabellen Setup ---
const setupTables = async () => {
  try {
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
    console.warn(`isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}, Path: ${req.originalUrl}`);
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
// Hier wird getDay() verwendet, um den lokalen Wochentag zu ermitteln
function getExpectedHours(employeeData, dateStr) {
  if (!employeeData || !dateStr) return 0;
  const d = new Date(dateStr);
  const day = d.getDay(); // 0 = Sonntag, 1 = Montag, …, 6 = Samstag
  switch (day) {
    case 1: return employeeData.mo_hours || 0;
    case 2: return employeeData.di_hours || 0;
    case 3: return employeeData.mi_hours || 0;
    case 4: return employeeData.do_hours || 0;
    case 5: return employeeData.fr_hours || 0;
    default: return 0;
  }
}

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  csvRows.push(["Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Pause (Minuten)", "SollArbeitszeit", "IstArbeitszeit", "Differenz", "Bemerkung"].join(','));
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
    const values = [row.name, dateFormatted, startTimeFormatted, endTimeFormatted, breakMinutes, expectedFormatted, istFormatted, diffFormatted, commentFormatted];
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
// API Endpunkte für Zeiterfassung
// ==========================================

// Neuer Endpunkt: GET /next-booking
// Ermittelt, welche Buchung (Arbeitsbeginn oder Arbeitsende) für den Mitarbeiter als nächstes erfolgen soll.
app.get('/next-booking', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  try {
    const query = `
      SELECT id, name, date, starttime, endtime 
      FROM work_hours 
      WHERE LOWER(name) = LOWER($1)
      ORDER BY date DESC, starttime DESC
      LIMIT 1;
    `;
    const result = await db.query(query, [name]);
    let nextBooking;
    if (result.rows.length === 0) {
      nextBooking = 'arbeitsbeginn';
    } else {
      const lastRecord = result.rows[0];
      nextBooking = lastRecord.endtime ? 'arbeitsbeginn' : 'arbeitsende';
    }
    res.json({ nextBooking });
  } catch (err) {
    console.error("Fehler beim Abrufen der nächsten Buchung:", err);
    res.status(500).json({ message: 'Fehler beim Abrufen der nächsten Buchung.' });
  }
});

// POST /log-start : Arbeitsbeginn speichern
app.post('/log-start', async (req, res) => {
  const { name, date, startTime } = req.body;
  if (!name || !date || !startTime) {
    return res.status(400).json({ message: 'Name, Datum und Startzeit sind erforderlich.' });
  }
  try {
    // Prüfen, ob bereits ein Eintrag für diesen Mitarbeiter an diesem Datum vorhanden ist
    const checkQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2`;
    const checkResult = await db.query(checkQuery, [name, date]);
    if (checkResult.rows.length > 0) {
      return res.status(409).json({ message: 'Arbeitsbeginn wurde für diesen Tag bereits erfasst.' });
    }
    const insertQuery = `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`;
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
    return res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsbeginns auf dem Server.' });
  }
});

// PUT /log-end/:id : Arbeitsende (sowie Pause und Kommentar) speichern
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, breakTime, comment } = req.body;
  if (!endTime) {
    return res.status(400).json({ message: 'Endzeit ist erforderlich.' });
  }
  if (!id || isNaN(parseInt(id))) {
    return res.status(400).json({ message: 'Gültige Eintrags-ID ist erforderlich.' });
  }
  const entryId = parseInt(id);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60.0;
  try {
    // Arbeitsbeginn und (möglicherweise bereits vorhandenes) Arbeitsende abfragen
    const timeResult = await db.query('SELECT starttime, endtime FROM work_hours WHERE id = $1', [entryId]);
    if (timeResult.rows.length === 0) {
      return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
    }
    // Prüfen, ob bereits ein Arbeitsende erfasst wurde
    if (timeResult.rows[0].endtime) {
      return res.status(409).json({ message: 'Arbeitsende wurde für diesen Tag bereits erfasst.' });
    }
    const startTime = timeResult.rows[0].starttime;
    const totalHours = calculateWorkHours(startTime, endTime);
    if (totalHours < 0) {
      return res.status(400).json({ message: 'Arbeitsende darf nicht vor Arbeitsbeginn liegen.' });
    }
    const netHours = Math.max(0, totalHours - breakTimeHours);
    const updateQuery = `UPDATE work_hours SET endtime = $1, break_time = $2, comment = $3, hours = $4 WHERE id = $5;`;
    await db.query(updateQuery, [endTime, breakTimeHours, comment, netHours, entryId]);
    console.log(`Arbeitsende für ID ${entryId} um ${endTime} gespeichert (Netto Std: ${netHours.toFixed(2)}).`);
    res.status(200).send('Arbeitsende erfolgreich gespeichert.');
  } catch (err) {
    console.error(`Fehler beim Speichern des Arbeitsendes für ID ${entryId}:`, err);
    res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsendes auf dem Server.' });
  }
});

// GET /get-all-hours : Alle Arbeitszeiten eines Mitarbeiters abrufen
app.get('/get-all-hours', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const query = `
    SELECT id, name, date, hours, break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime",
           TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours WHERE LOWER(name) = LOWER($1)
    ORDER BY date ASC, starttime ASC;`;
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

// GET /employees : Mitarbeiter für Dropdown abrufen
app.get('/employees', (req, res) => {
  const query = 'SELECT id, name FROM employees ORDER BY name ASC';
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => {
      console.error("DB Fehler in GET /employees:", err);
      res.status(500).send('Fehler beim Abrufen der Mitarbeiter.');
    });
});

// --------------------------
// Admin-Login und geschützte Endpunkte
// --------------------------

app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error("FEHLER: ADMIN_PASSWORD nicht in den Umgebungsvariablen gesetzt!");
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
      console.log("Admin-Login erfolgreich, Session gespeichert.");
      res.send('Admin erfolgreich angemeldet.');
    });
  } else {
    req.session.isAdmin = false;
    res.status(401).send('Ungültiges Passwort.');
  }
});

app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = `
    SELECT id, name, date, hours, break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime",
           TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours
    ORDER BY date DESC, name ASC, starttime ASC;`;
  db.query(query)
    .then(result => {
      const rowsWithMinutes = result.rows.map(row => ({
        ...row,
        break_time: Math.round((row.break_time || 0) * 60)
      }));
      res.json(rowsWithMinutes);
    })
    .catch(err => {
      console.error("DB Fehler in GET /admin-work-hours:", err);
      res.status(500).send('Fehler beim Abrufen der Admin-Arbeitszeiten.');
    });
});

// GET /admin-download-csv : CSV-Download (Admin)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  const query = `
    SELECT w.*, e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours
    FROM work_hours w LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
    ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`;
  try {
    const result = await db.query(query);
    const csv = convertToCSV(result.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
    res.send(Buffer.from(csv, 'utf-8'));
  } catch (err) {
    console.error("DB Fehler in GET /admin-download-csv:", err);
    res.status(500).send('Fehler beim Erstellen des CSV-Downloads.');
  }
});

// PUT /api/admin/update-hours : Zeiteintrag aktualisieren (Admin)
app.put('/api/admin/update-hours', isAdmin, (req, res) => {
  const { id, name, date, startTime, endTime, comment, breakTime } = req.body;
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
  if (!name || !date || !startTime || !endTime) return res.status(400).send('Name, Datum, Start- und Endzeit sind erforderlich.');
  if (parseTime(startTime) >= parseTime(endTime)) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später oder gleich dem Arbeitsende sein.' });
  }
  const totalHours = calculateWorkHours(startTime, endTime);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60.0;
  const netHours = Math.max(0, totalHours - breakTimeHours);
  const query = `UPDATE work_hours SET name = $1, date = $2, hours = $3, break_time = $4, comment = $5, starttime = $6, endtime = $7 WHERE id = $8;`;
  db.query(query, [name, date, netHours, breakTimeHours, comment, startTime, endTime, parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) res.send('Arbeitszeit erfolgreich aktualisiert.');
      else res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`);
    })
    .catch(err => {
      console.error("DB Fehler in PUT /api/admin/update-hours:", err);
      res.status(500).send('Fehler beim Aktualisieren der Arbeitszeit.');
    });
});

// DELETE /api/admin/delete-hours/:id : Zeiteintrag löschen (Admin)
app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
  const query = 'DELETE FROM work_hours WHERE id = $1';
  db.query(query, [parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) res.send('Arbeitszeit erfolgreich gelöscht.');
      else res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`);
    })
    .catch(err => {
      console.error("DB Fehler in DELETE /api/admin/delete-hours/:id:", err);
      res.status(500).send('Fehler beim Löschen der Arbeitszeit.');
    });
});

// DELETE /adminDeleteData : Alle Arbeitszeiten löschen (Admin)
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM work_hours');
    console.log("Alle Arbeitszeiten durch Admin gelöscht.");
    res.send('Alle Arbeitszeiten erfolgreich gelöscht.');
  } catch (err) {
    console.error("DB Fehler in /adminDeleteData:", err);
    res.status(500).send('Fehler beim Löschen aller Arbeitszeiten.');
  }
});

// --------------------------
// Mitarbeiterverwaltung (Admin)
// --------------------------
app.get('/admin/employees', isAdmin, (req, res) => {
  const query = 'SELECT * FROM employees ORDER BY name ASC';
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => {
      console.error("DB Fehler in GET /admin/employees:", err);
      res.status(500).send('Fehler beim Abrufen der Mitarbeiter.');
    });
});

app.post('/admin/employees', isAdmin, (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (name) DO NOTHING RETURNING *;`;
  db.query(query, [name, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0])
    .then(result => {
      if (result.rows.length > 0) {
        res.status(201).json(result.rows[0]);
      } else {
        res.status(409).send(`Mitarbeiter mit Namen '${name}' existiert bereits oder anderer Konflikt.`);
      }
    })
    .catch(err => {
      console.error("DB Fehler in POST /admin/employees:", err);
      res.status(500).send('Fehler beim Hinzufügen des Mitarbeiters.');
    });
});

app.put('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
  const query = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
  db.query(query, [name, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0, parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) res.send('Mitarbeiter erfolgreich aktualisiert.');
      else res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`);
    })
    .catch(err => {
      if (err.code === '23505') res.status(409).send(`Ein anderer Mitarbeiter mit dem Namen '${name}' existiert bereits.`);
      else {
        console.error("DB Fehler in PUT /admin/employees/:id:", err);
        res.status(500).send('Fehler beim Aktualisieren des Mitarbeiters.');
      }
    });
});

app.delete('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
  const query = 'DELETE FROM employees WHERE id = $1';
  db.query(query, [parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) res.send('Mitarbeiter erfolgreich gelöscht.');
      else res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`);
    })
    .catch(err => {
      console.error("DB Fehler in DELETE /admin/employees/:id:", err);
      res.status(500).send('Fehler beim Löschen des Mitarbeiters.');
    });
});

// --- Monatsabschluss Endpunkt (Admin) ---
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;
  if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || parseInt(month) < 1 || parseInt(month) > 12) {
    return res.status(400).send("Bitte gültigen Namen, Jahr und Monat (1-12) angeben.");
  }
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);
  try {
    const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name]);
    if (empResult.rows.length === 0) return res.status(404).send("Mitarbeiter nicht gefunden.");
    const employee = empResult.rows[0];
    const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
    const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    const workResult = await db.query(
      `SELECT date, hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3`,
      [name.toLowerCase(), startDateStr, endDateStr]
    );
    const workEntries = workResult.rows;
    let totalDifference = 0;
    workEntries.forEach(entry => {
      const expected = getExpectedHours(employee, entry.date);
      totalDifference += (entry.hours || 0) - expected;
    });
    let prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
    const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
    const prevResult = await db.query(
      `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
      [employee.id, prevMonthDateStr]
    );
    let previousCarry = prevResult.rows.length > 0 ? (prevResult.rows[0].carry_over || 0) : 0;
    const newCarry = previousCarry + totalDifference;
    const currentMonthDateStr = startDateStr;
    const upsertQuery = `
      INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (employee_id, year_month) DO UPDATE SET
        difference = EXCLUDED.difference,
        carry_over = EXCLUDED.carry_over;`;
    await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);
    res.json({
      message: `Monatlicher Saldo für ${name} (${parsedMonth}/${parsedYear}) berechnet.`,
      employeeName: name,
      month: parsedMonth,
      year: parsedYear,
      monthlyDifference: parseFloat(totalDifference.toFixed(2)),
      previousCarryOver: parseFloat(previousCarry.toFixed(2)),
      newCarryOver: parseFloat(newCarry.toFixed(2))
    });
  } catch (error) {
    console.error("Fehler beim Berechnen des monatlichen Saldo:", error);
    res.status(500).send("Serverfehler beim Berechnen des monatlichen Saldo.");
  }
});

// --- Server starten und Graceful Shutdown ---
async function startServer() {
  try {
    await setupTables();
    console.log("Datenbank-Setup abgeschlossen.");
    if(!process.env.DATABASE_URL) console.warn("WARNUNG: Kein DATABASE_URL in Umgebungsvariablen gefunden.");
    if(!process.env.SESSION_SECRET) console.warn("WARNUNG: Kein SESSION_SECRET in Umgebungsvariablen gefunden.");
    if(!process.env.ADMIN_PASSWORD) console.warn("WARNUNG: Kein ADMIN_PASSWORD in Umgebungsvariablen gefunden.");
    if(process.env.NODE_ENV !== 'production') console.warn("WARNUNG: Server läuft nicht im Produktionsmodus.");
    
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`Server läuft auf Port: ${port}`);
    });
    
    const gracefulShutdown = async (signal) => {
      console.log(`---> Graceful shutdown gestartet für Signal: ${signal}`);
      server.close(async (err) => {
        if (err) console.error("Fehler beim Schließen des HTTP-Servers:", err);
        else console.log("HTTP-Server erfolgreich geschlossen.");
        try {
          await db.end();
          console.log("Datenbank-Pool erfolgreich geschlossen.");
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
      console.log(`---> SIGTERM empfangen. Starte graceful shutdown...`);
      gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      console.log(`---> SIGINT empfangen. Starte graceful shutdown...`);
      gracefulShutdown('SIGINT');
    });
    
  } catch (error) {
    console.error("!!! Kritischer Fehler beim Starten des Servers:", error);
    process.exit(1);
  }
}
startServer();
