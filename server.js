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

  // Füge die 'comment', 'startTime', 'endTime' Felder hinzu, falls sie noch nicht existieren
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

  // Neue Tabelle für Mitarbeiter erstellen, falls sie noch nicht existiert
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
  
  // Neue Spalten für Soll-Arbeitszeiten (Montag bis Freitag) in der Tabelle employees hinzufügen
  db.all("PRAGMA table_info(employees)", [], (err, rows) => {
    if (err) {
      console.error("Fehler beim Abrufen der Mitarbeiter-Tabelle:", err);
      return;
    }
    const columnNames = rows.map(row => row.name);
    if (!columnNames.includes('mo_hours')) {
      db.run("ALTER TABLE employees ADD COLUMN mo_hours REAL");
    }
    if (!columnNames.includes('di_hours')) {
      db.run("ALTER TABLE employees ADD COLUMN di_hours REAL");
    }
    if (!columnNames.includes('mi_hours')) {
      db.run("ALTER TABLE employees ADD COLUMN mi_hours REAL");
    }
    if (!columnNames.includes('do_hours')) {
      db.run("ALTER TABLE employees ADD COLUMN do_hours REAL");
    }
    if (!columnNames.includes('fr_hours')) {
      db.run("ALTER TABLE employees ADD COLUMN fr_hours REAL");
    }
  });
});

// Middleware, um Admin-Berechtigungen zu prüfen
function isAdmin(req, res, next) {
  const isAdminUser = req.session.isAdmin;
  if (isAdminUser) {
    next();
  } else {
    res.status(403).send('Access denied. Admin privileges required.');
  }
}

// --------------------------
// API-Endpunkte für Arbeitszeiten
// --------------------------
app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = 'SELECT * FROM work_hours';
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).send('Error fetching work hours.');
    }
    res.json(rows);
  });
});

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

app.put('/api/admin/update-hours', isAdmin, (req, res) => {
  const { id, name, date, startTime, endTime, comment, breakTime } = req.body;
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }
  const totalHours = calculateWorkHours(startTime, endTime);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60;
  const netHours = totalHours - breakTimeHours;
  const query = `
    UPDATE work_hours
    SET name = ?, date = ?, hours = ?, break_time = ?, comment = ?, startTime = ?, endTime = ?
    WHERE id = ?
  `;
  db.run(query, [name, date, netHours, breakTimeHours, comment, startTime, endTime, id], function(err) {
    if (err) {
      return res.status(500).send('Error updating working hours.');
    }
    res.send('Working hours updated successfully.');
  });
});

app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM work_hours WHERE id = ?';
  db.run(query, [id], function(err) {
    if (err) {
      return res.status(500).send('Error deleting working hours.');
    }
    res.send('Working hours deleted successfully.');
  });
});

app.post('/log-hours', (req, res) => {
  const { name, date, startTime, endTime, comment, breakTime } = req.body;
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }
  const checkQuery = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER(?) AND date = ?
  `;
  db.get(checkQuery, [name, date], (err, row) => {
    if (err) {
      return res.status(500).send('Fehler beim Überprüfen der Daten.');
    }
    if (row) {
      return res.status(400).json({ error: 'Eintrag für diesen Tag existiert bereits.' });
    }
    const totalHours = calculateWorkHours(startTime, endTime);
    const breakTimeMinutes = parseInt(breakTime, 10) || 0;
    const breakTimeHours = breakTimeMinutes / 60;
    const netHours = totalHours - breakTimeHours;
    const insertQuery = `
      INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(insertQuery, [name, date, netHours, breakTimeHours, comment, startTime, endTime], function(err) {
      if (err) {
        return res.status(500).send('Fehler beim Speichern der Daten.');
      }
      res.send('Daten erfolgreich gespeichert.');
    });
  });
});

app.get('/get-all-hours', (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).send('Name ist erforderlich.');
  }
  const query = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER(?)
    ORDER BY date ASC
  `;
  db.all(query, [name], (err, rows) => {
    if (err) {
      return res.status(500).send('Fehler beim Abrufen der Daten.');
    }
    res.json(rows);
  });
});

app.get('/get-hours', (req, res) => {
  const { name, date } = req.query;
  const query = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER(?) AND date = ?
  `;
  db.get(query, [name, date], (err, row) => {
    if (err) {
      return res.status(500).send('Fehler beim Abrufen der Daten.');
    }
    if (!row) {
      return res.status(404).send('Keine Daten gefunden.');
    }
    res.json(row);
  });
});

app.delete('/delete-hours', (req, res) => {
  const { password, confirmDelete } = req.body;
  if (password === 'admin' && (confirmDelete === true || confirmDelete === 'true')) {
    const deleteQuery = 'DELETE FROM work_hours';
    db.run(deleteQuery, function(err) {
      if (err) {
        return res.status(500).send('Fehler beim Löschen der Daten.');
      }
      res.send('Daten erfolgreich gelöscht.');
    });
  } else {
    res.status(401).send('Löschen abgebrochen. Passwort erforderlich oder Bestätigung fehlt.');
  }
});

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
// API-Endpunkte für Mitarbeiterverwaltung (admin-geschützt)
// --------------------------
app.get('/admin/employees', isAdmin, (req, res) => {
  const query = 'SELECT * FROM employees';
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).send('Fehler beim Abrufen der Mitarbeiter.');
    }
    res.json(rows);
  });
});

app.post('/admin/employees', isAdmin, (req, res) => {
  const { name, contract_hours, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) {
    return res.status(400).send('Name ist erforderlich.');
  }
  const query = 'INSERT INTO employees (name, contract_hours, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES (?, ?, ?, ?, ?, ?, ?)';
  db.run(query, [name, contract_hours || 0, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0], function(err) {
    if (err) {
      return res.status(500).send('Fehler beim Hinzufügen des Mitarbeiters.');
    }
    res.send({ id: this.lastID, name, contract_hours, mo_hours, di_hours, mi_hours, do_hours, fr_hours });
  });
});

app.put('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { name, contract_hours, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) {
    return res.status(400).send('Name ist erforderlich.');
  }
  const query = 'UPDATE employees SET name = ?, contract_hours = ?, mo_hours = ?, di_hours = ?, mi_hours = ?, do_hours = ?, fr_hours = ? WHERE id = ?';
  db.run(query, [name, contract_hours || 0, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0, id], function(err) {
    if (err) {
      return res.status(500).send('Fehler beim Aktualisieren des Mitarbeiters.');
    }
    res.send('Mitarbeiter erfolgreich aktualisiert.');
  });
});

app.delete('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM employees WHERE id = ?';
  db.run(query, [id], function(err) {
    if (err) {
      return res.status(500).send('Fehler beim Löschen des Mitarbeiters.');
    }
    res.send('Mitarbeiter erfolgreich gelöscht.');
  });
});

// --------------------------
// Neuer, öffentlicher Endpunkt für Mitarbeiter (Variante 1)
// --------------------------
app.get('/employees', (req, res) => {
  const query = 'SELECT id, name FROM employees';
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).send('Fehler beim Abrufen der Mitarbeiter.');
    }
    res.json(rows);
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

function convertDecimalHoursToHoursMinutes(decimalHours) {
  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Hilfsfunktion, um die Soll-Arbeitszeit anhand des Datums und der Mitarbeiterstammdaten zu berechnen
function getExpectedHours(row, dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay(); // 0 = Sonntag, 1 = Montag, …, 5 = Freitag, 6 = Samstag
  if (day === 1) { // Montag
    return row.mo_hours || 0;
  } else if (day === 2) { // Dienstag
    return row.di_hours || 0;
  } else if (day === 3) { // Mittwoch
    return row.mi_hours || 0;
  } else if (day === 4) { // Donnerstag
    return row.do_hours || 0;
  } else if (day === 5) { // Freitag
    return row.fr_hours || 0;
  } else {
    return 0;
  }
}

/**
 * CSV-Funktion mit den gewünschten Spalten in folgender Reihenfolge:
 * 1. Name
 * 2. Datum
 * 3. Arbeitsbeginn
 * 4. Arbeitsende
 * 5. Pause (Minuten)
 * 6. SollArbeitszeit
 * 7. IstArbeitszeit (vormals "Ist Arbeitszeit")
 * 8. Differenz
 * 9. Bemerkung
 */
function convertToCSV(data) {
  if (!data || data.length === 0) {
    return '';
  }
  const csvRows = [];
  // Neuer Header
  csvRows.push([
    "Name",
    "Datum",
    "Arbeitsbeginn",
    "Arbeitsende",
    "Pause (Minuten)",
    "SollArbeitszeit",    // <- NEU an Position 6
    "IstArbeitszeit",     // <- umbenannt und an Position 7
    "Differenz",
    "Bemerkung"
  ].join(','));

  for (const row of data) {
    const breakMinutes = (row.break_time * 60).toFixed(0);
    const istHours = row.hours;
    const expected = getExpectedHours(row, row.date);
    const diff = istHours - expected;

    // Formatierung (z.B. 2 Nachkommastellen)
    const istFormatted = istHours.toFixed(2);
    const expectedFormatted = expected.toFixed(2);
    const diffFormatted = diff.toFixed(2);

    // Spaltenreihenfolge gemäß Header
    const values = [
      row.name,            // Name
      row.date,            // Datum
      row.startTime,       // Arbeitsbeginn
      row.endTime,         // Arbeitsende
      breakMinutes,        // Pause (Minuten)
      expectedFormatted,   // SollArbeitszeit
      istFormatted,        // IstArbeitszeit
      diffFormatted,       // Differenz
      row.comment || ''    // Bemerkung
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
