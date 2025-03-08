const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Session-Middleware konfigurieren
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret', // Use environment variable for session secret
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// SQLite Datenbank einrichten
const dbPath = process.env.DATABASE_URL || './work_hours.db'; // Use environment variable for database path
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
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

  // Add 'comment', 'startTime', 'endTime' fields if they do not exist
  db.all("PRAGMA table_info(work_hours)", [], (err, rows) => {
    if (err) {
      console.error("Error retrieving table information:", err);
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
});

// Middleware to check if the user is an admin
function isAdmin(req, res, next) {
  const isAdminUser = req.session.isAdmin;
  if (isAdminUser) {
    next();
  } else {
    res.status(403).send('Access denied. Admin privileges required.');
  }
}

// Route für alle Einträge (Admin)
app.get('/admin-work-hours', isAdmin, (req, res) => {
  db.all("SELECT * FROM work_hours", [], (err, rows) => {
    if (err) {
      console.error("Error retrieving work hours:", err);
      res.status(500).send('Internal Server Error');
      return;
    }
    res.json(rows);
  });
});

// Route zum Hinzufügen eines neuen Eintrags (Admin)
app.post('/api/admin/add-hours', isAdmin, (req, res) => {
  const { name, date, hours, break_time, comment, startTime, endTime } = req.body;
  const stmt = db.prepare("INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime) VALUES (?, ?, ?, ?, ?, ?, ?)");
  stmt.run(name, date, hours, break_time, comment, startTime, endTime, function(err) {
    if (err) {
      console.error("Error adding work hours:", err);
      res.status(500).send('Internal Server Error');
      return;
    }
    res.send('Work hours added successfully');
  });
  stmt.finalize();
});

// Route zum Löschen eines Eintrags (Admin)
app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM work_hours WHERE id = ?", id, function(err) {
    if (err) {
      console.error("Error deleting work hours:", err);
      res.status(500).send('Internal Server Error');
      return;
    }
    res.send('Work hours deleted successfully');
  });
});

// Route zum Herunterladen der Arbeitszeiten als CSV (Admin)
app.get('/admin-download-csv', isAdmin, (req, res) => {
  db.all("SELECT * FROM work_hours", [], (err, rows) => {
    if (err) {
      console.error("Error retrieving work hours:", err);
      res.status(500).send('Internal Server Error');
      return;
    }

    const csv = rows.map(row =>
      `${row.id},${row.name},${row.date},${row.hours},${row.break_time},${row.comment || ''},${row.startTime || ''},${row.endTime || ''}`
    ).join('\n');

    res.header('Content-Type', 'text/csv');
    res.attachment('arbeitszeiten.csv');
    return res.send(csv);
  });
});

// Route zum Löschen aller Arbeitszeiten (Admin)
app.delete('/delete-hours', (req, res) => {
  const { confirmDelete, password } = req.body;
  if (confirmDelete === 'true' && password === process.env.ADMIN_PASSWORD) {
    db.run("DELETE FROM work_hours", function(err) {
      if (err) {
        console.error("Error deleting all work hours:", err);
        res.status(500).send('Internal Server Error');
        return;
      }
      res.send('All work hours deleted successfully');
    });
  } else {
    res.status(403).send('Access denied. Invalid password.');
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
