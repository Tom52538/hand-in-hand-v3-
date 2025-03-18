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

// Session-Middleware konfigurieren
app.use(session({
  secret: 'dein-geheimes-schluessel', // Ersetze dies durch einen sicheren Schlüssel
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Auf true setzen, wenn du HTTPS verwendest
}));

// SQLite Datenbank einrichten
const db = new sqlite3.Database('./work_hours.db');

db.serialize(() => {
  // Tabelle für Arbeitszeiten erstellen
  db.run(`
    CREATE TABLE IF NOT EXISTS work_hours (
      id INTEGER PRIMARY KEY,
      name TEXT,
      date TEXT,
      hours REAL,
      break_time REAL,
      comment TEXT,
      startTime TEXT,
      endTime TEXT
    )
  `);

  // Sicherstellen, dass bestimmte Spalten vorhanden sind
  db.all("PRAGMA table_info(work_hours)", [], (err, rows) => {
    if (err) {
      console.error("Fehler beim Abrufen der Tabelleninformationen:", err);
      return;
    }
    const columnNames = rows.map(row => row.name);
    if (!columnNames.includes('comment')) {
      db.run("ALTER TABLE work_hours ADD COLUMN comment TEXT");
    }
    if (!columnNames.includes('startTime')) {
      db.run("ALTER TABLE work_hours ADD COLUMN startTime TEXT");
    }
    if (!columnNames.includes('endTime')) {
      db.run("ALTER TABLE work_hours ADD COLUMN endTime TEXT");
    }
  });

  // Tabelle für Mitarbeiter erstellen
  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contract_hours REAL
    )
  `, (err) => {
    if (err) {
      console.error("Fehler beim Erstellen der Tabelle employees:", err);
    } else {
      console.log("Tabelle employees erfolgreich erstellt oder bereits vorhanden.");
    }
  });

  // Neue Tabelle für vertragliche Arbeitszeiten pro Wochentag erstellen
  db.run(`
    CREATE TABLE IF NOT EXISTS employee_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER,
      weekday INTEGER,          -- 1 = Montag, 2 = Dienstag, ... 5 = Freitag
      expected_start TEXT,      -- z. B. '08:00'
      expected_end TEXT,        -- z. B. '16:30'
      expected_hours REAL,      -- z. B. 8.5
      FOREIGN KEY(employee_id) REFERENCES employees(id)
    )
  `, (err) => {
    if (err) {
      console.error("Fehler beim Erstellen der Tabelle employee_schedule:", err);
    } else {
      console.log("Tabelle employee_schedule erfolgreich erstellt oder bereits vorhanden.");
    }
  });
});

// Middleware, um Admin-Berechtigungen zu prüfen
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    next();
  } else {
    res.status(403).send('Access denied. Admin privileges required.');
  }
}

// Hilfsfunktion: Mitarbeiter-ID anhand des Namens ermitteln
function getEmployeeByName(name, callback) {
  const query = 'SELECT id FROM employees WHERE LOWER(name) = LOWER(?)';
  db.get(query, [name], callback);
}

// Hilfsfunktion: Erwartete Stunden für einen Mitarbeiter und Wochentag ermitteln
function getExpectedHours(employeeId, weekday, callback) {
  const query = 'SELECT expected_hours FROM employee_schedule WHERE employee_id = ? AND weekday = ?';
  db.get(query, [employeeId, weekday], callback);
}

// --------------------------
// API-Endpunkte für Arbeitszeiten
// --------------------------

// Alle Arbeitszeiten abrufen (Admin)
app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = 'SELECT * FROM work_hours';
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).send('Error fetching work hours.');
    res.json(rows);
  });
});

// CSV-Download für Arbeitszeiten (Admin)
app.get('/admin-download-csv', isAdmin, (req, res) => {
  const query = 'SELECT * FROM work_hours';
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).send('Error fetching work hours.');
    const csv = convertToCSV(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
    res.send(csv);
  });
});

// Update eines Arbeitszeiteintrags (Admin)
app.put('/api/admin/update-hours', isAdmin, (req, res) => {
  const { id, name, date, startTime, endTime, comment } = req.body;
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }
  const hours = calculateWorkHours(startTime, endTime);
  const breakTime = calculateBreakTime(hours, comment);
  const netHours = hours - breakTime;
  const query = `
    UPDATE work_hours
    SET name = ?, date = ?, hours = ?, break_time = ?, comment = ?, startTime = ?, endTime = ?
    WHERE id = ?
  `;
  db.run(query, [name, date, netHours, breakTime, comment, startTime, endTime, id], function(err) {
    if (err) return res.status(500).send('Error updating working hours.');
    res.send('Working hours updated successfully.');
  });
});

// Löschen eines Arbeitszeiteintrags (Admin)
app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM work_hours WHERE id = ?';
  db.run(query, [id], function(err) {
    if (err) return res.status(500).send('Error deleting working hours.');
    res.send('Working hours deleted successfully.');
  });
});

// Arbeitszeiten erfassen
app.post('/log-hours', (req, res) => {
  const { name, date, startTime, endTime, comment } = req.body;
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }
  const checkQuery = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER(?) AND date = ?
  `;
  db.get(checkQuery, [name, date], (err, row) => {
    if (err) return res.status(500).send('Fehler beim Überprüfen der Daten.');
    if (row) return res.status(400).json({ error: 'Eintrag für diesen Tag existiert bereits.' });
    const hours = calculateWorkHours(startTime, endTime);
    const breakTime = calculateBreakTime(hours, comment);
    const netHours = hours - breakTime;
    // Mitarbeiter-ID ermitteln
    getEmployeeByName(name, (err, employee) => {
      if (err) return res.status(500).send('Fehler beim Abrufen der Mitarbeiterdaten.');
      // Falls kein Mitarbeiter gefunden, speichern wir trotzdem
      if (!employee) {
        const insertQuery = `
          INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        return db.run(insertQuery, [name, date, netHours, breakTime, comment, startTime, endTime], function(err) {
          if (err) return res.status(500).send('Fehler beim Speichern der Daten.');
          res.send('Daten erfolgreich gespeichert (Mitarbeiter nicht in Stammdaten gefunden).');
        });
      }
      // Bestimme den Wochentag (JS: 0=Sonntag, 1=Montag, ...6=Samstag)
      const dt = new Date(date);
      const jsWeekday = dt.getDay();
      const weekday = (jsWeekday >= 1 && jsWeekday <= 5) ? jsWeekday : null;
      const insertQuery = `
        INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      db.run(insertQuery, [name, date, netHours, breakTime, comment, startTime, endTime], function(err) {
        if (err) return res.status(500).send('Fehler beim Speichern der Daten.');
        if (weekday !== null) {
          getExpectedHours(employee.id, weekday, (err, row) => {
            if (err) return res.send('Daten erfolgreich gespeichert, aber Fehler beim Abrufen der Soll-Stunden.');
            const expectedHours = row ? row.expected_hours : 0;
            const difference = netHours - expectedHours;
            res.send(`Daten erfolgreich gespeichert. Erfasste Stunden: ${netHours.toFixed(2)}. Soll-Stunden: ${expectedHours.toFixed(2)}. Differenz: ${difference.toFixed(2)}.`);
          });
        } else {
          res.send(`Daten erfolgreich gespeichert. Erfasste Stunden: ${netHours.toFixed(2)}. (Wochenende, keine Soll-Stunden.)`);
        }
      });
    });
  });
});

/**
 * GET-Endpunkt: Alle Arbeitszeiten für einen Namen abrufen (case-insensitive)
 */
app.get('/get-all-hours', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const query = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER(?)
    ORDER BY date ASC
  `;
  db.all(query, [name], (err, rows) => {
    if (err) return res.status(500).send('Fehler beim Abrufen der Daten.');
    res.json(rows);
  });
});

// GET-Endpunkt: Einen Datensatz für Name + Datum abrufen (case-insensitive)
app.get('/get-hours', (req, res) => {
  const { name, date } = req.query;
  const query = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER(?) AND date = ?
  `;
  db.get(query, [name, date], (err, row) => {
    if (err) return res.status(500).send('Fehler beim Abrufen der Daten.');
    if (!row) return res.status(404).send('Keine Daten gefunden.');
    res.json(row);
  });
});

// Löschen aller Arbeitszeiten
app.delete('/delete-hours', (req, res) => {
  const { password, confirmDelete } = req.body;
  if (password === 'admin' && (confirmDelete === true || confirmDelete === 'true')) {
    const deleteQuery = 'DELETE FROM work_hours';
    db.run(deleteQuery, function(err) {
      if (err) return res.status(500).send('Fehler beim Löschen der Daten.');
      res.send('Daten erfolgreich gelöscht.');
    });
  } else {
    res.status(401).send('Löschen abgebrochen. Passwort erforderlich oder Bestätigung fehlt.');
  }
});

// Admin Login Endpunkt
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin') {
    req.session.isAdmin = true;
    res.send('Admin angemeldet.');
  } else {
    res.status(401).send('Ungültiges Passwort.');
  }
});

// --------------------------
// API-Endpunkte für die Mitarbeiterverwaltung
// --------------------------

// Alte Endpunkte für employees (Name, contract_hours)
app.get('/admin/employees', isAdmin, (req, res) => {
  const query = 'SELECT * FROM employees';
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).send('Fehler beim Abrufen der Mitarbeiter.');
    res.json(rows);
  });
});

app.post('/admin/employees', isAdmin, (req, res) => {
  const { name, contract_hours } = req.body;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const query = 'INSERT INTO employees (name, contract_hours) VALUES (?, ?)';
  db.run(query, [name, contract_hours || 0], function(err) {
    if (err) return res.status(500).send('Fehler beim Hinzufügen des Mitarbeiters.');
    res.send({ id: this.lastID, name, contract_hours });
  });
});

app.put('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { name, contract_hours } = req.body;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const query = 'UPDATE employees SET name = ?, contract_hours = ? WHERE id = ?';
  db.run(query, [name, contract_hours || 0, id], function(err) {
    if (err) return res.status(500).send('Fehler beim Aktualisieren des Mitarbeiters.');
    res.send('Mitarbeiter erfolgreich aktualisiert.');
  });
});

app.delete('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM employees WHERE id = ?';
  db.run(query, [id], function(err) {
    if (err) return res.status(500).send('Fehler beim Löschen des Mitarbeiters.');
    res.send('Mitarbeiter erfolgreich gelöscht.');
  });
});

// --------------------------
// API-Endpunkte für den Arbeitsplan (employee_schedule)
// --------------------------

// Alle Schedule-Einträge für einen Mitarbeiter abrufen
app.get('/admin/employees/:id/schedule', isAdmin, (req, res) => {
  const employeeId = req.params.id;
  const query = 'SELECT * FROM employee_schedule WHERE employee_id = ? ORDER BY weekday ASC';
  db.all(query, [employeeId], (err, rows) => {
    if (err) return res.status(500).send('Fehler beim Abrufen des Arbeitsplans.');
    res.json(rows);
  });
});

// Neuen Schedule-Eintrag für einen Mitarbeiter hinzufügen
app.post('/admin/employees/:id/schedule', isAdmin, (req, res) => {
  const employeeId = req.params.id;
  const { weekday, expected_start, expected_end, expected_hours } = req.body;
  if (!weekday || !expected_start || !expected_end || expected_hours == null) {
    return res.status(400).send('Alle Felder sind erforderlich.');
  }
  const query = 'INSERT INTO employee_schedule (employee_id, weekday, expected_start, expected_end, expected_hours) VALUES (?, ?, ?, ?, ?)';
  db.run(query, [employeeId, weekday, expected_start, expected_end, expected_hours], function(err) {
    if (err) return res.status(500).send('Fehler beim Hinzufügen des Arbeitsplans.');
    res.send({ id: this.lastID, employee_id: employeeId, weekday, expected_start, expected_end, expected_hours });
  });
});

// Einen Schedule-Eintrag aktualisieren
app.put('/admin/employees/:id/schedule/:scheduleId', isAdmin, (req, res) => {
  const scheduleId = req.params.scheduleId;
  const { weekday, expected_start, expected_end, expected_hours } = req.body;
  if (!weekday || !expected_start || !expected_end || expected_hours == null) {
    return res.status(400).send('Alle Felder sind erforderlich.');
  }
  const query = 'UPDATE employee_schedule SET weekday = ?, expected_start = ?, expected_end = ?, expected_hours = ? WHERE id = ?';
  db.run(query, [weekday, expected_start, expected_end, expected_hours, scheduleId], function(err) {
    if (err) return res.status(500).send('Fehler beim Aktualisieren des Arbeitsplans.');
    res.send('Arbeitsplan erfolgreich aktualisiert.');
  });
});

// Einen Schedule-Eintrag löschen
app.delete('/admin/employees/:id/schedule/:scheduleId', isAdmin, (req, res) => {
  const scheduleId = req.params.scheduleId;
  const query = 'DELETE FROM employee_schedule WHERE id = ?';
  db.run(query, [scheduleId], function(err) {
    if (err) return res.status(500).send('Fehler beim Löschen des Arbeitsplans.');
    res.send('Arbeitsplan erfolgreich gelöscht.');
  });
});

// --------------------------
// Hilfsfunktionen
// --------------------------
function calculateWorkHours(startTime, endTime) {
  const start = new Date(`1970-01-01T${startTime}:00`);
  const end = new Date(`1970-01-01T${endTime}:00`);
  const diff = end - start;
  return diff / 1000 / 60 / 60; // Stunden
}

function calculateBreakTime(hours, comment) {
  if (comment && (comment.toLowerCase().includes("ohne pause") || comment.toLowerCase().includes("keine pause"))) {
    return 0;
  } else if (comment && comment.toLowerCase().includes("15 minuten")) {
    return 0.25;
  } else if (hours > 9) {
    return 0.75;
  } else if (hours > 6) {
    return 0.5;
  } else {
    return 0;
  }
}

function convertDecimalHoursToHoursMinutes(decimalHours) {
  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  const headers = ["Name", "Datum", "Anfang", "Ende", "Gesamtzeit", "Bemerkung"];
  csvRows.push(headers.join(','));
  for (const row of data) {
    const formattedHours = convertDecimalHoursToHoursMinutes(row.hours);
    const values = [
      row.name,
      row.date,
      row.startTime,
      row.endTime,
      formattedHours,
      row.comment || ''
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

// Server starten
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});
