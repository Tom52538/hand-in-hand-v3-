// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // Stellt sicher, dass index.html, style.css etc. aus 'public' geladen werden

// Session-Middleware konfigurieren
app.use(session({
  secret: process.env.SESSION_SECRET || 'bitte-unbedingt-aendern', // Sicherer aus .env laden oder generieren
  resave: false,
  saveUninitialized: true, // true ist ok für dieses Setup, aber false ist oft empfohlen
  cookie: { secure: process.env.NODE_ENV === 'production' } // Nur 'true' bei HTTPS
}));

// PostgreSQL Datenbank einrichten
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false // SSL nur in Produktion (z.B. Heroku)
});

// --- Datenbank Tabellen Setup ---
const setupTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        date DATE NOT NULL,
        hours DOUBLE PRECISION,       -- Wird erst bei Arbeitsende berechnet
        break_time DOUBLE PRECISION,  -- Wird erst bei Arbeitsende gesetzt (in Stunden!)
        comment TEXT,                 -- Wird erst bei Arbeitsende gesetzt
        starttime TIME,               -- Wird bei Arbeitsbeginn gesetzt
        endtime TIME                  -- Wird bei Arbeitsende gesetzt
      );
    `);
    console.log("Tabelle work_hours erfolgreich erstellt oder bereits vorhanden.");

    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE, -- Name sollte UNIQUE sein
        mo_hours DOUBLE PRECISION,
        di_hours DOUBLE PRECISION,
        mi_hours DOUBLE PRECISION,
        do_hours DOUBLE PRECISION,
        fr_hours DOUBLE PRECISION
      );
    `);
    console.log("Tabelle employees erfolgreich erstellt oder bereits vorhanden.");

    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- Fremdschlüssel hinzugefügt
        year_month DATE NOT NULL,  -- Format YYYY-MM-01
        difference DOUBLE PRECISION,
        carry_over DOUBLE PRECISION,
        UNIQUE (employee_id, year_month)
      );
    `);
    console.log("Tabelle monthly_balance erfolgreich erstellt oder bereits vorhanden.");

  } catch (err) {
    console.error("Fehler beim Erstellen der Datenbanktabellen:", err);
    // Beende den Prozess bei kritischem DB-Fehler beim Start
    process.exit(1);
  }
};

setupTables(); // Führe das Setup beim Start aus

// --- Middleware für Admin-Check ---
function isAdmin(req, res, next) {
  // ACHTUNG: In einer echten Anwendung sollte die Admin-Prüfung robuster sein!
  if (req.session && req.session.isAdmin) { // Sicherstellen, dass session existiert
    next();
  } else {
    console.warn("isAdmin Check fehlgeschlagen. Session:", req.session); // Debugging Log
    res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich.');
  }
}

// --------------------------
// Hilfsfunktionen für Zeitberechnung
// --------------------------
// Wandelt HH:MM String in Minuten seit Mitternacht um
function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0; // Fehlerbehandlung
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

// Berechnet die Differenz zwischen zwei HH:MM Zeiten in Stunden
function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0; // Fehlerbehandlung
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  // Umgang mit Tageswechsel (optional, hier nicht implementiert)
  if (endMinutes < startMinutes) {
      // Beispiel: Arbeit über Mitternacht - hier nicht unterstützt, gibt negative Zeit
      console.warn("Arbeitsende liegt vor Arbeitsbeginn - Berechnung könnte falsch sein.");
      // return ((24 * 60 - startMinutes) + endMinutes) / 60; // Beispiel für Mitternacht
  }
  const diffInMin = endMinutes - startMinutes;
  return diffInMin / 60; // Ergebnis in Stunden
}

// Holt die Sollstunden für einen Mitarbeiter an einem bestimmten Datum
function getExpectedHours(employeeData, dateStr) {
  if (!employeeData || !dateStr) return 0;
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // Verwende UTC Day, um Zeitzonenprobleme zu vermeiden (0=So, 1=Mo...)
  switch (day) {
    case 1: return employeeData.mo_hours || 0;
    case 2: return employeeData.di_hours || 0;
    case 3: return employeeData.mi_hours || 0;
    case 4: return employeeData.do_hours || 0;
    case 5: return employeeData.fr_hours || 0;
    default: return 0; // Wochenende
  }
}

// Konvertiert DB-Daten in CSV
function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  // Header
  csvRows.push([
    "Name", "Datum", "Arbeitsbeginn", "Arbeitsende",
    "Pause (Minuten)", "SollArbeitszeit", "IstArbeitszeit", "Differenz", "Bemerkung"
  ].join(','));
  // Rows
  for (const row of data) {
    // Formatierung des Datums sicherstellen
    let dateFormatted = "";
    if (row.date) {
        try {
             // Stelle sicher, dass das Datum als UTC behandelt wird, um Zeitzonenverschiebungen zu vermeiden
             const dateObj = new Date(row.date);
             const year = dateObj.getUTCFullYear();
             const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
             const day = String(dateObj.getUTCDate()).padStart(2, '0');
             dateFormatted = `${day}.${month}.${year}`;
        } catch (e) {
            console.error("Fehler beim Formatieren des Datums für CSV:", row.date, e);
            dateFormatted = row.date; // Fallback
        }
    }

    const startTimeFormatted = row.startTime || ""; // Annahme: Kommt als HH:MM
    const endTimeFormatted = row.endTime || "";     // Annahme: Kommt als HH:MM
    const breakMinutes = row.break_time ? (row.break_time * 60).toFixed(0) : "0"; // DB speichert Stunden
    const istHours = row.hours || 0;
    const expected = getExpectedHours(row, row.date); // Braucht Mitarbeiterdaten (row muss auch employee hours enthalten!)
    const diff = istHours - expected;
    const istFormatted = istHours.toFixed(2);
    const expectedFormatted = expected.toFixed(2);
    const diffFormatted = diff.toFixed(2);
    // Sicherstellen, dass Kommentare mit Kommas korrekt behandelt werden (in Anführungszeichen)
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;

    const values = [
      row.name, dateFormatted, startTimeFormatted, endTimeFormatted,
      breakMinutes, expectedFormatted, istFormatted, diffFormatted, commentFormatted
    ];
    csvRows.push(values.map(v => `${v}`).join(',')); // Alle Werte in Strings umwandeln
  }
  return csvRows.join('\n');
}


// ==========================================
// NEUE API Endpunkte für sofortiges Speichern
// ==========================================

// POST /log-start : Speichert den Arbeitsbeginn
app.post('/log-start', async (req, res) => {
  const { name, date, startTime } = req.body;
  if (!name || !date || !startTime) {
    return res.status(400).json({ message: 'Name, Datum und Startzeit sind erforderlich.' });
  }
  const insertQuery = `
    INSERT INTO work_hours (name, date, starttime, endtime, hours, break_time, comment)
    VALUES ($1, $2, $3, NULL, NULL, NULL, NULL)
    RETURNING id;
  `;
  try {
    const result = await db.query(insertQuery, [name, date, startTime]);
    if (result.rows.length > 0) {
      const newEntryId = result.rows[0].id;
      console.log(`Arbeitsbeginn für ${name} am ${date} um ${startTime} gespeichert mit ID: ${newEntryId}`);
      res.status(201).json({ id: newEntryId });
    } else {
      throw new Error("Eintrag konnte nicht erstellt werden, keine ID zurückgegeben.");
    }
  } catch (err) {
    console.error("Fehler beim Speichern des Arbeitsbeginns:", err);
    res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsbeginns auf dem Server.' });
  }
});

// PUT /log-end/:id : Speichert das Arbeitsende, Pause und Kommentar für einen Eintrag
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, breakTime, comment } = req.body; // breakTime kommt in Minuten vom Frontend
  if (!endTime) { return res.status(400).json({ message: 'Endzeit ist erforderlich.' }); }
  if (!id || isNaN(parseInt(id))) { return res.status(400).json({ message: 'Gültige Eintrags-ID ist erforderlich.' }); }

  const entryId = parseInt(id);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60.0;

  try {
    const timeResult = await db.query('SELECT starttime FROM work_hours WHERE id = $1', [entryId]);
    if (timeResult.rows.length === 0) { return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` }); }
    const startTime = timeResult.rows[0].starttime;

    const totalHours = calculateWorkHours(startTime, endTime);
    if (totalHours < 0) { return res.status(400).json({ message: 'Arbeitsende darf nicht vor Arbeitsbeginn liegen.' }); }
    const netHours = Math.max(0, totalHours - breakTimeHours);

    const updateQuery = `
      UPDATE work_hours SET endtime = $1, break_time = $2, comment = $3, hours = $4 WHERE id = $5;`;
    await db.query(updateQuery, [endTime, breakTimeHours, comment, netHours, entryId]);

    console.log(`Arbeitsende für ID ${entryId} um ${endTime} gespeichert.`);
    res.status(200).send('Arbeitsende erfolgreich gespeichert.');
  } catch (err) {
    console.error(`Fehler beim Speichern des Arbeitsendes für ID ${entryId}:`, err);
    res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsendes auf dem Server.' });
  }
});


// --------------------------
// Bestehende API-Endpunkte (teilweise angepasst oder auskommentiert)
// --------------------------

// POST /log-hours : Alter Endpunkt, auskommentiert
/*
app.post('/log-hours', (req, res) => {
  // ...
});
*/

// GET /get-all-hours : Holt alle Stunden für einen Mitarbeiter
app.get('/get-all-hours', (req, res) => {
  const { name } = req.query;
  if (!name) { return res.status(400).send('Name ist erforderlich.'); }
  const query = `
    SELECT id, name, date, hours, (break_time * 60) AS break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours WHERE LOWER(name) = LOWER($1) ORDER BY date ASC, starttime ASC;`;
  db.query(query, [name])
    .then(result => {
        const rowsWithMinutes = result.rows.map(row => ({
            ...row, break_time: Math.round((row.break_time || 0) * 60) }));
        res.json(rowsWithMinutes);
    })
    .catch(err => { console.error("DB Fehler in /get-all-hours:", err); res.status(500).send('Fehler beim Abrufen der Daten.'); });
});

// GET /get-hours : Holt einen spezifischen Eintrag
app.get('/get-hours', (req, res) => {
  const { name, date } = req.query;
  const query = `
    SELECT id, name, date, hours, (break_time * 60) AS break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2;`;
  db.query(query, [name, date])
    .then(result => {
      if (result.rows.length === 0) { return res.status(404).send('Keine Daten gefunden.'); }
       const rowWithMinutes = { ...result.rows[0], break_time: Math.round((result.rows[0].break_time || 0) * 60) };
      res.json(rowWithMinutes);
    })
    .catch(err => { console.error("DB Fehler in /get-hours:", err); res.status(500).send('Fehler beim Abrufen der Daten.'); });
});

// DELETE /delete-hours : Löscht ALLE Einträge
app.delete('/delete-hours', isAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM work_hours'); // Keine weitere Passwortabfrage nötig, da isAdmin geprüft wurde
    res.send('Alle Arbeitszeiten erfolgreich gelöscht.');
  } catch (err) {
    console.error("DB Fehler in /delete-hours:", err);
    res.status(500).send('Fehler beim Löschen der Daten.');
  }
});

// --- Admin Login --- (Mit explizitem Session-Save)
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  // Passwortprüfung zurück auf hardcoded "admin" geändert
  if (password && password === "admin") {
    req.session.isAdmin = true; // Flag in der Session setzen

    // Session explizit speichern, bevor die Antwort gesendet wird
    req.session.save(err => {
      if (err) {
        console.error("Fehler beim Speichern der Session:", err);
        // Session-Flag sicherheitshalber zurücksetzen und Fehler senden
        req.session.isAdmin = false;
        // Optional: Session zerstören bei Speicherfehler? req.session.destroy(...)
        return res.status(500).send('Fehler bei der Serververarbeitung (Session).');
      }
      // Session erfolgreich gespeichert, jetzt Antwort senden
      console.log("Session gespeichert, isAdmin:", req.session.isAdmin); // Debugging Log
      res.send('Admin erfolgreich angemeldet.');
    });

  } else {
    req.session.isAdmin = false; // Sicherstellen, dass Flag bei Fehlversuch nicht gesetzt ist
    // Hier muss nicht gespeichert werden, da keine relevante Änderung am Session-Objekt erfolgte
    res.status(401).send('Ungültiges Passwort.');
  }
});


// --- Mitarbeiterverwaltung Endpunkte ---
app.get('/admin/employees', isAdmin, (req, res) => {
  const query = 'SELECT * FROM employees ORDER BY name ASC';
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => { console.error("DB Fehler in GET /admin/employees:", err); res.status(500).send('Fehler beim Abrufen der Mitarbeiter.'); });
});

app.post('/admin/employees', isAdmin, (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) { return res.status(400).send('Name ist erforderlich.'); }
  const query = `
    INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (name) DO NOTHING RETURNING *;`;
  db.query(query, [name, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0])
    .then(result => {
        if (result.rows.length > 0) { res.status(201).json(result.rows[0]); }
        else { res.status(409).send(`Mitarbeiter mit Namen '${name}' existiert bereits.`); }
    })
    .catch(err => { console.error("DB Fehler in POST /admin/employees:", err); res.status(500).send('Fehler beim Hinzufügen des Mitarbeiters.'); });
});

app.put('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) { return res.status(400).send('Name ist erforderlich.'); }
  if (isNaN(parseInt(id))) { return res.status(400).send('Ungültige ID.'); }
  const query = `
    UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
  db.query(query, [name, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0, parseInt(id)])
    .then(result => {
        if (result.rowCount > 0) { res.send('Mitarbeiter erfolgreich aktualisiert.'); }
        else { res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`); }
    })
    .catch(err => {
        if (err.code === '23505') { res.status(409).send(`Ein anderer Mitarbeiter mit dem Namen '${name}' existiert bereits.`); }
        else { console.error("DB Fehler in PUT /admin/employees/:id:", err); res.status(500).send('Fehler beim Aktualisieren des Mitarbeiters.'); }
    });
});

app.delete('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
   if (isNaN(parseInt(id))) { return res.status(400).send('Ungültige ID.'); }
  const query = 'DELETE FROM employees WHERE id = $1';
  db.query(query, [parseInt(id)])
    .then(result => {
        if (result.rowCount > 0) { res.send('Mitarbeiter erfolgreich gelöscht.'); }
        else { res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`); }
    })
    .catch(err => { console.error("DB Fehler in DELETE /admin/employees/:id:", err); res.status(500).send('Fehler beim Löschen des Mitarbeiters.'); });
});

// GET /employees (Öffentlich für Dropdown)
app.get('/employees', (req, res) => {
  const query = 'SELECT id, name FROM employees ORDER BY name ASC';
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => { console.error("DB Fehler in GET /employees:", err); res.status(500).send('Fehler beim Abrufen der Mitarbeiter.'); });
});


// --- Monatsabschluss Endpunkt ---
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;
  if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month))) {
    return res.status(400).send("Bitte gültigen Namen, Jahr und Monat angeben.");
  }
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);

  try {
    const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name]);
    if (empResult.rows.length === 0) { return res.status(404).send("Mitarbeiter nicht gefunden."); }
    const employee = empResult.rows[0];

    const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
    const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Einträge für den Mitarbeiter im Monat holen
    // WICHTIG: Annahme, dass work_hours.name den Mitarbeiternamen enthält. Wenn eine employee_id Spalte verwendet wird, muss die Query angepasst werden!
    const workResult = await db.query(
       `SELECT date, hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3`,
      [name, startDateStr, endDateStr]
    );
    const workEntries = workResult.rows;

    // Differenz berechnen
    let totalDifference = 0;
    workEntries.forEach(entry => {
      const expected = getExpectedHours(employee, entry.date); // getExpectedHours braucht employee Daten
      totalDifference += (entry.hours || 0) - expected;
    });

    // Vormonatssaldo holen
    let prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1));
    const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0];
    const prevResult = await db.query(
      `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
      [employee.id, prevMonthDateStr] // Benötigt employee.id
    );
    let previousCarry = prevResult.rows.length > 0 ? (prevResult.rows[0].carry_over || 0) : 0;

    // Neuen Saldo berechnen
    const newCarry = previousCarry + totalDifference;
    const currentMonthDateStr = startDateStr;

    // Upsert
    const upsertQuery = `
      INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over) VALUES ($1, $2, $3, $4)
      ON CONFLICT (employee_id, year_month) DO UPDATE SET difference = $3, carry_over = $4`;
    await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);

    res.send(`Monatlicher Saldo für ${name} (${parsedMonth}/${parsedYear}): Differenz ${totalDifference.toFixed(2)} Std, Neuer Saldo ${newCarry.toFixed(2)} Std.`);
  } catch (error) {
    console.error("Fehler beim Berechnen des monatlichen Saldo:", error);
    res.status(500).send("Fehler beim Berechnen des monatlichen Saldo.");
  }
});


// --- API-Endpunkte für Arbeitszeiten (Admin - Rest) ---
app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = `
    SELECT id, name, date, hours, (break_time * 60) AS break_time, comment,
           TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
    FROM work_hours ORDER BY date DESC, name ASC, starttime ASC;`;
  db.query(query)
    .then(result => {
        const rowsWithMinutes = result.rows.map(row => ({ ...row, break_time: Math.round((row.break_time || 0) * 60) }));
        res.json(rowsWithMinutes);
    })
    .catch(err => { console.error("DB Fehler in GET /admin-work-hours:", err); res.status(500).send('Fehler beim Abrufen der Admin-Arbeitszeiten.'); });
});

app.get('/admin-download-csv', isAdmin, async (req, res) => {
  const query = `
    SELECT w.*, e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours
    FROM work_hours w LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
    ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`;
  try {
      const result = await db.query(query);
      // convertToCSV erwartet, dass die employee-Stunden direkt in den Zeilen sind (was durch den JOIN der Fall ist)
      const csv = convertToCSV(result.rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
      res.send(Buffer.from(csv, 'utf-8'));
  } catch (err) {
      console.error("DB Fehler in GET /admin-download-csv:", err);
      res.status(500).send('Fehler beim Erstellen des CSV-Downloads.');
  }
});

app.put('/api/admin/update-hours', isAdmin, (req, res) => {
  const { id, name, date, startTime, endTime, comment, breakTime } = req.body;
  if (isNaN(parseInt(id))) { return res.status(400).send('Ungültige ID.'); }
  if (!name || !date || !startTime || !endTime) { return res.status(400).send('Alle Zeitfelder und Name sind erforderlich.'); }
  if (parseTime(startTime) >= parseTime(endTime)) { return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' }); }

  const totalHours = calculateWorkHours(startTime, endTime);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60.0;
  const netHours = Math.max(0, totalHours - breakTimeHours);

  const query = `
    UPDATE work_hours SET name = $1, date = $2, hours = $3, break_time = $4, comment = $5, starttime = $6, endtime = $7 WHERE id = $8;`;
  db.query(query, [name, date, netHours, breakTimeHours, comment, startTime, endTime, parseInt(id)])
    .then(result => {
        if (result.rowCount > 0) { res.send('Arbeitszeit erfolgreich aktualisiert.'); }
        else { res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`); }
    })
    .catch(err => { console.error("DB Fehler in PUT /api/admin/update-hours:", err); res.status(500).send('Fehler beim Aktualisieren der Arbeitszeit.'); });
});

app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const { id } = req.params;
   if (isNaN(parseInt(id))) { return res.status(400).send('Ungültige ID.'); }
  const query = 'DELETE FROM work_hours WHERE id = $1';
  db.query(query, [parseInt(id)])
    .then(result => {
        if (result.rowCount > 0) { res.send('Arbeitszeit erfolgreich gelöscht.'); }
        else { res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`); }
    })
    .catch(err => { console.error("DB Fehler in DELETE /api/admin/delete-hours/:id:", err); res.status(500).send('Fehler beim Löschen der Arbeitszeit.'); });
});


// --- Server Start ---
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
   if(!process.env.DATABASE_URL) {
       console.warn("WARNUNG: Kein DATABASE_URL in Umgebungsvariablen gefunden. Datenbankverbindung wird fehlschlagen!");
   }
    if(process.env.NODE_ENV !== 'production') {
        console.warn("WARNUNG: Server läuft nicht im Produktionsmodus (NODE_ENV!=production). SSL für DB und Cookies evtl. deaktiviert.");
    }
});
