// server.js

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cors = require("cors");
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
const app = express();
// Stelle sicher, dass die *korrigierte* calculationUtils geladen wird
const { calculateMonthlyData, getExpectedHours, calculatePeriodData } = require('./utils/calculationUtils');

// --- HILFSFUNKTIONEN ---
// parseTime, calculateWorkHours, convertToCSV... (unverändert, außer ggf. Anpassungen in convertToCSV für Soll-Stunden)
function parseTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return 0;
    const [hh, mm] = timeStr.split(':');
    return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const startMinutes = parseTime(startTime);
    const endMinutes = parseTime(endTime);
    let diffInMin = endMinutes - startMinutes;
    // Einfache Behandlung von Arbeit über Mitternacht (innerhalb von 24h)
    if (diffInMin < 0) {
        diffInMin += 24 * 60;
    }
    // Plausibilitätscheck: Mehr als 24h unrealistisch für einen einzelnen Eintrag
    if (diffInMin > 24 * 60) {
        console.warn(`Arbeitszeit > 24h (${(diffInMin/60).toFixed(2)}h) für ${startTime}-${endTime}. Wird auf 0 gesetzt.`);
        return 0;
    }
    return diffInMin / 60;
}

// convertToCSV bleibt funktional, aber die Soll-Stunden-Logik darin müsste
// ggf. angepasst werden, falls eine tagesgenaue Soll-Stunde im CSV gewünscht ist.
// Aktuell holt sie die Soll-Stunden basierend auf dem Standard-Wochentag.
// Für einen einfachen Export der Rohdaten ist es aber ausreichend.
async function convertToCSV(db, data) {
    if (!data || data.length === 0) return '';
    const csvRows = [];
    // Header anpassen, falls nötig
    const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std (Standard)", "Differenz (vs. Standard)", "Bemerkung"];
    csvRows.push(headers.join(','));

    // Hole alle relevanten Mitarbeiterdaten auf einmal für Effizienz
    const employeeNames = [...new Set(data.map(row => row.name))].filter(Boolean);
    let employeesData = {};
    if (employeeNames.length > 0) {
      try {
          // Hole ID und alle Stunden, um getExpectedHours nutzen zu können
          const empQuery = `SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees WHERE name = ANY($1::text[])`;
          const empResult = await db.query(empQuery, [employeeNames]);
          empResult.rows.forEach(emp => {
              // Speichere unter kleingeschriebenem Namen für einfachen Zugriff
              employeesData[emp.name.toLowerCase()] = emp;
          });
      } catch(dbError) {
          console.error("Fehler beim Abrufen der Mitarbeiterdaten für CSV:", dbError);
          // Fahre fort, aber Soll-Stunden werden 0 sein
      }
    }

    for (const row of data) {
      let dateFormatted = "", dateStringForCalc = null;
      if (row.date) {
        try {
            // Stelle sicher, dass das Datum als UTC behandelt wird
            const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date.split('T')[0] + 'T00:00:00Z');
            dateFormatted = dateObj.toLocaleDateString('de-DE', { timeZone: 'UTC' });
            dateStringForCalc = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD für getExpectedHours
        } catch (e) {
            dateFormatted = String(row.date); // Fallback
            console.warn("CSV Datumsformat Fehler:", row.date, e);
        }
      }
      const startTimeFormatted = row.startTime || ""; // Kommt als HH:MI
      const endTimeFormatted = row.endTime || "";     // Kommt als HH:MI
      const istHours = parseFloat(row.hours) || 0;

      // Standard-Soll-Stunde für diesen Wochentag berechnen
      let expected = 0;
      const employee = row.name ? employeesData[row.name.toLowerCase()] : null;
      if (employee && dateStringForCalc && typeof getExpectedHours === 'function') {
          try {
              expected = getExpectedHours(employee, dateStringForCalc);
          } catch (e) {
              console.error(`Fehler beim Berechnen der Standard-Soll-Stunden für CSV (MA: ${row.name}, Datum: ${dateStringForCalc}):`, e);
          }
      }

      const diff = istHours - expected;
      const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`; // Escape quotes

      const values = [
        row.id,
        row.name || '',
        dateFormatted,
        startTimeFormatted,
        endTimeFormatted,
        istHours.toFixed(2),
        expected.toFixed(2), // Standard-Soll für den Tag
        diff.toFixed(2),     // Differenz zum Standard-Soll
        commentFormatted
      ];
      csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}


// Middleware, DB Pool, Session Setup
app.use(cors({
    // Erlaube Anfragen von überall für Entwicklung, oder spezifiziere deine Frontend-URL
    origin: "*", // oder z.B. 'http://localhost:3000' für React Dev Server
    credentials: true // Erlaubt das Senden von Cookies (für Sessions)
}));
app.set('trust proxy', 1); // Nötig, wenn hinter einem Reverse Proxy (z.B. Heroku, Render)

const port = process.env.PORT || 8080;

app.use(bodyParser.json());
app.use(express.static('public')); // Serve static files like index.html

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

db.on('error', (err, client) => {
  console.error('Unerwarteter Fehler im PostgreSQL Idle Client', err);
  process.exit(-1); // Beende den Prozess bei Pool-Fehlern
});

const sessionStore = new pgSession({
  pool : db,                // Connection pool
  tableName : 'user_sessions', // Use another table-name than the default "session" one
  createTableIfMissing: true // Automatically creates the table
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'ein-sehr-geheimes-geheimnis-das-man-aendern-sollte', // ÄNDERN!
  resave: false, // Don't save session if unmodified
  saveUninitialized: false, // Don't create session until something stored
  cookie: {
      secure: process.env.NODE_ENV === 'production', // Secure nur in Production (HTTPS)
      httpOnly: true, // Verhindert Zugriff über clientseitiges JS
      maxAge: 24 * 60 * 60 * 1000, // 24 Stunden Gültigkeit
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax' // Wichtig für Cross-Site Requests in Prod
    }
}));
// Datenbank-Setup Funktion
const setupTables = async () => {
  try {
    // Tabelle für Mitarbeiter mit Standard-Wochenstunden
    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mo_hours DOUBLE PRECISION DEFAULT 0,
        di_hours DOUBLE PRECISION DEFAULT 0,
        mi_hours DOUBLE PRECISION DEFAULT 0,
        do_hours DOUBLE PRECISION DEFAULT 0,
        fr_hours DOUBLE PRECISION DEFAULT 0
        -- Weitere Felder wie Vertragsstunden/Woche könnten hier sinnvoll sein
      );
    `);
    console.log("Tabelle 'employees' geprüft/erstellt.");

    // Tabelle für erfasste Arbeitszeiten
    // Name wird hier gespeichert, obwohl ID besser wäre (historisch gewachsen?)
    // Ein JOIN auf employees ist nötig, um nach ID zu filtern
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL, -- Referenziert (logisch) employees.name
        date DATE NOT NULL,
        starttime TIME,
        endtime TIME,
        hours DOUBLE PRECISION, -- Berechnete Netto-Stunden
        comment TEXT
        -- CONSTRAINT fk_employee_name FOREIGN KEY (name) REFERENCES employees(name) ON UPDATE CASCADE ON DELETE CASCADE -- FK wäre gut, aber braucht saubere Namensänderungslogik
      );
    `);
     // Index für schnellere Abfragen nach Name und Datum
    await db.query(`CREATE INDEX IF NOT EXISTS idx_work_hours_name_date ON work_hours (LOWER(name), date);`);
    console.log("Tabelle 'work_hours' und Index geprüft/erstellt.");


    // Tabelle für Monatsbilanzen
    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        year_month DATE NOT NULL, -- Immer der 1. des Monats
        difference DOUBLE PRECISION, -- Differenz Ist-Soll für den Monat
        carry_over DOUBLE PRECISION, -- Saldo am Ende des Monats
        UNIQUE (employee_id, year_month)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    console.log("Tabelle 'monthly_balance' und Index geprüft/erstellt.");

    // Tabelle für Abwesenheiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS absences (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')), -- Typ der Abwesenheit
        credited_hours DOUBLE PRECISION NOT NULL, -- Wieviele Soll-Stunden werden dadurch gedeckt?
        comment TEXT,
        UNIQUE (employee_id, date) -- Nur ein Eintrag pro Mitarbeiter pro Tag
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);`);
    console.log("Tabelle 'absences' und Index geprüft/erstellt.");

  } catch (err) {
    console.error("!!! Kritischer Datenbank Setup Fehler:", err);
    process.exit(1); // Beende den Prozess bei Setup-Fehlern
  }
};

setupTables(); // Führe das Setup beim Start aus

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
  // Prüfe, ob die Session existiert und der isAdmin Marker gesetzt ist
  if (req.session && req.session.isAdmin === true) {
    next(); // Zugriff erlaubt, fahre mit nächster Middleware/Route fort
  } else {
    console.warn(`Zugriffsversuch auf Admin-Route ohne Admin-Session: ${req.originalUrl} von IP ${req.ip}`);
    // Session fehlt oder isAdmin ist nicht true
    res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.'); // 403 Forbidden
  }
}


// ==========================================
// Öffentliche Endpunkte (kein Login nötig)
// ==========================================
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Liefert Liste aller Mitarbeiter (ID und Name) für Dropdowns
app.get('/employees', async (req, res) => {
  try {
    // Hole ID und Name, sortiert nach Name
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows); // Sende Array von {id: ..., name: ...}
  } catch (err) {
    console.error("DB Fehler GET /employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Prüft den letzten Eintrag eines Mitarbeiters, um zu entscheiden, ob Start oder Ende gebucht werden muss
app.get('/next-booking-details', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' });

  try {
    // Finde den letzten Eintrag (aktuellster Tag, späteste Startzeit)
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
      FROM work_hours
      WHERE LOWER(name) = LOWER($1)
      ORDER BY date DESC, starttime DESC NULLS LAST
      LIMIT 1;`;
    const result = await db.query(query, [name.toLowerCase()]);

    let nextBooking = 'arbeitsbeginn'; // Standard: Nächste Aktion ist Arbeitsbeginn
    let entryId = null;
    let startDate = null;
    let startTime = null;

    if (result.rows.length > 0) {
      const last = result.rows[0];
      // Wenn der letzte Eintrag eine Startzeit hat, aber keine Endzeit, dann ist die nächste Aktion "Arbeitsende"
      if (last.starttime_formatted && !last.endtime) {
        nextBooking = 'arbeitsende';
        entryId = last.id;
        // Datum für die Anzeige korrekt formatieren
        startDate = last.date instanceof Date ? last.date.toISOString().split('T')[0] : last.date;
        startTime = last.starttime_formatted;
      }
    }
    // Sende den Status zurück ans Frontend
    res.json({ nextBooking, id: entryId, startDate, startTime });

  } catch (err) {
    console.error("Fehler /next-booking-details:", err);
    res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
  }
});
// Bucht den Arbeitsbeginn für einen Mitarbeiter
app.post('/log-start', async (req, res) => {
  const { name, date, startTime } = req.body;

  // Validierung der Eingabe
  if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten (Name, Datum YYYY-MM-DD, Startzeit HH:MM erforderlich).' });
  }

  try {
      // Prüfen ob Mitarbeiter existiert (Groß/Kleinschreibung ignorieren)
      const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
      if (empCheck.rows.length === 0) {
          return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
      }
      const dbEmployeeName = empCheck.rows[0].name; // Korrekten Namen aus DB verwenden

      // Prüfen, ob bereits ein offener Eintrag für diesen Tag existiert
      const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
      const checkOpenResult = await db.query(checkOpenQuery, [dbEmployeeName.toLowerCase(), date]);
      if (checkOpenResult.rows.length > 0) {
          return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Eintrag.` }); // 409 Conflict
      }

      // Optional: Prüfen, ob an diesem Tag bereits ein *abgeschlossener* Eintrag existiert
      // (Erlaubt aktuell keine Mehrfachbuchungen pro Tag)
      const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
      const checkCompleteResult = await db.query(checkCompleteQuery, [dbEmployeeName.toLowerCase(), date]);
      if (checkCompleteResult.rows.length > 0) {
          // Hier könnte man überlegen, ob stattdessen ein neuer Eintrag hinzugefügt wird
          return res.status(409).json({ message: `An diesem Tag wurde bereits eine vollständige Arbeitszeit erfasst.` });
      }

      // Neuen Eintrag erstellen
      const insert = await db.query(
          `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`,
          [dbEmployeeName, date, startTime] // Korrekten Namen verwenden
      );

      console.log(`Start gebucht: ${dbEmployeeName}, ${date}, ${startTime} (ID: ${insert.rows[0].id})`);
      res.status(201).json({ id: insert.rows[0].id }); // 201 Created

  } catch (err) {
      console.error("Fehler /log-start:", err);
      res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' });
  }
});

// Bucht das Arbeitsende für einen bestehenden Eintrag
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, comment } = req.body;

  // Validierung
  if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit HH:MM erforderlich).' });
  }
  const entryId = parseInt(id);

  try {
      // Eintrag holen, um Startzeit zu bekommen und zu prüfen ob er existiert/offen ist
      const entryResult = await db.query(
          `SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE id = $1`,
          [entryId]
      );

      if (entryResult.rows.length === 0) {
          return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` }); // 404 Not Found
      }
      const entry = entryResult.rows[0];

      if (entry.endtime) {
          return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` }); // 409 Conflict
      }
      if (!entry.starttime_formatted) {
          // Sollte nicht passieren, wenn Logik korrekt ist
          return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden. Buchung nicht möglich.` });
      }

      // Arbeitsstunden berechnen
      const netHours = calculateWorkHours(entry.starttime_formatted, endTime);

      // Eintrag aktualisieren
      await db.query(
          `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`,
          [endTime, comment || '', netHours, entryId]
      );

      console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Berechnete Stunden: ${netHours.toFixed(2)})`);
      res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) }); // 200 OK

  } catch (err) {
      console.error(`Fehler /log-end/${entryId}:`, err);
      res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' });
  }
});

// Liefert Zusammenfassung der Stunden (Tag & Monat bis heute) für einen Mitarbeiter
app.get('/summary-hours', async (req, res) => {
  const { name, date } = req.query; // date im Format YYYY-MM-DD

  if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
  }

  try {
      // 1. Stunden für den spezifischen Tag holen (nur abgeschlossene Einträge)
      const dailyResult = await db.query(
          `SELECT SUM(hours) AS total_daily_hours FROM work_hours
           WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL AND endtime IS NOT NULL`,
          [name.toLowerCase(), date]
      );
      const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0;

      // 2. Stunden für den gesamten Monat bis einschließlich des gegebenen Datums holen
      const yearMonthDay = date.split('-');
      const year = parseInt(yearMonthDay[0]);
      const month = parseInt(yearMonthDay[1]);
      // Erster Tag des Monats
      const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
      // Enddatum für die Query ist das übergebene Datum
      const lastDayForQuery = date;

      const monthlyResult = await db.query(
          `SELECT SUM(hours) AS total_monthly_hours FROM work_hours
           WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`,
          [name.toLowerCase(), firstDayOfMonth, lastDayForQuery]
      );
      const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0;

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
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
      console.error("Admin-Passwort (ADMIN_PASSWORD) ist nicht in der .env Datei gesetzt!");
      return res.status(500).send("Serverkonfigurationsfehler.");
  }
  if (!password) { return res.status(400).send("Passwort fehlt."); }

  if (password === adminPassword) {
      // Passwort korrekt, erstelle Admin-Session
      req.session.regenerate((err) => { // Neue Session ID generieren zur Sicherheit
          if (err) {
              console.error("Session Regenerate Fehler:", err);
              return res.status(500).send("Session Fehler.");
          }
          // Setze Admin-Marker in der Session
          req.session.isAdmin = true;
          // Speichere die Session explizit
          req.session.save((saveErr) => {
              if (saveErr) {
                  console.error("Session Save Fehler nach Login:", saveErr);
                  return res.status(500).send("Session Speicherfehler.");
              }
              console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`);
              res.status(200).send("Admin erfolgreich angemeldet."); // OK
          });
      });
  } else {
      console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`);
      res.status(401).send("Ungültiges Passwort."); // 401 Unauthorized
  }
});

// Admin-Logout
app.post("/admin-logout", isAdmin, (req, res) => { // isAdmin Middleware prüft zuerst
  if (req.session) {
    const sessionId = req.sessionID;
    req.session.destroy(err => { // Session zerstören
      if (err) {
        console.error("Fehler beim Zerstören der Session:", err);
        return res.status(500).send("Fehler beim Logout.");
      }
      // Cookie im Browser löschen
      res.clearCookie('connect.sid'); // Name des Session-Cookies (Standard für express-session)
      console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else {
    // Sollte nicht vorkommen, wenn isAdmin erfolgreich war
    return res.status(200).send("Keine aktive Session zum Abmelden.");
  }
});


// *** ANGEPASSTE ROUTE: Arbeitszeiten für Admin anzeigen (mit Filterung) ***
app.get('/admin-work-hours', isAdmin, async (req, res) => {
    const { employeeId, year, month } = req.query; // Filterparameter auslesen

    // Basis-SQL-Query mit JOIN, um nach employee.id filtern zu können
    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment,
                       TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
                       TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
                     FROM work_hours w
                     JOIN employees e ON LOWER(w.name) = LOWER(e.name)`; // Join über Namen (Groß/Klein ignorieren)

    const whereClauses = []; // Array für WHERE-Bedingungen
    const queryParams = [];  // Array für Parameter ($1, $2, ...)
    let paramIndex = 1;      // Zähler für Parameter-Platzhalter

    // --- Filter nach Mitarbeiter-ID ---
    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId);
        if (isNaN(empIdInt)) {
             // Ungültige ID
             return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID angegeben.'});
        }
        whereClauses.push(`e.id = $${paramIndex++}`); // Füge Bedingung hinzu
        queryParams.push(empIdInt);                  // Füge Parameterwert hinzu
    }

    // --- Filter nach Monat/Jahr ---
    if (year && month) {
        const parsedYear = parseInt(year);
        const parsedMonth = parseInt(month);

        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) {
             // Ungültiges Jahr oder Monat
             return res.status(400).json({ message: 'Ungültiges Jahr (4-stellig) oder Monat (1-12) angegeben.' });
        }

        // Erzeuge Start- und Enddatum für den Monat (UTC)
        try {
            const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); // 1. des Monats
            const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));     // 1. des Folgemonats

             // Sicherheitscheck, ob Daten gültig sind
             if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                throw new Error('Konnte gültige Datumsobjekte nicht erstellen');
            }

            // Format für DB-Query (YYYY-MM-DD)
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];

            // Füge Datumsbedingungen hinzu (>= startDate UND < endDate)
            whereClauses.push(`w.date >= $${paramIndex++}`);
            queryParams.push(startDateStr);
            whereClauses.push(`w.date < $${paramIndex++}`);
            queryParams.push(endDateStr);

        } catch(dateError) {
             console.error("Fehler bei der Datumserstellung für Filter:", dateError);
             // Sende spezifische Fehlermeldung zurück
             return res.status(400).json({ message: `Fehler bei der Datumsverarbeitung für ${year}-${month}. Format YYYY-MM erwartet.` });
        }
    }

    // --- Query zusammensetzen ---
    let finalQuery = baseQuery;
    if (whereClauses.length > 0) {
        finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; // Füge WHERE-Klausel hinzu, wenn Filter existieren
    }

    // Sortierung hinzufügen
    finalQuery += ` ORDER BY w.date DESC, e.name ASC, w.starttime ASC;`; // Neueste zuerst

    // --- Query ausführen ---
    try {
        // console.log("Executing Query:", finalQuery, queryParams); // Zum Debuggen der Abfrage
        const result = await db.query(finalQuery, queryParams); // Query mit Parametern ausführen
        res.json(result.rows); // Ergebnis senden
    } catch (err) {
        console.error("DB Fehler GET /admin-work-hours (gefiltert):", err);
        // Gib allgemeinen Serverfehler zurück, spezifische Fehler wurden oben behandelt
        res.status(500).send('Serverfehler beim Laden der gefilterten Arbeitszeiten.');
    }
});
// CSV-Download für Admin (aktuell ohne Filter)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  // TODO: Filterung für CSV optional hinzufügen
  // Man könnte die Filterparameter (employeeId, year, month) auch hier entgegennehmen
  // und die `convertToCSV` Funktion entsprechend anpassen oder die Daten vorfiltern.
  try {
    // Aktuell werden ALLE Daten geholt
    const query = `
        SELECT w.id, w.name, w.date, w.hours, w.comment,
               TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
               TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
        FROM work_hours w
        ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`; // Für CSV chronologisch sortieren
    const result = await db.query(query);

    // Daten in CSV konvertieren (nutzt die Hilfsfunktion)
    const csvData = await convertToCSV(db, result.rows);

    // Dateinamen generieren
    const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;

    // Header für CSV-Download setzen
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // BOM für UTF-8 hinzufügen (Excel-Kompatibilität) und Daten senden
    res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));

  } catch (err) {
    console.error("DB Fehler GET /admin-download-csv:", err);
    res.status(500).send('Serverfehler beim Erstellen der CSV-Datei.');
  }
});

// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  // ID kommt jetzt aus dem Body, Name wird nicht mehr direkt geändert
  const { id, date, startTime, endTime, comment } = req.body;

  // Validierung der Eingabedaten
  if (isNaN(parseInt(id)) || !date || !startTime || !endTime ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^\d{2}:\d{2}$/.test(startTime) ||
      !/^\d{2}:\d{2}$/.test(endTime))
  {
    return res.status(400).json({ message: 'Ungültige oder fehlende Daten (ID, Datum, Startzeit, Endzeit erforderlich).' });
  }

  // Stunden neu berechnen basierend auf den geänderten Zeiten
  const netHours = calculateWorkHours(startTime, endTime);
  const entryId = parseInt(id);

  try {
      // Hole den ursprünglichen Namen, um sicherzustellen, dass der Eintrag existiert
      const checkResult = await db.query('SELECT name FROM work_hours WHERE id = $1', [entryId]);
       if (checkResult.rows.length === 0) {
             return res.status(404).json({ message: `Arbeitszeiteintrag mit ID ${entryId} nicht gefunden.` });
       }
       // Der Name wird nicht geändert, nur die Zeitdaten und der Kommentar

      // Update-Query
      const query = `UPDATE work_hours
                     SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5
                     WHERE id = $6;`;
      const result = await db.query(query, [date, startTime, endTime, netHours, comment || '', entryId]);

      if (result.rowCount > 0) {
        console.log(`Admin Update für work_hours ID ${entryId} erfolgreich.`);
        res.status(200).send('Arbeitszeiteintrag erfolgreich aktualisiert.'); // OK
      } else {
         // Sollte nicht passieren nach dem Check oben, aber sicher ist sicher
        res.status(404).send(`Arbeitszeiteintrag mit ID ${entryId} nicht gefunden (während Update).`);
      }
  } catch (err) {
    console.error(`DB Fehler PUT /api/admin/update-hours (ID: ${entryId}):`, err);
    res.status(500).send('Serverfehler beim Aktualisieren des Eintrags.');
  }
});


// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(parseInt(id))) {
      return res.status(400).send('Ungültige ID übergeben.');
  }
  const entryId = parseInt(id);

  try {
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]);
    if (result.rowCount > 0) {
      console.log(`Admin Delete für work_hours ID ${entryId} erfolgreich.`);
      res.status(200).send('Eintrag erfolgreich gelöscht.'); // OK
    } else {
      res.status(404).send(`Eintrag mit ID ${entryId} nicht gefunden.`); // Not Found
    }
  } catch (err) {
    console.error(`DB Fehler DELETE /api/admin/delete-hours (ID: ${entryId}):`, err);
    // Prüfen auf spezifische DB-Fehler (z.B. Foreign Key, falls relevant)
    res.status(500).send('Serverfehler beim Löschen des Eintrags.');
  }
});

// Admin: Alle Arbeitszeiten, Bilanzen und Abwesenheiten löschen (GEFÄHRLICH!)
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  console.warn("!!! ACHTUNG: Admin versucht, ALLE Arbeits-, Bilanz- und Abwesenheitsdaten zu löschen !!!");
  try {
      // Reihenfolge beachten wegen möglicher Foreign Keys (obwohl CASCADE helfen sollte)
      // 1. Monatsbilanzen löschen
      const resultMB = await db.query('DELETE FROM monthly_balance');
      console.log(`!!! Admin hat ${resultMB.rowCount} Monatsbilanz-Einträge gelöscht !!!`);

       // 2. Abwesenheiten löschen
      const resultAbs = await db.query('DELETE FROM absences');
      console.log(`!!! Admin hat ${resultAbs.rowCount} Abwesenheits-Einträge gelöscht !!!`);

      // 3. Arbeitszeiten löschen
      const resultWH = await db.query('DELETE FROM work_hours');
      console.log(`!!! Admin hat ${resultWH.rowCount} Arbeitszeiteinträge gelöscht !!!`);


      res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiteinträge, ${resultMB.rowCount} Monatsbilanzen und ${resultAbs.rowCount} Abwesenheiten wurden gelöscht.`);
  } catch (err) {
      console.error("DB Fehler bei /adminDeleteData:", err);
      res.status(500).send('Serverfehler beim Löschen aller Daten.');
  }
});
// === Mitarbeiterverwaltung ===

// Admin: Liste aller Mitarbeiter holen (ID, Name, Soll-Stunden)
app.get('/admin/employees', isAdmin, async (req, res) => {
  try {
      // Hole alle relevanten Daten für die Admin-Übersicht
    const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /admin/employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiter.');
  }
});

// Admin: Neuen Mitarbeiter hinzufügen
app.post('/admin/employees', isAdmin, async (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : '';

  if (!trimmedName) {
      return res.status(400).send('Mitarbeitername darf nicht leer sein.');
  }
  // Konvertiere Stunden in Zahlen, Standardwert 0
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);

  try {
    const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   RETURNING *;`; // Gibt den neu erstellten Mitarbeiter zurück
    const result = await db.query(query, [trimmedName, ...hours]);
    console.log(`Admin Add MA: ${trimmedName}`);
    res.status(201).json(result.rows[0]); // 201 Created
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'employees_name_key') {
        // Eindeutigkeitsverletzung für den Namen
        console.warn(`Versuch, existierenden Mitarbeiter hinzuzufügen: ${trimmedName}`);
        res.status(409).send(`Ein Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`); // 409 Conflict
    } else {
        // Anderer Datenbankfehler
        console.error("DB Fehler POST /admin/employees:", err);
        res.status(500).send('Serverfehler beim Hinzufügen des Mitarbeiters.');
    }
  }
});
// Admin: Mitarbeiterdaten aktualisieren
app.put('/admin/employees/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : '';
  const employeeId = parseInt(id);

  if (isNaN(employeeId)) {
      return res.status(400).send('Ungültige Mitarbeiter-ID.');
  }
  if (!trimmedName) {
      return res.status(400).send('Mitarbeitername darf nicht leer sein.');
  }
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);

  let client; // Definiere client außerhalb des try-Blocks für finally
  try {
      client = await db.connect(); // Verbindung für Transaktion holen
      await client.query('BEGIN'); // Transaktion starten

      // 1. Alten Namen holen (für den Fall einer Namensänderung)
      const oldNameResult = await client.query('SELECT name FROM employees WHERE id = $1', [employeeId]);
      if (oldNameResult.rows.length === 0) {
           await client.query('ROLLBACK'); // Transaktion abbrechen
           return res.status(404).send(`Mitarbeiter mit ID ${employeeId} nicht gefunden.`);
      }
      const oldName = oldNameResult.rows[0].name;
      const newName = trimmedName;

      // 2. Mitarbeiterdaten aktualisieren
      const updateQuery = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6
                           WHERE id = $7;`;
      const updateResult = await client.query(updateQuery, [newName, ...hours, employeeId]);

      // 3. Wenn der Name geändert wurde, aktualisiere auch die work_hours Tabelle
      if (oldName && oldName !== newName) {
          console.log(`Aktualisiere Namen in work_hours von '${oldName}' zu '${newName}' für MA ID ${employeeId}...`);
          // Wichtig: Filtere auch hier nach dem alten Namen (case-insensitive)
          const workHoursUpdateResult = await client.query(
              `UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`,
              [newName, oldName.toLowerCase()]
          );
          console.log(`${workHoursUpdateResult.rowCount} Einträge in work_hours für MA ID ${employeeId} auf neuen Namen aktualisiert.`);
           // Hinweis: Dies aktualisiert ALLE Einträge mit dem alten Namen, nicht nur die des spezifischen Mitarbeiters, falls Namen nicht unique waren!
           // Eine bessere Lösung wäre, work_hours direkt mit employee_id zu verknüpfen.
      }

      await client.query('COMMIT'); // Transaktion erfolgreich abschließen
      console.log(`Admin Update MA ID ${employeeId}. Alter Name: ${oldName}, Neuer Name: ${newName}`);
      res.status(200).send('Mitarbeiterdaten erfolgreich aktualisiert.');

  } catch (err) {
      if (client) await client.query('ROLLBACK'); // Transaktion bei Fehler abbrechen

      if (err.code === '23505' && err.constraint === 'employees_name_key') {
          // Namenskonflikt beim Umbenennen
          console.warn(`Versuch, Mitarbeiter ID ${employeeId} auf existierenden Namen umzubenennen: ${trimmedName}`);
          res.status(409).send(`Ein anderer Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`);
      } else {
          console.error(`DB Fehler PUT /admin/employees/${employeeId}:`, err);
          res.status(500).send('Serverfehler beim Aktualisieren der Mitarbeiterdaten.');
      }
  } finally {
      if (client) client.release(); // Verbindung wieder freigeben
  }
});


// Admin: Mitarbeiter löschen (und alle zugehörigen Daten via CASCADE)
app.delete('/admin/employees/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(parseInt(id))) {
      return res.status(400).send('Ungültige Mitarbeiter-ID.');
  }
  const employeeId = parseInt(id);

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN'); // Starte Transaktion

    // 1. Namen holen für Logausgabe (optional, aber gut für Nachvollziehbarkeit)
    const nameResult = await client.query('SELECT name FROM employees WHERE id = $1', [employeeId]);
    if (nameResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send(`Mitarbeiter mit ID ${employeeId} nicht gefunden.`);
    }
    const employeeName = nameResult.rows[0].name;
    console.log(`Versuche Mitarbeiter ${employeeName} (ID: ${employeeId}) und zugehörige Daten zu löschen...`);

    // 2. Lösche den Mitarbeiter selbst. Dank "ON DELETE CASCADE" in den anderen Tabellen
    // sollten work_hours (falls FK gesetzt wäre), monthly_balance und absences automatisch gelöscht werden.
    // WICHTIG: Prüfen, ob ON DELETE CASCADE wirklich in allen relevanten FKs gesetzt ist!
    // Falls work_hours keinen FK mit CASCADE hat, muss es separat gelöscht werden:
     console.log(`Lösche Arbeitszeiten für ${employeeName} (falls kein FK/Cascade)...`);
     // Dieser Schritt ist nur nötig, wenn kein Foreign Key mit ON DELETE CASCADE von work_hours auf employees.id existiert
     // oder wenn work_hours noch auf 'name' basiert.
     const workHoursDeleteResult = await client.query('DELETE FROM work_hours WHERE LOWER(name) = LOWER($1)', [employeeName.toLowerCase()]);
     console.log(`${workHoursDeleteResult.rowCount} Arbeitszeit-Einträge für ${employeeName} gelöscht.`);

     // Lösche jetzt den Mitarbeiter (Balance und Absences werden via FK Cascade gelöscht)
     console.log(`Lösche Mitarbeiter ${employeeName} (ID: ${employeeId}) selbst (inkl. Cascade für Balance/Absences)...`);
    const result = await client.query('DELETE FROM employees WHERE id = $1', [employeeId]);

    await client.query('COMMIT'); // Transaktion bestätigen

    if (result.rowCount > 0) {
        console.log(`Admin Delete MA ID ${employeeId} (${employeeName}) erfolgreich abgeschlossen.`);
        res.status(200).send('Mitarbeiter und alle zugehörigen Daten erfolgreich gelöscht.');
    } else {
         // Sollte nach der Prüfung oben nicht passieren
         console.warn(`Mitarbeiter ${employeeName} (ID: ${employeeId}) nicht gefunden beim Löschen (trotz vorheriger Prüfung).`);
         res.status(404).send(`Mitarbeiter mit ID ${employeeId} nicht gefunden (trotz vorheriger Prüfung).`);
    }

  } catch (err) {
    if (client) await client.query('ROLLBACK'); // Bei Fehler alles zurückrollen
    console.error(`DB Fehler DELETE /admin/employees/${employeeId}:`, err);
    // Mögliche Fehler: FK-Constraint, falls CASCADE nicht richtig gesetzt ist
    if (err.code === '23503') { // foreign_key_violation
        res.status(409).send('Fehler: Mitarbeiter konnte nicht gelöscht werden, da noch abhängige Daten existieren (FK-Constraint ohne CASCADE).');
    } else {
        res.status(500).send('Serverfehler beim Löschen des Mitarbeiters.');
    }
  } finally {
      if (client) client.release(); // Verbindung freigeben
  }
});
// === Auswertungen ===

// Admin: Monatsauswertung berechnen
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  // Wichtig: Hier sollte idealerweise die ID statt des Namens verwendet werden!
  // Das Frontend sendet aktuell den Namen, daher bleibt es vorerst so.
  const { name, year, month } = req.query;
  if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
    return res.status(400).json({ message: "Ungültige Eingabe (Name, Jahr, Monat erforderlich)." });
  }

  try {
      // Die Funktion calculateMonthlyData wurde angepasst, um die Soll-Stunden korrekt zu berechnen
    const result = await calculateMonthlyData(db, name, year, month);
    console.log(`Admin Monatsauswertung berechnet für: ${result.employeeName || name} (${month}/${year})`);
    res.json(result); // Sende das Ergebnisobjekt
  } catch (err) {
    console.error(`Fehler /calculate-monthly-balance (Name: ${name}, ${month}/${year}):`, err);
    if (err.message.includes("Mitarbeiter nicht gefunden")) {
        res.status(404).json({ message: err.message });
    } else {
        // Allgemeiner Serverfehler oder Berechnungsfehler
        res.status(500).json({ message: `Serverfehler bei Monatsberechnung: ${err.message}` });
    }
  }
});

// Admin: Periodenauswertung (Quartal/Jahr) berechnen
app.get('/calculate-period-balance', isAdmin, async (req, res) => {
  // Auch hier wäre ID besser
  const { name, year, periodType, periodValue } = req.query;

  // Validierung
  if (!name || !year || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
    return res.status(400).json({ message: "Ungültige Eingabe (Name, Jahr, periodType='QUARTER'|'YEAR' erforderlich)." });
  }
  if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
    return res.status(400).json({ message: "Ungültige Eingabe für Quartal (periodValue 1-4 erforderlich)." });
  }
  if (isNaN(parseInt(year))) {
      return res.status(400).json({ message: "Ungültiges Jahr." });
  }

  try {
      // Die Funktion calculatePeriodData wurde angepasst, um die Soll-Stunden korrekt zu berechnen
    const result = await calculatePeriodData(db, name, year, periodType.toUpperCase(), periodValue);
    console.log(`Admin Periodenauswertung berechnet für: ${result.employeeName || name} (${year} ${result.periodIdentifier})`);
    res.json(result);
  } catch (err) {
    console.error(`Fehler /calculate-period-balance (Name: ${name}, ${year}, ${periodType}, ${periodValue}):`, err);
    if (err.message.includes("Mitarbeiter nicht gefunden")) {
        res.status(404).json({ message: err.message });
    } else {
        res.status(500).json({ message: `Serverfehler bei Periodenberechnung: ${err.message}` });
    }
  }
});
// === Abwesenheiten ===

// GET: Abwesenheiten für einen Mitarbeiter abrufen
app.get('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId } = req.query;
    if (!employeeId || isNaN(parseInt(employeeId))) {
        return res.status(400).json({ message: 'Gültige employeeId als Query-Parameter erforderlich.' });
    }
    const empIdInt = parseInt(employeeId);

    try {
        // Abfrage nach employee_id, sortiert nach Datum (neueste zuerst für Anzeige)
        const query = `
            SELECT id, date, absence_type, credited_hours, comment
            FROM absences
            WHERE employee_id = $1
            ORDER BY date DESC`;
        const result = await db.query(query, [empIdInt]);

        // Datum für JSON korrekt formatieren (YYYY-MM-DD)
        const formattedResult = result.rows.map(row => ({
            ...row,
            date: (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date)
        }));
        res.json(formattedResult);
    } catch (err) {
        console.error(`Fehler GET /admin/absences (employeeId: ${empIdInt}):`, err);
        res.status(500).json({ message: 'Serverfehler beim Laden der Abwesenheiten.' });
    }
});

// POST: Neue Abwesenheit hinzufügen
app.post('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId, date, absenceType, comment } = req.body;

    // --- Validierung ---
    if (!employeeId || isNaN(parseInt(employeeId)) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !absenceType) {
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten (employeeId, date YYYY-MM-DD, absenceType erforderlich).' });
    }
    if (!['VACATION', 'SICK', 'PUBLIC_HOLIDAY'].includes(absenceType)) {
        return res.status(400).json({ message: 'Ungültiger absenceType. Erlaubt: VACATION, SICK, PUBLIC_HOLIDAY.' });
    }
    const empIdInt = parseInt(employeeId);

    let client;
    try {
        client = await db.connect(); // Verbindung für mehrere Abfragen

        // 1. Mitarbeiterdaten holen, um Soll-Stunden für die Gutschrift zu ermitteln
        const empResult = await client.query('SELECT * FROM employees WHERE id = $1', [empIdInt]);
        if (empResult.rows.length === 0) {
            return res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden.` });
        }
        const employeeData = empResult.rows[0];

        // 2. Datum prüfen (Wochentag, Soll-Stunden)
        const targetDate = new Date(date + 'T00:00:00Z'); // Datum als UTC interpretieren
        const dayOfWeek = targetDate.getUTCDay(); // 0=So, 6=Sa

        // Keine Buchung am Wochenende zulassen (optional, je nach Anforderung)
        if (dayOfWeek === 0 || dayOfWeek === 6) {
             console.warn(`Versuch, Abwesenheit für Mitarbeiter ${empIdInt} am Wochenende (${date}) zu buchen.`);
             return res.status(400).json({ message: 'Abwesenheiten können nicht für Wochenenden (Samstag/Sonntag) gebucht werden.' });
        }

        // Gutgeschriebene Stunden ermitteln (Soll-Stunden für diesen Wochentag)
        const credited_hours = getExpectedHours(employeeData, date);

        // Wenn Soll-Stunden 0 sind an diesem Wochentag, Buchung ablehnen/warnen?
        if (credited_hours <= 0 && absenceType !== 'PUBLIC_HOLIDAY') { // Feiertage evtl. erlauben, auch wenn Soll 0 ist?
            console.warn(`Versuch, Abwesenheit für Mitarbeiter ${empIdInt} an einem Tag (${date}) ohne reguläre Soll-Stunden zu buchen.`);
            return res.status(400).json({ message: `Für diesen Mitarbeiter sind an diesem Wochentag (${targetDate.toLocaleDateString('de-DE', {weekday: 'long', timeZone:'UTC'})}) keine Soll-Stunden hinterlegt (${credited_hours.toFixed(2)} Std.). Abwesenheit nicht gebucht.` });
        }
        // Wenn Feiertag und Soll>0, Gutschrift = Soll. Wenn Feiertag und Soll=0, Gutschrift = 0.
         const finalCreditedHours = (absenceType === 'PUBLIC_HOLIDAY') ? credited_hours : Math.max(0, credited_hours); // Stelle sicher, dass Gutschrift >= 0 ist

        // 3. In Datenbank einfügen
        const insertQuery = `
            INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, date, absence_type, credited_hours, comment; -- Rückgabe des erstellten Eintrags
        `;
        const insertResult = await client.query(insertQuery, [
            empIdInt, date, absenceType, finalCreditedHours, comment || null
        ]);

        // Formatiere Datum für die Rückgabe
         const createdAbsence = {
            ...insertResult.rows[0],
            date: (insertResult.rows[0].date instanceof Date) ?
                   insertResult.rows[0].date.toISOString().split('T')[0] : String(insertResult.rows[0].date),
             // Stelle sicher, dass Stunden als Zahl zurückgegeben werden
             credited_hours: parseFloat(insertResult.rows[0].credited_hours) || 0
         };

        console.log(`Admin Add Absence: MA ID ${empIdInt}, Date ${date}, Type ${absenceType}, Hours ${finalCreditedHours.toFixed(2)}`);
        res.status(201).json(createdAbsence); // 201 Created

    } catch (err) {
        if (err.code === '23505' && err.constraint === 'absences_employee_id_date_key') { // UNIQUE constraint violation
            console.warn(`Versuch, doppelte Abwesenheit für MA ID ${empIdInt} am ${date} zu buchen.`);
            const formattedDate = new Date(date+'T00:00:00Z').toLocaleDateString('de-DE', {timeZone:'UTC'});
            res.status(409).json({ message: `Für diesen Mitarbeiter existiert bereits ein Abwesenheitseintrag am ${formattedDate}.` }); // 409 Conflict
        } else if (err.code === '23503') { // Foreign key violation (employee_id nicht gefunden)
             console.error("FK Fehler POST /admin/absences:", err);
             res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden (FK Fehler).`});
        } else {
            // Anderer Fehler
            console.error(`Fehler POST /admin/absences (MA ID: ${empIdInt}, Date: ${date}):`, err);
            res.status(500).json({ message: 'Serverfehler beim Hinzufügen der Abwesenheit.' });
        }
    } finally {
        if (client) client.release(); // Verbindung freigeben
    }
});
// DELETE: Abwesenheit löschen
app.delete('/admin/absences/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    if (isNaN(parseInt(id))) {
        return res.status(400).send('Ungültige Abwesenheits-ID übergeben.');
    }
    const absenceId = parseInt(id);
    try {
        const result = await db.query('DELETE FROM absences WHERE id = $1', [absenceId]);
        if (result.rowCount > 0) {
            console.log(`Admin Delete Absence ID ${absenceId} erfolgreich.`);
            res.status(200).send('Abwesenheit erfolgreich gelöscht.'); // OK
        } else {
            res.status(404).send(`Abwesenheit mit ID ${absenceId} nicht gefunden.`); // Not Found
        }
    } catch (err) {
        console.error(`Fehler DELETE /admin/absences/${absenceId}:`, err);
        res.status(500).send('Serverfehler beim Löschen der Abwesenheit.');
    }
});

// *** ENDE NEUE ROUTEN FÜR ABWESENHEITEN ***


// === PDF Router ===
// Stelle sicher, dass die calculationUtils korrekt übergeben werden
app.use('/api/pdf', monthlyPdfRouter(db)); // monthlyPdfRouter benötigt die DB-Verbindung


// === Server Start ===
app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (ADMIN_PASSWORD fehlt!)'}`);
  if(db && db.options) {
    console.log(` Datenbank verbunden: Host=${db.options.host || 'localhost'}, Port=${db.options.port || 5432}, DB=${db.options.database}`);
  } else {
      console.warn("!!! Datenbankverbindung scheint nicht initialisiert zu sein !!!");
  }
  console.log(`=======================================================`);
});
