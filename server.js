const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Session
app.use(session({
  secret: 'dein-geheimes-schluessel',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// SQLite
const db = new sqlite3.Database('./work_hours.db');

db.serialize(() => {
  // Database schema and initial data setup
  db.run(`
    CREATE TABLE IF NOT EXISTS work_hours (
      id INTEGER PRIMARY KEY,
      name TEXT,
      date TEXT,
      start_time TEXT,
      end_time TEXT,
      break_time REAL,
      comment TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY,
      name TEXT,
      mo_hours REAL,
      di_hours REAL,
      mi_hours REAL,
      do_hours REAL,
      fr_hours REAL
    )
  `);
});

// Middleware Admin-Check
function isAdmin(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.status(403).send('Access denied. Admin privileges required.');
  }
}

// --------------------------
// API-Endpunkte für Arbeitszeiten
// --------------------------

app.get('/admin-download-csv', isAdmin, (req, res) => {
  const query = `
    SELECT w.*, e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours
    FROM work_hours w
    LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
  `;
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).send('Error fetching work hours.');
    }
    const csv = convertToCSV(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
    res.send(csv);
  });
});

// New endpoint: CSV-Download-Endpunkt with hh:mm format
app.get('/admin-download-csv-hhmm', isAdmin, (req, res) => {
  const query = `
    SELECT w.*, e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours
    FROM work_hours w
    LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
  `;
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).send('Error fetching work hours.');
    }
    const csv = convertToCSVWithHHMM(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten_hhmm.csv"');
    res.send(csv);
  });
});

app.get('/work-hours', (req, res) => {
  const query = 'SELECT * FROM work_hours';
  db.all(query, [], (err, rows) => {
    if (err) {
      res.status(500).send('Error fetching work hours.');
    } else {
      res.json(rows);
    }
  });
});

app.post('/work-hours', (req, res) => {
  const { name, date, startTime, endTime, breakTime, comment } = req.body;
  const query = `
    INSERT INTO work_hours (name, date, start_time, end_time, break_time, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  db.run(query, [name, date, startTime, endTime, breakTime, comment], function (err) {
    if (err) {
      res.status(500).send('Error saving work hours.');
    } else {
      res.status(201).send(`Work hours added with ID: ${this.lastID}`);
    }
  });
});

app.put('/work-hours/:id', (req, res) => {
  const { id } = req.params;
  const { name, date, startTime, endTime, breakTime, comment } = req.body;
  const query = `
    UPDATE work_hours
    SET name = ?, date = ?, start_time = ?, end_time = ?, break_time = ?, comment = ?
    WHERE id = ?
  `;
  db.run(query, [name, date, startTime, endTime, breakTime, comment, id], function (err) {
    if (err) {
      res.status(500).send('Error updating work hours.');
    } else {
      res.status(200).send(`Work hours updated for ID: ${id}`);
    }
  });
});

app.delete('/work-hours/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM work_hours WHERE id = ?';
  db.run(query, id, function (err) {
    if (err) {
      res.status(500).send('Error deleting work hours.');
    } else {
      res.status(200).send(`Work hours deleted for ID: ${id}`);
    }
  });
});

// --------------------------
// Hilfsfunktionen
// --------------------------

/**
 * Gibt "HH:MM" für einen positiven Dezimalwert zurück,
 * z. B. 7.5 => "07:30"
 */
function formatHHMM(decimalHours) {
  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Gibt "+HH:MM" oder "-HH:MM" (bzw. ohne Plus) für eine Dezimalzahl zurück,
 * z. B. 2.5 => "02:30", -1.75 => "-01:45"
 */
function formatDifference(diffDecimal) {
  const sign = diffDecimal < 0 ? '-' : '';
  const absVal = Math.abs(diffDecimal);
  const hours = Math.floor(absVal);
  const minutes = Math.round((absVal - hours) * 60);
  // Optional: Bei positivem Wert noch ein "+" davor?
  // Dann: const sign = diffDecimal < 0 ? '-' : '+';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getExpectedHours(row, dateStr) {
  const date = new Date(dateStr);
  const day = date.getUTCDay();
  switch (day) {
    case 1: return row.mo_hours || 0;
    case 2: return row.di_hours || 0;
    case 3: return row.mi_hours || 0;
    case 4: return row.do_hours || 0;
    case 5: return row.fr_hours || 0;
    default: return 0;
  }
}

/**
 * Wandelt die rows in CSV um, wobei Ist-Zeit und Differenz als HH:MM ausgegeben werden.
 */
function convertToCSV(data) {
  if (!data || data.length === 0) return '';

  // CSV-Header
  const headers = [
    "Name",
    "Datum",
    "Arbeitsbeginn",
    "Arbeitsende",
    "Pause (Minuten)",
    "Ist Arbeitszeit (HH:MM)",
    "Differenz (HH:MM)",
    "Bemerkung"
  ];
  const csvRows = [headers.join(',')];

  for (const row of data) {
    // Pause in Minuten
    const breakMinutes = Math.round(row.break_time * 60);

    // Ist-Arbeitszeit (decimal) => HH:MM
    const istHours = row.hours || 0;
    const istFormatted = formatHHMM(istHours);

    // Soll-Arbeitszeit ermitteln
    const expected = getExpectedHours(row, row.date);

    // Differenz => HH:MM (auch negative Werte)
    const diffDecimal = istHours - expected;
    const diffFormatted = formatDifference(diffDecimal);

    csvRows.push([
      row.name,
      row.date,
      row.start_time,
      row.end_time,
      breakMinutes,
      istFormatted,
      diffFormatted,
      row.comment || ''
    ].join(','));
  }
  return csvRows.join('\n');
}

/**
 * Wandelt die rows in CSV um, wobei Arbeitszeit als HH:MM ausgegeben wird.
 */
function convertToCSVWithHHMM(data) {
  if (!data || data.length === 0) return '';

  // CSV-Header
  const headers = [
    "Name",
    "Datum",
    "Arbeitsbeginn",
    "Arbeitsende",
    "Pause (Minuten)",
    "Ist Arbeitszeit (HH:MM)",
    "Bemerkung"
  ];
  const csvRows = [headers.join(',')];

  for (const row of data) {
    // Pause in Minuten
    const breakMinutes = Math.round(row.break_time * 60);

    // Ist-Arbeitszeit (decimal) => HH:MM
    const istHours = row.hours || 0;
    const istFormatted = formatHHMM(istHours);

    csvRows.push([
      row.name,
      row.date,
      row.start_time,
      row.end_time,
      breakMinutes,
      istFormatted,
      row.comment || ''
    ].join(','));
  }
  return csvRows.join('\n');
}

// ... Server starten etc.
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});