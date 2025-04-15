// server.js

// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

// Benötigte Module importieren
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cors = require("cors");

// === NEU: Importiere den PDF-Router ===
// Annahme: monthlyPdfEndpoint_js.txt wurde nach ./routes/monthlyPdfEndpoint.js verschoben
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
// Falls die Datei im Root-Verzeichnis bleibt:
// const monthlyPdfRouter = require('./monthlyPdfEndpoint_js.txt'); // Pfad anpassen!

const app = express();

// Importiere externe Berechnungsfunktionen
const { calculateMonthlyData, getExpectedHours } = require('./utils/calculationUtils');

// --- HILFSFUNKTIONEN ---
function parseTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);

  // Behandlung von Arbeit über Mitternacht (einfache Annahme: Endzeit < Startzeit bedeutet nächster Tag)
  let diffInMin = endMinutes - startMinutes;
  if (diffInMin < 0) {
    console.warn(`Mögliche Arbeit über Mitternacht erkannt (${startTime} - ${endTime}). Addiere 24 Stunden.`);
    diffInMin += 24 * 60; // 24 Stunden in Minuten addieren
  }

  // Plausibilitätscheck (z.B. nicht mehr als 24h)
  if (diffInMin > 24 * 60) {
      console.warn(`Berechnete Arbeitszeit über 24h (${(diffInMin/60).toFixed(2)}h) für ${startTime}-${endTime}. Prüfen! Setze auf 0.`);
      return 0; // Oder einen anderen Fehlerwert
  }

  return diffInMin / 60; // Ergebnis in Stunden
}

// Konvertiert Daten in CSV-Format (angepasst für bessere Datums- und Fehlerbehandlung)
async function convertToCSV(db, data) {
    if (!data || data.length === 0) return '';
    const csvRows = [];
    // Spalten für CSV definieren
    const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std", "Differenz", "Bemerkung"];
    csvRows.push(headers.join(','));

    // Mitarbeiterdaten für Soll-Stunden-Berechnung sammeln (effizienter als Einzelabfragen)
    const employeeNames = [...new Set(data.map(row => row.name))];
    let employeesData = {};
    if (employeeNames.length > 0) {
        try {
            const empQuery = `SELECT name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees WHERE name = ANY($1::text[])`;
            const empResult = await db.query(empQuery, [employeeNames]);
            empResult.rows.forEach(emp => {
                // Speichere Mitarbeiterdaten unter dem Namen (Kleinschreibung für robusten Vergleich)
                employeesData[emp.name.toLowerCase()] = emp;
            });
        } catch(dbError) {
            console.error("Fehler beim Abrufen der Mitarbeiterdaten für CSV:", dbError);
            // Weitermachen ohne Soll-Stunden, falls Abruf fehlschlägt
        }
    }

    for (const row of data) {
        let dateFormatted = "";
        let dateStringForCalc = null;
        if (row.date) {
            try {
                const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
                // Format für CSV (dd.mm.yyyy)
                dateFormatted = dateObj.toLocaleDateString('de-DE', { timeZone: 'UTC' });
                // Format für getExpectedHours (yyyy-mm-dd)
                dateStringForCalc = dateObj.toISOString().split('T')[0];
            } catch (e) {
                dateFormatted = String(row.date); // Fallback
                console.warn("CSV Datumsformat Fehler:", row.date, e);
            }
        }

        const startTimeFormatted = row.startTime || ""; // Verwende die bereits formattierten Zeiten, falls vorhanden
        const endTimeFormatted = row.endTime || "";
        const istHours = parseFloat(row.hours) || 0;

        let expected = 0;
        // Soll-Stunden nur berechnen, wenn Mitarbeiterdaten vorhanden sind und Datum gültig ist
        const employee = employeesData[row.name?.toLowerCase()];
        if (employee && dateStringForCalc && typeof getExpectedHours === 'function') {
            try {
                expected = getExpectedHours(employee, dateStringForCalc);
            } catch (e) {
                console.error(`Fehler beim Holen der Soll-Stunden für CSV (MA: ${row.name}, Datum: ${dateStringForCalc}):`, e);
            }
        }

        const diff = istHours - expected;
        // Kommentare sicher für CSV formatieren (in Anführungszeichen, interne Anführungszeichen verdoppeln)
        const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;

        const values = [
            row.id,
            row.name || '',
            dateFormatted,
            startTimeFormatted,
            endTimeFormatted,
            istHours.toFixed(2), // Immer mit 2 Nachkommastellen
            expected.toFixed(2), // Immer mit 2 Nachkommastellen
            diff.toFixed(2),     // Immer mit 2 Nachkommastellen
            commentFormatted
        ];
        csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}
// --- ENDE HILFSFUNKTIONEN ---

// CORS-Konfiguration (Anpassen für Produktion!)
app.use(cors({
  origin: "*", // Erlaube Anfragen von jeder Herkunft (für Entwicklung)
  // origin: 'https://deine-frontend-domain.com', // Beispiel für Produktion
  credentials: true // Erlaube das Senden von Cookies (für Sessions)
}));

// Vertraue dem ersten Proxy (wichtig bei Einsatz hinter Reverse Proxy wie Nginx oder bei Cloud-Providern)
app.set('trust proxy', 1);
const port = process.env.PORT || 8080;

// Middleware
app.use(bodyParser.json()); // JSON-Bodyparser
app.use(express.static('public')); // Statische Dateien aus 'public' Ordner bereitstellen

// PostgreSQL-Datenbankverbindung Pool
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

db.on('error', (err, client) => {
  console.error('Unerwarteter Fehler im PostgreSQL Idle Client', err);
  process.exit(-1); // Bei DB-Fehlern ggf. neu starten
});

// Session Store Konfiguration
const sessionStore = new pgSession({
  pool: db,
  tableName: 'user_sessions', // Name der Session-Tabelle
  createTableIfMissing: true, // Tabelle automatisch erstellen, falls nicht vorhanden
});
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-geheimnis', // Starkes Geheimnis in .env speichern!
  resave: false, // Nicht speichern, wenn nichts geändert wurde
  saveUninitialized: false, // Keine leeren Sessions speichern
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Cookie nur über HTTPS senden in Produktion
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Wichtig für Cross-Site-Requests in Produktion bei separaten Domains
    httpOnly: true, // Verhindert Zugriff auf Cookie via JavaScript
    maxAge: 24 * 60 * 60 * 1000 // Gültigkeit: 1 Tag
  },
}));

// --- Datenbank-Tabellen Setup (Beim Start prüfen/erstellen) ---
const setupTables = async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      mo_hours DOUBLE PRECISION DEFAULT 0,
      di_hours DOUBLE PRECISION DEFAULT 0,
      mi_hours DOUBLE PRECISION DEFAULT 0,
      do_hours DOUBLE PRECISION DEFAULT 0,
      fr_hours DOUBLE PRECISION DEFAULT 0
    );`);
    console.log("Tabelle employees geprüft/erstellt.");

    await db.query(`CREATE TABLE IF NOT EXISTS work_hours (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, -- Referenz auf employees.name (optional als Foreign Key)
      date DATE NOT NULL,
      starttime TIME,
      endtime TIME,
      hours DOUBLE PRECISION, -- Berechnete Stunden (Ist-Zeit)
      comment TEXT
      -- Optional: Foreign Key Constraint für Mitarbeiter
      -- employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL -- oder CASCADE
    );`);
    console.log("Tabelle work_hours geprüft/erstellt.");

    await db.query(`CREATE TABLE IF NOT EXISTS monthly_balance (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- Bei Löschen des Mitarbeiters auch Saldo löschen
      year_month DATE NOT NULL, -- Erster Tag des Monats (z.B. 2025-03-01)
      difference DOUBLE PRECISION, -- Differenz (Ist - Soll) des Monats
      carry_over DOUBLE PRECISION, -- Kumulierter Übertrag am Ende des Monats
      UNIQUE (employee_id, year_month) -- Eindeutigkeit pro Mitarbeiter und Monat
    );`);
    console.log("Tabelle monthly_balance geprüft/erstellt.");

  } catch (err) {
    console.error("!!! Datenbank Setup Fehler:", err);
    process.exit(1); // Beenden, wenn Tabellen nicht erstellt werden können
  }
};

setupTables(); // Tabellen beim Serverstart initialisieren

// Middleware für Admin-Check (schützt Admin-Routen)
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next(); // Admin ist angemeldet, weiter zur nächsten Middleware/Route
  } else {
    console.warn(`Zugriffsversuch auf Admin-Route ohne Admin-Session: ${req.originalUrl} von IP ${req.ip}`);
    res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
  }
}

// ==========================================
// Öffentliche Endpunkte (Kein Login nötig)
// ==========================================

// Health Check Endpunkt
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Mitarbeiterliste für Dropdown im Frontend
app.get('/employees', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Details für nächsten Buchungsschritt ermitteln (Start oder Ende?)
app.get('/next-booking-details', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' });
  try {
    // Suche nach dem letzten Eintrag des Mitarbeiters, sortiert nach Datum und Startzeit
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
      FROM work_hours
      WHERE LOWER(name) = LOWER($1)
      ORDER BY date DESC, starttime DESC NULLS LAST
      LIMIT 1;`;
    const result = await db.query(query, [name]);

    let nextBooking = 'arbeitsbeginn';
    let entryId = null;
    let startDate = null;
    let startTime = null;

    if (result.rows.length > 0) {
      const last = result.rows[0];
      // Wenn der letzte Eintrag eine Startzeit, aber keine Endzeit hat -> Arbeitsende ist nächster Schritt
      if (last.starttime_formatted && !last.endtime) {
        nextBooking = 'arbeitsende';
        entryId = last.id;
        startDate = last.date instanceof Date ? last.date.toISOString().split('T')[0] : last.date; // YYYY-MM-DD Format
        startTime = last.starttime_formatted; // HH:MM Format
      }
    }
    res.json({ nextBooking, id: entryId, startDate, startTime });
  } catch (err) {
    console.error("Fehler /next-booking-details:", err);
    res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
  }
});

// Arbeitsbeginn loggen
app.post('/log-start', async (req, res) => {
    const { name, date, startTime } = req.body;
    if (!name || !date || !startTime) {
        return res.status(400).json({ message: 'Fehlende Daten (Name, Datum, Startzeit).' });
    }
    // Validierung des Datumsformats (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'Ungültiges Datumsformat. Benötigt: YYYY-MM-DD.' });
    }
    // Validierung des Zeitformats (HH:MM)
    if (!/^\d{2}:\d{2}$/.test(startTime)) {
        return res.status(400).json({ message: 'Ungültiges Zeitformat. Benötigt: HH:MM.' });
    }

    try {
        // Prüfen, ob Mitarbeiter existiert (optional, aber gut für Datenintegrität)
        const empCheck = await db.query('SELECT id FROM employees WHERE LOWER(name) = LOWER($1)', [name]);
        if (empCheck.rows.length === 0) {
             return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
        }

        // 1. Prüfen: Gibt es für DIESEN Tag bereits einen OFFENEN Eintrag (starttime gesetzt, endtime NULL)?
        const checkOpenQuery = `
            SELECT id FROM work_hours
            WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
        const checkOpenResult = await db.query(checkOpenQuery, [name, date]);
        if (checkOpenResult.rows.length > 0) {
            return res.status(409).json({ // 409 Conflict
                message: `Für diesen Tag (${new Date(date+'T00:00:00Z').toLocaleDateString('de-DE',{timeZone:'UTC'})}) existiert bereits ein nicht abgeschlossener Eintrag (ID: ${checkOpenResult.rows[0].id}). Bitte erst Arbeitsende buchen oder Admin kontaktieren.`
            });
        }

        // 2. Prüfen: Gibt es für DIESEN Tag bereits einen ABGESCHLOSSENEN Eintrag? (Erlaubt ggf. keine zweite Buchung am selben Tag)
        // Hängt von den Geschäftsregeln ab. Hier: Verhindern wir es.
        const checkCompleteQuery = `
            SELECT id FROM work_hours
            WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
        const checkCompleteResult = await db.query(checkCompleteQuery, [name, date]);
        if (checkCompleteResult.rows.length > 0) {
            console.warn(`Versuch, neuen Start für ${name} am ${date} zu buchen, obwohl bereits abgeschlossener Eintrag existiert (ID: ${checkCompleteResult.rows[0].id}).`);
             let displayDateError = date;
             try { displayDateError = new Date(date + 'T00:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC' }); } catch(e){}
             return res.status(409).json({ // 409 Conflict
               message: `An diesem Tag (${displayDateError}) wurde bereits eine vollständige Arbeitszeit erfasst. Eine erneute Buchung ist nicht vorgesehen.`
             });
        }

        // Wenn keine Konflikte -> Neuen Eintrag anlegen
        const insert = await db.query(
            `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`,
            [name, date, startTime]
        );
        console.log(`Start gebucht: ${name}, ${date}, ${startTime} (ID: ${insert.rows[0].id})`);
        res.status(201).json({ id: insert.rows[0].id }); // 201 Created

    } catch (err) {
        console.error("Fehler /log-start:", err);
        res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' });
    }
});

// Arbeitsende loggen und Stunden berechnen
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, comment } = req.body; // comment ist optional

  if (!endTime || !id || isNaN(parseInt(id))) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit).' });
  }
   // Validierung des Zeitformats (HH:MM)
   if (!/^\d{2}:\d{2}$/.test(endTime)) {
       return res.status(400).json({ message: 'Ungültiges Zeitformat für Endzeit. Benötigt: HH:MM.' });
   }

  const entryId = parseInt(id);

  try {
    // Hole den zugehörigen Eintrag, um Startzeit zu bekommen und Status zu prüfen
    const entryResult = await db.query(
      'SELECT starttime, endtime FROM work_hours WHERE id = $1',
      [entryId]
    );

    if (entryResult.rows.length === 0) {
      return res.status(404).json({ message: `Arbeitszeit-Eintrag mit ID ${entryId} nicht gefunden.` });
    }

    const entry = entryResult.rows[0];

    if (entry.endtime) {
        console.warn(`Versuch, Arbeitsende für bereits abgeschlossenen Eintrag ID ${entryId} zu buchen (vorhandenes Ende: ${entry.endtime}). Überschreiben wird NICHT durchgeführt.`);
        // Optional: Hier entscheiden, ob Überschreiben erlaubt ist oder nicht. Aktuell: Fehler.
        return res.status(409).json({ message: `Dieser Eintrag (ID: ${entryId}) wurde bereits mit einer Endzeit versehen. Eine erneute Buchung ist nicht möglich.` });
    }

    if (!entry.starttime) {
      // Dieser Fall sollte durch die Logik in /log-start eigentlich nicht eintreten
      return res.status(400).json({ message: `Fehler: Keine Startzeit für Eintrag ID ${entryId} gefunden. Berechnung nicht möglich.` });
    }

    // Berechne die Arbeitsstunden
    const netHours = calculateWorkHours(entry.starttime, endTime);

    // Update des Eintrags mit Endzeit, Kommentar und berechneten Stunden
    await db.query(
      `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`,
      [endTime, comment || '', netHours, entryId] // Kommentar ist optional, '' falls nicht übergeben
    );

    console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Berechnete Stunden: ${netHours.toFixed(2)})`);
    res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) }); // OK

  } catch (err) {
    console.error(`Fehler /log-end/${entryId}:`, err);
    res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' });
  }
});

// Zusammenfassung der Stunden für einen Tag und den aktuellen Monat
app.get('/summary-hours', async (req, res) => {
    const { name, date } = req.query;
    if (!name || !date) {
        return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
    }
     // Validierung des Datumsformats
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'Ungültiges Datumsformat. Benötigt: YYYY-MM-DD.' });
    }

    try {
        // Tagesstunden: Nimm den letzten abgeschlossenen Eintrag des Tages
        const dailyResult = await db.query(
            `SELECT hours FROM work_hours
             WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL AND endtime IS NOT NULL
             ORDER BY endtime DESC LIMIT 1`,
            [name, date]
        );
        const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].hours) || 0) : 0;

        // Monatsstunden: Summiere alle Stunden des Monats bis zum gegebenen Datum
        const yearMonthDay = date.split('-');
        const year = parseInt(yearMonthDay[0]);
        const month = parseInt(yearMonthDay[1]);
        const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
        // Enddatum für die Query ist das übergebene Datum
        const lastDayForQuery = date;

        const monthlyResult = await db.query(
            `SELECT SUM(hours) AS total_hours
             FROM work_hours
             WHERE LOWER(name) = LOWER($1)
               AND date >= $2
               AND date <= $3
               AND hours IS NOT NULL`,
            [name, firstDayOfMonth, lastDayForQuery]
        );

        const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_hours
            ? (parseFloat(monthlyResult.rows[0].total_hours) || 0)
            : 0;

        console.log(`Zusammenfassung ${name}: Tag ${date}=${dailyHours.toFixed(2)}h, Monat ${year}-${String(month).padStart(2,'0')}=${monthlyHours.toFixed(2)}h`);
        res.json({ dailyHours, monthlyHours });

    } catch (err) {
        console.error(`Fehler /summary-hours (${name}, ${date}):`, err);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' });
    }
});


// ==========================================
// Admin Endpunkte (Login erforderlich)
// ==========================================

// Admin-Login
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD; // Aus .env holen

  if (!adminPassword) {
      console.error("Admin-Passwort nicht in .env gesetzt!");
      return res.status(500).send("Serverkonfigurationsfehler.");
  }
  if (!password) {
      return res.status(400).send("Passwort fehlt.");
  }

  if (password === adminPassword) {
    // Passwort korrekt, Session regenerieren (verhindert Session Fixation)
    req.session.regenerate((err) => {
      if (err) {
        console.error("Session Regenerate Fehler:", err);
        return res.status(500).send("Session Fehler.");
      }
      // Admin-Status in der neuen Session setzen
      req.session.isAdmin = true;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("Session Save Fehler nach Login:", saveErr);
          return res.status(500).send("Session Speicherfehler.");
        }
        console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`);
        res.status(200).send("Admin erfolgreich angemeldet.");
      });
    });
  } else {
    // Falsches Passwort
    console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`);
    res.status(401).send("Ungültiges Passwort."); // 401 Unauthorized
  }
});

// Admin-Logout
app.post("/admin-logout", (req, res) => {
    if (req.session) {
        req.session.destroy(err => {
            if (err) {
                console.error("Fehler beim Zerstören der Session:", err);
                return res.status(500).send("Fehler beim Logout.");
            } else {
                // Wichtig: Cookie im Browser löschen
                res.clearCookie('connect.sid'); // Name des Session-Cookies (Standard bei express-session)
                console.log("Admin abgemeldet.");
                return res.status(200).send("Erfolgreich abgemeldet.");
            }
        });
    } else {
        return res.status(200).send("Keine aktive Session zum Abmelden.");
    }
});


// Admin-Ansicht aller Arbeitszeiten (geschützt durch isAdmin Middleware)
app.get('/admin-work-hours', isAdmin, async (req, res) => {
  try {
    const query = `
      SELECT id, name, date, hours, comment,
             TO_CHAR(starttime, 'HH24:MI') AS "startTime", -- Zeit als HH:MM formatieren
             TO_CHAR(endtime, 'HH24:MI') AS "endTime"   -- Zeit als HH:MM formatieren
      FROM work_hours
      ORDER BY date DESC, name ASC, starttime ASC;`; // Neueste zuerst, dann nach Name, dann Startzeit
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /admin-work-hours:", err);
    res.status(500).send('Serverfehler beim Laden der Arbeitszeiten.');
  }
});

// CSV-Download aller Arbeitszeiten (geschützt)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  try {
      // Hole alle Arbeitszeiten und join mit employee Daten für Soll-Stunden
      const query = `
        SELECT w.id, w.name, w.date, w.hours, w.comment,
               TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
               TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
               -- ,e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours -- Wird jetzt in convertToCSV geholt
        FROM work_hours w
        -- LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name) -- Join nicht mehr hier nötig
        ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`; // Sortiert nach Datum, Name, Startzeit
      const result = await db.query(query);

      // Konvertiere die Daten zu CSV (asynchron wegen DB-Abfrage in der Funktion)
      const csvData = await convertToCSV(db, result.rows);

      const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // Sende CSV mit UTF-8 BOM (Byte Order Mark) für bessere Excel-Kompatibilität
      res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));

  } catch (err) {
      console.error("DB Fehler GET /admin-download-csv:", err);
      res.status(500).send('Serverfehler beim Erstellen der CSV-Datei.');
  }
});


// Einzelnen Arbeitszeiteintrag updaten (geschützt)
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  const { id, name, date, startTime, endTime, comment } = req.body;

  // Validierung
  if (isNaN(parseInt(id)) || !name || !date || !startTime || !endTime) {
    return res.status(400).send('Ungültige oder fehlende Daten (ID, Name, Datum, Start, Ende erforderlich).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).send('Ungültiges Datumsformat (YYYY-MM-DD).');
  }
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
      return res.status(400).send('Ungültiges Zeitformat (HH:MM).');
  }

  // Berechne die Stunden neu basierend auf den geänderten Zeiten
  const netHours = calculateWorkHours(startTime, endTime);

  try {
    // Prüfen, ob Mitarbeiter existiert (optional)
     const empCheck = await db.query('SELECT id FROM employees WHERE LOWER(name) = LOWER($1)', [name]);
     if (empCheck.rows.length === 0) {
          return res.status(404).send(`Mitarbeiter '${name}' für Update nicht gefunden.`);
     }

    const query = `
      UPDATE work_hours
      SET name = $1, date = $2, starttime = $3, endtime = $4, hours = $5, comment = $6
      WHERE id = $7;
    `;
    const result = await db.query(query, [name, date, startTime, endTime, netHours, comment || '', parseInt(id)]);

    if (result.rowCount > 0) {
      console.log(`Admin Update für work_hours ID ${id} erfolgreich.`);
      res.status(200).send('Arbeitszeiteintrag erfolgreich aktualisiert.');
    } else {
      res.status(404).send(`Arbeitszeiteintrag mit ID ${id} nicht gefunden.`);
    }
  } catch (err) {
    console.error("DB Fehler PUT /api/admin/update-hours:", err);
    res.status(500).send('Serverfehler beim Aktualisieren des Eintrags.');
  }
});

// Einzelnen Arbeitszeiteintrag löschen (geschützt)
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(parseInt(id))) {
    return res.status(400).send('Ungültige ID übergeben.');
  }
  try {
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [parseInt(id)]);
    if (result.rowCount > 0) {
      console.log(`Admin Delete für work_hours ID ${id} erfolgreich.`);
      res.status(200).send('Eintrag erfolgreich gelöscht.'); // OK, kein Inhalt nötig
    } else {
      res.status(404).send(`Eintrag mit ID ${id} nicht gefunden.`);
    }
  } catch (err) {
    console.error("DB Fehler DELETE /api/admin/delete-hours:", err);
    res.status(500).send('Serverfehler beim Löschen des Eintrags.');
  }
});

// Alle Arbeitszeiten löschen (Sehr gefährlich! Geschützt)
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  console.warn("!!! Versuch zum Löschen ALLER Arbeitszeiten durch Admin !!!");
  try {
    // Hier könnte eine zusätzliche Bestätigung oder ein spezielles Passwort sinnvoll sein
    const result = await db.query('DELETE FROM work_hours');
    console.log(`!!! Admin hat ${result.rowCount} Arbeitszeiteinträge gelöscht !!!`);
    res.status(200).send(`Alle ${result.rowCount} Arbeitszeiteinträge wurden gelöscht.`);
  } catch (err) {
    console.error("DB Fehler /adminDeleteData (Löschen aller Arbeitszeiten):", err);
    res.status(500).send('Serverfehler beim Löschen aller Arbeitszeiten.');
  }
});

// --- Admin: Mitarbeiterverwaltung ---

// Alle Mitarbeiter auflisten (geschützt)
app.get('/admin/employees', isAdmin, async (req, res) => {
  try {
    // Wähle alle Spalten aus, sortiert nach Name
    const result = await db.query('SELECT * FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /admin/employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiter.');
  }
});

// Neuen Mitarbeiter hinzufügen (geschützt)
app.post('/admin/employees', isAdmin, async (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : ''; // Namen trimmen

  if (!trimmedName) {
      return res.status(400).send('Mitarbeitername darf nicht leer sein.');
  }

  // Konvertiere Stunden in Zahlen, setze auf 0 wenn ungültig/null
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);

  try {
    // Füge Mitarbeiter hinzu, gib Fehler bei Namenskonflikt (UNIQUE constraint)
    const query = `
      INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *; -- Gib den eingefügten Datensatz zurück
    `;
    const result = await db.query(query, [trimmedName, ...hours]);
    console.log(`Admin Add MA: ${trimmedName}`);
    res.status(201).json(result.rows[0]); // 201 Created
  } catch (err) {
    if (err.code === '23505') { // PostgreSQL Fehlercode für UNIQUE Verletzung
      console.warn(`Versuch, existierenden Mitarbeiter hinzuzufügen: ${trimmedName}`);
      res.status(409).send(`Ein Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`); // 409 Conflict
    } else {
      console.error("DB Fehler POST /admin/employees:", err);
      res.status(500).send('Serverfehler beim Hinzufügen des Mitarbeiters.');
    }
  }
});

// Mitarbeiterdaten aktualisieren (geschützt)
app.put('/admin/employees/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
    const trimmedName = name ? name.trim() : '';

    if (isNaN(parseInt(id))) {
        return res.status(400).send('Ungültige Mitarbeiter-ID.');
    }
    if (!trimmedName) {
        return res.status(400).send('Mitarbeitername darf nicht leer sein.');
    }

    // Konvertiere Stunden in Zahlen, setze auf 0 wenn ungültig/null
    const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);

    try {
        const query = `
            UPDATE employees
            SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6
            WHERE id = $7;
        `;
        const result = await db.query(query, [trimmedName, ...hours, parseInt(id)]);

        if (result.rowCount > 0) {
            console.log(`Admin Update MA ID ${id}.`);
            res.status(200).send('Mitarbeiterdaten erfolgreich aktualisiert.');
        } else {
            res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`);
        }
    } catch (err) {
        if (err.code === '23505') { // UNIQUE constraint Fehler
            console.warn(`Versuch, Mitarbeiter ID ${id} auf existierenden Namen umzubenennen: ${trimmedName}`);
            res.status(409).send(`Ein anderer Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`);
        } else {
            console.error(`DB Fehler PUT /admin/employees/${id}:`, err);
            res.status(500).send('Serverfehler beim Aktualisieren der Mitarbeiterdaten.');
        }
    }
});


// Mitarbeiter löschen (geschützt)
app.delete('/admin/employees/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    if (isNaN(parseInt(id))) {
        return res.status(400).send('Ungültige Mitarbeiter-ID.');
    }

    // Transaktion starten, um sicherzustellen, dass alles oder nichts gelöscht wird
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        // 1. Optional: Zugehörige Arbeitszeiten löschen oder Mitarbeiter-Referenz auf NULL setzen?
        // Aktuell nicht implementiert, da work_hours keinen direkten Foreign Key hat.
        // Wenn ein FK existiert mit ON DELETE CASCADE, ist dieser Schritt nicht nötig.
        // Beispiel: await client.query('DELETE FROM work_hours WHERE employee_id = $1', [parseInt(id)]);

        // 2. Monatsbilanzen löschen (hat ON DELETE CASCADE, wird also automatisch durch Löschen des Mitarbeiters erledigt)
        // Beispiel: await client.query('DELETE FROM monthly_balance WHERE employee_id = $1', [parseInt(id)]);

        // 3. Mitarbeiter selbst löschen
        const result = await client.query('DELETE FROM employees WHERE id = $1', [parseInt(id)]);

        await client.query('COMMIT'); // Transaktion abschließen

        if (result.rowCount > 0) {
            console.log(`Admin Delete MA ID ${id}.`);
            res.status(200).send('Mitarbeiter und zugehörige Daten erfolgreich gelöscht.');
        } else {
            res.status(404).send(`Mitarbeiter mit ID ${id} nicht gefunden.`);
        }
    } catch (err) {
        await client.query('ROLLBACK'); // Bei Fehler alles zurückrollen
        console.error(`DB Fehler DELETE /admin/employees/${id}:`, err);
        // Prüfen, ob es ein Foreign Key Constraint Fehler war (z.B. wenn Arbeitszeiten noch verknüpft sind)
        if (err.code === '23503') { // Foreign key violation
             res.status(409).send('Fehler: Mitarbeiter konnte nicht gelöscht werden, da noch abhängige Daten (z.B. Arbeitszeiten) existieren. Bitte diese zuerst löschen oder zuordnen.');
        } else {
            res.status(500).send('Serverfehler beim Löschen des Mitarbeiters.');
        }
    } finally {
        client.release(); // Verbindung zum Pool zurückgeben
    }
});

// === Endpunkt für Monatsauswertung ===
// Berechnet die Monatsbilanz und gibt sie zurück (speichert sie auch in DB via calculateMonthlyData)
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;

  // Validierung der Eingaben
  if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
      return res.status(400).json({ message: "Ungültige Eingabe. Benötigt: name, year, month (1-12)." });
  }

  try {
    // Rufe die zentrale Berechnungsfunktion auf
    const result = await calculateMonthlyData(db, name, year, month);
    console.log(`Admin Monatsauswertung berechnet für: ${result.employeeName || name} (${month}/${year})`);
    res.json(result); // Sende das Ergebnis als JSON zurück
  } catch (err) {
    console.error(`Fehler /calculate-monthly-balance (Name: ${name}, ${month}/${year}):`, err);
    // Gib eine spezifischere Fehlermeldung zurück, falls möglich
    if (err.message.includes("Mitarbeiter nicht gefunden")) {
        res.status(404).json({ message: err.message });
    } else {
        res.status(500).json({ message: `Serverfehler bei der Berechnung der Monatsbilanz: ${err.message}` });
    }
  }
});


// === NEU: PDF Router einbinden ===
// Alle Routen, die in monthlyPdfEndpoint.js definiert sind,
// werden unter dem Pfad /api/pdf verfügbar gemacht.
// Wir übergeben die Datenbankverbindung `db` an den Router.
app.use('/api/pdf', monthlyPdfRouter(db));


// === ALT: PDF-Download Endpunkt (ENTFERNT) ===
// Der Codeblock app.get('/admin/download-pdf', ...) wurde entfernt.


// ==========================================
// Server Start
// ==========================================
app.listen(port, () => {
  console.log(`Server läuft auf Port ${port}`);
  console.log(`Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Admin-Routen sind ${process.env.ADMIN_PASSWORD ? 'aktiviert' : 'DEAKTIVIERT (ADMIN_PASSWORD fehlt)'}`);
});
