// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const app = express();
const cors = require("cors");

// Importiere die ausgelagerten Funktionen
const { calculateMonthlyData, getExpectedHours } = require('./utils/calculationUtils'); // NEUER IMPORT

app.use(cors({
  // ACHTUNG: Für Produktion die spezifische Domain verwenden
  // origin: "https://hand-in-hand-v3.up.railway.app",
  origin: "*", // Für lokale Tests oder wenn CORS-Probleme bestehen, sonst spezifischer!
  credentials: true
}));

app.set('trust proxy', 1); // Vertrauen des Proxys (wichtig z. B. für Heroku/Railway)

const port = process.env.PORT || 8080; // Fallback-Port hinzugefügt

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // Frontend-Dateien aus dem Ordner "public"

// PostgreSQL-Datenbank einrichten
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Session Store konfigurieren
const sessionStore = new pgSession({
  pool: db,
  tableName: 'user_sessions',
  createTableIfMissing: true,
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'fallback-geheimnis-unbedingt-aendern',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Für lokale Tests sicherstellen, dass secure: false ist
    secure: process.env.NODE_ENV === 'production' ? true : false,
    // sameSite: 'lax' oder 'none' wenn nötig (bei 'none' MUSS secure: true sein)
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // z.B. 1 Tag Gültigkeit
  },
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
      );
    `);
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
      );
    `);
    console.log("Tabelle employees erfolgreich geprüft/erstellt.");

    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        year_month DATE NOT NULL,
        difference DOUBLE PRECISION,
        carry_over DOUBLE PRECISION,
        UNIQUE (employee_id, year_month)
      );
    `);
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
// Hilfsfunktionen für Zeitberechnung (parseTime, calculateWorkHours, convertToCSV)
// getExpectedHours wurde nach utils/calculationUtils.js verschoben
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
    // Eventuell Fehler werfen oder 0 zurückgeben, je nach Anforderung
  }
  const diffInMin = endMinutes - startMinutes;
  return diffInMin / 60;
}

// Die Funktion getExpectedHours wurde entfernt und wird jetzt aus utils importiert.

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  // Kopfzeile anpassen, um Soll/Ist/Differenz aufzunehmen
  csvRows.push(["Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Soll-Std", "Ist-Std", "Differenz", "Bemerkung"].join(','));

  for (const row of data) {
    let dateFormatted = "";
    if (row.date) {
      try {
        const dateObj = new Date(row.date + 'T00:00:00Z'); // Als UTC interpretieren
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
    const istHours = row.hours || 0;
    // getExpectedHours wird jetzt importiert und hier verwendet
    const expected = getExpectedHours(row, row.date.toISOString().split('T')[0]); // Benötigt employee Daten im row Objekt
    const diff = istHours - expected;

    const istFormatted = istHours.toFixed(2);
    const expectedFormatted = expected.toFixed(2);
    const diffFormatted = diff.toFixed(2);
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;

    const values = [
      row.name,
      dateFormatted,
      startTimeFormatted,
      endTimeFormatted,
      expectedFormatted,
      istFormatted,
      diffFormatted,
      commentFormatted
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

// Die Funktion calculateMonthlyData wurde entfernt und wird jetzt aus utils importiert.
// Der Export module.exports.calculateMonthlyData wurde ebenfalls entfernt.

// ==========================================
// Health Check Endpunkt
// ==========================================
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});
// ==========================================
// API Endpunkte für Zeiterfassung
// ==========================================

app.get('/next-booking', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  try {
    const query = `
      SELECT id, name, date, starttime, endtime
      FROM work_hours
      WHERE LOWER(name) = LOWER($1)
      ORDER BY date DESC, starttime DESC NULLS LAST
      LIMIT 1;
    `;
    const result = await db.query(query, [name]);
    let nextBooking;
    let entryId = null;
    if (result.rows.length === 0) {
      nextBooking = 'arbeitsbeginn';
    } else {
      const lastRecord = result.rows[0];
      if (lastRecord.endtime) {
        nextBooking = 'arbeitsbeginn';
      } else if (lastRecord.starttime) {
         nextBooking = 'arbeitsende';
         entryId = lastRecord.id;
      } else {
         nextBooking = 'arbeitsbeginn';
      }
    }
    res.json({ nextBooking, id: entryId });
  } catch (err) {
    console.error("Fehler beim Abrufen der nächsten Buchung:", err);
    res.status(500).json({ message: 'Fehler beim Abrufen der nächsten Buchung.' });
  }
});

app.post('/log-start', async (req, res) => {
  const { name, date, startTime } = req.body;
  if (!name || !date || !startTime) {
    return res.status(400).json({ message: 'Name, Datum und Startzeit sind erforderlich.' });
  }
  try {
    const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
    const checkOpenResult = await db.query(checkOpenQuery, [name, date]);
    if (checkOpenResult.rows.length > 0) {
        return res.status(409).json({ message: 'Es existiert bereits ein offener Arbeitstag (ohne Ende). Bitte erst Arbeitsende buchen.' });
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

app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, comment } = req.body;
  if (!endTime) {
    return res.status(400).json({ message: 'Endzeit ist erforderlich.' });
  }
  if (!id || isNaN(parseInt(id))) {
    return res.status(400).json({ message: 'Gültige Eintrags-ID ist erforderlich.' });
  }
  const entryId = parseInt(id);
  try {
    const timeResult = await db.query('SELECT starttime, endtime FROM work_hours WHERE id = $1', [entryId]);
    if (timeResult.rows.length === 0) {
      return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
    }
    if (timeResult.rows[0].endtime) {
      console.warn(`Arbeitsende für ID ${entryId} wird überschrieben.`);
    }
    const startTime = timeResult.rows[0].starttime;
    if (!startTime) {
        return res.status(400).json({ message: 'Keine Startzeit für diesen Eintrag gefunden. Arbeitsende kann nicht gebucht werden.' });
    }

    const totalHours = calculateWorkHours(startTime, endTime);
    if (totalHours < 0) {
      return res.status(400).json({ message: 'Arbeitsende darf nicht vor Arbeitsbeginn liegen.' });
    }

    const netHours = totalHours;
    const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`;
    await db.query(updateQuery, [endTime, comment, netHours, entryId]);
    console.log(`Arbeitsende für ID ${entryId} um ${endTime} gespeichert (Netto Std: ${netHours.toFixed(2)}).`);
    res.status(200).send('Arbeitsende erfolgreich gespeichert.');
  } catch (err) {
    console.error(`Fehler beim Speichern des Arbeitsendes für ID ${entryId}:`, err);
    res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsendes auf dem Server.' });
  }
});

app.get('/get-all-hours', (req, res) => { // Wird aktuell nicht genutzt
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const query = `
    SELECT id, name, date, hours, break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime",
           TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours WHERE LOWER(name) = LOWER($1)
    ORDER BY date ASC, starttime ASC;
  `;
  db.query(query, [name])
    .then(result => res.json(result.rows))
    .catch(err => {
      console.error("DB Fehler in /get-all-hours:", err);
      res.status(500).send('Fehler beim Abrufen der Daten.');
    });
});

app.get('/employees', (req, res) => { // Öffentlich für Dropdown
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
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "admin";

  if (!password) {
    console.warn("⚠️ Kein Passwort übermittelt für Admin-Login.");
    return res.status(400).send("Kein Passwort übermittelt.");
  }

  if (password === adminPassword) {
    req.session.regenerate((err) => {
        if(err) {
            console.error("❌ Fehler beim Regenerieren der Session nach Login:", err);
            return res.status(500).send("Session konnte nicht regeneriert werden.");
        }
        req.session.isAdmin = true;
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error("❌ Fehler beim Speichern der Session nach Login:", saveErr);
            return res.status(500).send("Session konnte nicht gespeichert werden.");
          }
          console.log("✅ Admin erfolgreich angemeldet, Session gespeichert/regeneriert.");
          res.status(200).send("Admin angemeldet.");
        });
    });
  } else {
    console.warn("⚠️ Ungültiges Admin-Passwort versucht.");
    res.status(401).send("Ungültiges Admin-Passwort.");
  }
});

app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = `
    SELECT id, name, date, hours, break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime",
           TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours
    ORDER BY date DESC, name ASC, starttime ASC;
  `;
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => {
      console.error("DB Fehler in GET /admin-work-hours:", err);
      res.status(500).send('Fehler beim Abrufen der Admin-Arbeitszeiten.');
    });
});

app.get('/admin-download-csv', isAdmin, async (req, res) => {
  const query = `
    SELECT w.*, e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours
    FROM work_hours w LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
    ORDER BY w.date ASC, w.name ASC, w.starttime ASC;
  `;
  try {
    const result = await db.query(query);
    const csv = convertToCSV(result.rows); // Nutzt die lokale convertToCSV Funktion
    const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csv, 'utf-8')]));
  } catch (err) {
    console.error("DB Fehler in GET /admin-download-csv:", err);
    res.status(500).send('Fehler beim Erstellen des CSV-Downloads.');
  }
});

app.put('/api/admin/update-hours', isAdmin, (req, res) => {
  const { id, name, date, startTime, endTime, comment } = req.body;
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
  if (!name || !date || !startTime || !endTime) return res.status(400).send('Name, Datum, Start- und Endzeit sind erforderlich.');

  if (parseTime(startTime) >= parseTime(endTime)) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später oder gleich dem Arbeitsende sein.' });
  }

  const totalHours = calculateWorkHours(startTime, endTime); // Nutzt lokale Funktion
  const netHours = totalHours;

  const query = `UPDATE work_hours SET name = $1, date = $2, hours = $3,
                 comment = $4, starttime = $5, endtime = $6 WHERE id = $7;`;
  db.query(query, [name, date, netHours, comment, startTime, endTime, parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) {
          console.log(`Admin hat Eintrag ID ${id} aktualisiert.`);
          res.send('Arbeitszeit erfolgreich aktualisiert.');
      } else {
          res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`);
      }
    })
    .catch(err => {
      console.error("DB Fehler in PUT /api/admin/update-hours:", err);
      res.status(500).send('Fehler beim Aktualisieren der Arbeitszeit.');
    });
});

app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
  const query = 'DELETE FROM work_hours WHERE id = $1';
  db.query(query, [parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) {
          console.log(`Admin hat Eintrag ID ${id} gelöscht.`);
          res.send('Arbeitszeit erfolgreich gelöscht.');
      } else {
          res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`);
      }
    })
    .catch(err => {
      console.error("DB Fehler in DELETE /api/admin/delete-hours/:id:", err);
      res.status(500).send('Fehler beim Löschen der Arbeitszeit.');
    });
});

app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM work_hours');
    console.log("!!! Admin hat ALLE Arbeitszeiten gelöscht !!!");
    res.send('Alle Arbeitszeiten erfolgreich gelöscht.');
  } catch (err) {
    console.error("DB Fehler in /adminDeleteData:", err);
    res.status(500).send('Fehler beim Löschen aller Arbeitszeiten.');
  }
});
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
  if (!name || name.trim() === '') return res.status(400).send('Name ist erforderlich.');
  const mo = parseFloat(mo_hours) || null;
  const di = parseFloat(di_hours) || null;
  const mi = parseFloat(mi_hours) || null;
  const doo = parseFloat(do_hours) || null;
  const fr = parseFloat(fr_hours) || null;

  const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (name) DO NOTHING RETURNING *;`;
  db.query(query, [name.trim(), mo, di, mi, doo, fr])
    .then(result => {
      if (result.rows.length > 0) {
        console.log(`Admin hat Mitarbeiter hinzugefügt: ${name.trim()}`);
        res.status(201).json(result.rows[0]);
      } else {
        res.status(409).send(`Mitarbeiter mit Namen '${name.trim()}' existiert bereits.`);
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
  if (!name || name.trim() === '') return res.status(400).send('Name ist erforderlich.');
  if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');

  const mo = parseFloat(mo_hours) || null;
  const di = parseFloat(di_hours) || null;
  const mi = parseFloat(mi_hours) || null;
  const doo = parseFloat(do_hours) || null;
  const fr = parseFloat(fr_hours) || null;

  const query = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
  db.query(query, [name.trim(), mo, di, mi, doo, fr, parseInt(id)])
    .then(result => {
      if (result.rowCount > 0) {
        console.log(`Admin hat Mitarbeiter ID ${id} aktualisiert.`);
        res.send('Mitarbeiter erfolgreich aktualisiert.');
      }
      else res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`);
    })
    .catch(err => {
      if (err.code === '23505' && err.constraint === 'employees_name_key') {
          res.status(409).send(`Ein anderer Mitarbeiter mit dem Namen '${name.trim()}' existiert bereits.`);
      } else {
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
      if (result.rowCount > 0) {
          console.log(`Admin hat Mitarbeiter ID ${id} gelöscht.`);
          res.send('Mitarbeiter erfolgreich gelöscht.');
      } else {
          res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`);
      }
    })
    .catch(err => {
      console.error("DB Fehler in DELETE /admin/employees/:id:", err);
      res.status(500).send('Fehler beim Löschen des Mitarbeiters.');
    });
});

// Endpunkt zum Berechnen und Speichern des Saldos (jetzt mit importierter Funktion)
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;
  try {
    // Ruft die importierte Funktion aus utils/calculationUtils.js auf
    const result = await calculateMonthlyData(db, name, year, month);
    console.log(`Admin hat Monatsauswertung für ${name} (${month}/${year}) berechnet.`);
    res.json({
      message: `Monatlicher Saldo für ${result.employeeName} (${result.month}/${result.year}) berechnet und gespeichert.`,
      ...result
    });
  } catch (error) {
    console.error("Fehler beim Berechnen des monatlichen Saldo (Endpunkt):", error);
    if (error.message === "Mitarbeiter nicht gefunden." || error.message.startsWith("Ungültiger Name")) {
        res.status(400).send(error.message);
    } else {
        res.status(500).send("Serverfehler beim Berechnen des monatlichen Saldo.");
    }
  }
});


// ==========================================
// PDF Endpunkt einbinden und db übergeben
// ==========================================
// ACHTUNG: Pfad anpassen, falls monthlyPdfEndpoint.js woanders liegt!
const monthlyPdfEndpointFactory = require('./routes/monthlyPdfEndpoint');
app.use('/', monthlyPdfEndpointFactory(db)); // Übergibt db an die Factory-Funktion


// --- Server starten und Graceful Shutdown ---
async function startServer() {
  try {
    await setupTables();
    console.log("Datenbank-Setup abgeschlossen.");

    if (!process.env.DATABASE_URL) console.warn("WARNUNG: Kein DATABASE_URL in Umgebungsvariablen gefunden.");
    if (!process.env.SESSION_SECRET) console.warn("WARNUNG: Kein SESSION_SECRET in Umgebungsvariablen gefunden. Verwende Fallback.");
    if (!process.env.ADMIN_PASSWORD) console.warn("WARNUNG: Kein ADMIN_PASSWORD in Umgebungsvariablen gefunden. Fallback auf 'admin'.");
    if (process.env.NODE_ENV !== 'production') console.warn("WARNUNG: Server läuft nicht im Produktionsmodus (NODE_ENV ist nicht 'production').");

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

// Server starten
startServer();
