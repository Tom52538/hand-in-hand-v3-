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
  // ... wie gehabt ...
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

// Beispiel: CSV-Download-Endpunkt
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

// ... weitere Endpunkte wie gehabt ...

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

/**
 * Ermittelt die Soll-Stunden anhand des Datums (Wochentag) und den Spalten mo_hours, di_hours, ...
 */
function getExpectedHours(row, dateStr) {
  // ... wie gehabt ...
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
      row.startTime,
      row.endTime,
      breakMinutes,
      istFormatted,
      diffFormatted,
      row.comment || ''
    ].join(','));
  }
  return csvRows.join('\n');
}

// ... Server starten etc.
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});
