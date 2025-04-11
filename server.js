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
    // Eventuell Fehler werfen oder 0 zurückgeben, je nach Anforderung
  }
  const diffInMin = endMinutes - startMinutes;
  return diffInMin / 60;
}

function getExpectedHours(employeeData, dateStr) {
  if (!employeeData || !dateStr) return 0;
  const d = new Date(dateStr);
  // WICHTIG: getDay() gibt den lokalen Wochentag zurück.
  // Für UTC-Konsistenz Date.UTC verwenden oder sicherstellen, dass Server-Zeitzone passt.
  // Besser: Date.getUTCDay() verwenden, wenn die Daten in UTC sind.
  const day = d.getUTCDay(); // 0 = Sonntag, 1 = Montag, …, 6 = Samstag (UTC)
  switch (day) {
    case 1: return employeeData.mo_hours || 0;
    case 2: return employeeData.di_hours || 0;
    case 3: return employeeData.mi_hours || 0;
    case 4: return employeeData.do_hours || 0;
    case 5: return employeeData.fr_hours || 0;
    default: return 0; // Wochenende oder fehlende Angabe
  }
}

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  // Kopfzeile anpassen, um Soll/Ist/Differenz aufzunehmen
  csvRows.push(["Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Soll-Std", "Ist-Std", "Differenz", "Bemerkung"].join(','));

  for (const row of data) {
    let dateFormatted = "";
    if (row.date) {
      try {
        // Datum als UTC interpretieren und formatieren
        const dateObj = new Date(row.date + 'T00:00:00Z'); // Annahme: Datum ist nur Tag, als UTC interpretieren
        const year = dateObj.getUTCFullYear();
        const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getUTCDate()).padStart(2, '0');
        dateFormatted = `${day}.${month}.${year}`;
      } catch (e) {
        console.error("Fehler beim Formatieren des Datums für CSV:", row.date, e);
        dateFormatted = row.date; // Fallback
      }
    }
    const startTimeFormatted = row.starttime || "";
    const endTimeFormatted = row.endtime || "";
    const istHours = row.hours || 0;
    // getExpectedHours benötigt die employeeData (mo_hours etc.), die hier übergeben wird
    const expected = getExpectedHours(row, row.date); // Annahme: employeeDaten sind im row Objekt
    const diff = istHours - expected;

    const istFormatted = istHours.toFixed(2);
    const expectedFormatted = expected.toFixed(2);
    const diffFormatted = diff.toFixed(2);
    // Kommentar sicher escapen
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;

    // Reihenfolge der Werte an Kopfzeile anpassen
    const values = [
      row.name,
      dateFormatted,
      startTimeFormatted,
      endTimeFormatted,
      expectedFormatted, // Soll
      istFormatted,      // Ist
      diffFormatted,     // Differenz
      commentFormatted
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}


// ==========================================
// Hilfsfunktion zur Berechnung der Monatsdaten
// ==========================================
async function calculateMonthlyData(db, name, year, month) {
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);

  if (!name || !year || !month || isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new Error("Ungültiger Name, Jahr oder Monat angegeben.");
  }

  const empResult = await db.query(`SELECT * FROM employees WHERE LOWER(name) = LOWER($1)`, [name]);
  if (empResult.rows.length === 0) {
    throw new Error("Mitarbeiter nicht gefunden.");
  }
  const employee = empResult.rows[0];

  // Sicherstellen, dass Daten in UTC behandelt werden
  const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Erster Tag des Folgemonats
  const startDateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const endDateStr = endDate.toISOString().split('T')[0];   // YYYY-MM-DD

  const workResult = await db.query(
    `SELECT id, date, hours, break_time, comment, 
            TO_CHAR(starttime, 'HH24:MI') AS "startTime", 
            TO_CHAR(endtime, 'HH24:MI') AS "endTime" 
     FROM work_hours 
     WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date < $3 
     ORDER BY date ASC`,
    [name.toLowerCase(), startDateStr, endDateStr]
  );
  const workEntries = workResult.rows;

  let totalDifference = 0;
  workEntries.forEach(entry => {
    // Verwende das Datum des Eintrags (wichtig für getExpectedHours)
    const expected = getExpectedHours(employee, entry.date.toISOString().split('T')[0]);
    totalDifference += (entry.hours || 0) - expected;
  });

  // Vormonat berechnen (UTC)
  let prevMonthDate = new Date(Date.UTC(parsedYear, parsedMonth - 2, 1)); // Erster Tag des Vormonats
  const prevMonthDateStr = prevMonthDate.toISOString().split('T')[0]; // YYYY-MM-DD

  const prevResult = await db.query(
    `SELECT carry_over FROM monthly_balance WHERE employee_id = $1 AND year_month = $2`,
    [employee.id, prevMonthDateStr]
  );
  let previousCarry = prevResult.rows.length > 0 ? (prevResult.rows[0].carry_over || 0) : 0;
  const newCarry = previousCarry + totalDifference;

  // Speichern des aktuellen Saldos (optional, aber konsistent mit /calculate-monthly-balance)
  const currentMonthDateStr = startDateStr; // Erster Tag des aktuellen Monats als Referenz
  const upsertQuery = `
    INSERT INTO monthly_balance (employee_id, year_month, difference, carry_over)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (employee_id, year_month) DO UPDATE SET
      difference = EXCLUDED.difference,
      carry_over = EXCLUDED.carry_over;
  `;
  await db.query(upsertQuery, [employee.id, currentMonthDateStr, totalDifference, newCarry]);

  // Rückgabe der berechneten Daten
  return {
    employeeName: employee.name, // Name explizit zurückgeben
    month: parsedMonth,
    year: parsedYear,
    monthlyDifference: parseFloat(totalDifference.toFixed(2)),
    previousCarryOver: parseFloat(previousCarry.toFixed(2)),
    newCarryOver: parseFloat(newCarry.toFixed(2)),
    workEntries: workEntries // Detaillierte Einträge für PDF zurückgeben
  };
}

// Exportieren Sie die neue Funktion, damit sie in anderen Dateien verwendet werden kann
// WICHTIG: Muss als Property von module.exports exportiert werden
module.exports.calculateMonthlyData = calculateMonthlyData;

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
      ORDER BY date DESC, starttime DESC NULLS LAST /* Berücksichtigt Einträge ohne Startzeit korrekt */
      LIMIT 1;
    `;
    const result = await db.query(query, [name]);
    let nextBooking;
    let entryId = null;
    if (result.rows.length === 0) {
      nextBooking = 'arbeitsbeginn';
    } else {
      const lastRecord = result.rows[0];
      if (lastRecord.endtime) { // Wenn die letzte Buchung ein Ende hat -> neue starten
        nextBooking = 'arbeitsbeginn';
      } else if (lastRecord.starttime) { // Wenn Startzeit aber keine Endzeit -> Ende buchen
         nextBooking = 'arbeitsende';
         entryId = lastRecord.id;
      } else { // Sollte nicht vorkommen, aber sicherheitshalber -> neu starten
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
    // Prüfen, ob für diesen Tag schon ein Eintrag OHNE Endzeit existiert
    const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
    const checkOpenResult = await db.query(checkOpenQuery, [name, date]);
    if (checkOpenResult.rows.length > 0) {
        return res.status(409).json({ message: 'Es existiert bereits ein offener Arbeitstag (ohne Ende). Bitte erst Arbeitsende buchen.' });
    }

    // Prüfen, ob für diesen Tag bereits ein abgeschlossener Eintrag existiert (optional, je nach Logik)
    // const checkClosedQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
    // const checkClosedResult = await db.query(checkClosedQuery, [name, date]);
    // if (checkClosedResult.rows.length > 0) {
    //   return res.status(409).json({ message: 'Arbeitsbeginn wurde für diesen Tag bereits erfasst und abgeschlossen.' });
    // }

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
  const { endTime, comment } = req.body; // `comment` hinzugefügt
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
      // Wenn bereits eine Endzeit existiert, könnte man hier einen Fehler werfen
      // oder erlauben, die Endzeit zu überschreiben (je nach Anforderung).
      // Aktuell wird überschrieben.
      console.warn(`Arbeitsende für ID ${entryId} wird überschrieben.`);
      // return res.status(409).json({ message: 'Arbeitsende wurde für diesen Eintrag bereits erfasst.' });
    }
    const startTime = timeResult.rows[0].starttime;
    if (!startTime) {
        return res.status(400).json({ message: 'Keine Startzeit für diesen Eintrag gefunden. Arbeitsende kann nicht gebucht werden.' });
    }

    const totalHours = calculateWorkHours(startTime, endTime);
    if (totalHours < 0) {
      return res.status(400).json({ message: 'Arbeitsende darf nicht vor Arbeitsbeginn liegen.' });
    }

    const netHours = totalHours; // Hier ggf. Pausen abziehen, falls break_time genutzt wird
    const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`;
    await db.query(updateQuery, [endTime, comment, netHours, entryId]);
    console.log(`Arbeitsende für ID ${entryId} um ${endTime} gespeichert (Netto Std: ${netHours.toFixed(2)}).`);
    res.status(200).send('Arbeitsende erfolgreich gespeichert.');
  } catch (err) {
    console.error(`Fehler beim Speichern des Arbeitsendes für ID ${entryId}:`, err);
    res.status(500).json({ message: 'Fehler beim Speichern des Arbeitsendes auf dem Server.' });
  }
});
app.get('/get-all-hours', (req, res) => { // Dieser Endpunkt wird aktuell nicht vom Frontend genutzt
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
    .then(result => {
      // Break_time war in Stunden, Konvertierung in Minuten nicht nötig, wenn Stunden gewünscht
      res.json(result.rows);
    })
    .catch(err => {
      console.error("DB Fehler in /get-all-hours:", err);
      res.status(500).send('Fehler beim Abrufen der Daten.');
    });
});

app.get('/employees', (req, res) => { // Öffentlich zugänglich für Dropdown
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
  // Verwenden Sie die Umgebungsvariable, falls gesetzt, sonst den Fallback
  const adminPassword = process.env.ADMIN_PASSWORD || "admin";

  if (!password) {
    console.warn("⚠️ Kein Passwort übermittelt für Admin-Login.");
    return res.status(400).send("Kein Passwort übermittelt.");
  }

  if (password === adminPassword) {
    req.session.isAdmin = true;
    // Optional: Regenerieren der Session ID nach Login zur Sicherheit
    req.session.regenerate((err) => {
        if(err) {
            console.error("❌ Fehler beim Regenerieren der Session nach Login:", err);
            return res.status(500).send("Session konnte nicht regeneriert werden.");
        }
        req.session.isAdmin = true; // isAdmin erneut setzen nach regenerate
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
    .then(result => {
      // Keine Konvertierung von break_time hier nötig, bleibt in Stunden
      res.json(result.rows);
    })
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
    const csv = convertToCSV(result.rows);
    const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM für UTF-8 in Excel hinzufügen
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

  // Validierung: Startzeit < Endzeit
  if (parseTime(startTime) >= parseTime(endTime)) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später oder gleich dem Arbeitsende sein.' });
  }

  const totalHours = calculateWorkHours(startTime, endTime);
  const netHours = totalHours; // Hier ggf. Pausen berücksichtigen

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

app.delete('/adminDeleteData', isAdmin, async (req, res) => { // Vorsicht mit dieser Funktion!
  try {
    // Optional: Besser TRUNCATE verwenden für Performance bei großen Tabellen
    // await db.query('TRUNCATE TABLE work_hours RESTART IDENTITY;'); // Setzt auch Zähler zurück
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
  // Konvertiere zu Zahlen, stelle sicher, dass es null ist, wenn leer/ungültig
  const mo = parseFloat(mo_hours) || null;
  const di = parseFloat(di_hours) || null;
  const mi = parseFloat(mi_hours) || null;
  const doo = parseFloat(do_hours) || null; // 'do' ist reserviert
  const fr = parseFloat(fr_hours) || null;

  const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (name) DO NOTHING RETURNING *;`; // Verhindert Duplikate basierend auf UNIQUE Constraint
  db.query(query, [name.trim(), mo, di, mi, doo, fr])
    .then(result => {
      if (result.rows.length > 0) {
        console.log(`Admin hat Mitarbeiter hinzugefügt: ${name.trim()}`);
        res.status(201).json(result.rows[0]);
      } else {
        // Wenn ON CONFLICT ausgelöst wurde, gibt es keine rows zurück
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
      // Fehler für doppelten Namen abfangen
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
  // Optional: Prüfen, ob noch Arbeitszeiten für den Mitarbeiter existieren?
  // Aktuell: Löschen erlaubt, auch wenn Zeiten existieren.
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
      // Mögliche Foreign-Key-Constraint-Fehler abfangen, falls Löschen nicht erlaubt ist
      console.error("DB Fehler in DELETE /admin/employees/:id:", err);
      res.status(500).send('Fehler beim Löschen des Mitarbeiters.');
    });
});

// Endpunkt zum Berechnen und Speichern des Saldos (jetzt mit neuer Funktion)
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;
  try {
    // Rufen Sie die extrahierte Funktion auf (übergeben Sie 'db')
    const result = await calculateMonthlyData(db, name, year, month);
    console.log(`Admin hat Monatsauswertung für ${name} (${month}/${year}) berechnet.`);
    res.json({
      message: `Monatlicher Saldo für ${result.employeeName} (${result.month}/${result.year}) berechnet und gespeichert.`,
      ...result // Gibt alle berechneten Werte zurück
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

    // Warnungen für fehlende Umgebungsvariablen
    if (!process.env.DATABASE_URL) console.warn("WARNUNG: Kein DATABASE_URL in Umgebungsvariablen gefunden.");
    if (!process.env.SESSION_SECRET) console.warn("WARNUNG: Kein SESSION_SECRET in Umgebungsvariablen gefunden. Verwende Fallback.");
    if (!process.env.ADMIN_PASSWORD) console.warn("WARNUNG: Kein ADMIN_PASSWORD in Umgebungsvariablen gefunden. Fallback auf 'admin'.");
    if (process.env.NODE_ENV !== 'production') console.warn("WARNUNG: Server läuft nicht im Produktionsmodus (NODE_ENV ist nicht 'production').");

    const server = app.listen(port, '0.0.0.0', () => { // Höre auf 0.0.0.0 für Container-Umgebungen
      console.log(`Server läuft auf Port: ${port}`);
    });

    // Funktion für sauberes Herunterfahren
    const gracefulShutdown = async (signal) => {
      console.log(`---> Graceful shutdown gestartet für Signal: ${signal}`);
      server.close(async (err) => {
        if (err) console.error("Fehler beim Schließen des HTTP-Servers:", err);
        else console.log("HTTP-Server erfolgreich geschlossen.");

        try {
          await db.end(); // Datenbankverbindungen schließen
          console.log("Datenbank-Pool erfolgreich geschlossen.");
          process.exit(err ? 1 : 0); // Beenden mit Fehlercode, falls Server schließen fehlschlug
        } catch (dbErr) {
          console.error("Fehler beim Schließen des Datenbank-Pools:", dbErr);
          process.exit(1); // Beenden mit Fehlercode
        }
      });

      // Timeout für den Fall, dass das Schließen hängt
      setTimeout(() => {
        console.error("Graceful shutdown timed out nach 10 Sekunden. Forcing exit.");
        process.exit(1);
      }, 10000); // 10 Sekunden Timeout
    };

    // Auf SIGTERM (von Railway/Heroku etc.) und SIGINT (Ctrl+C) reagieren
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
    process.exit(1); // Serverstart fehlgeschlagen -> beenden
  }
}

// Server starten
startServer();
