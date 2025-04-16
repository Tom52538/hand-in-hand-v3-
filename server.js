// server.js - KORRIGIERTE VERSION (Trust Proxy + Diagnose-Logging)

// 1. Notwendige Bibliotheken importieren
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const dotenv = require('dotenv');
const Holidays = require('date-holidays');
const { Pool } = require('pg');

dotenv.config();

// NEU: Datenbankverbindung herstellen
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { // Nur wenn nötig
  //   rejectUnauthorized: false
  // }
});

// Datenbankverbindung testen
db.connect((err, client, release) => {
  if (err) {
    console.error('!!! Kritischer Fehler beim Verbinden mit der Datenbank:', err.stack);
    process.exit(1);
  } else {
    console.log('>>> Datenbank erfolgreich verbunden.');
    release();
  }
});

// 2. Express App initialisieren
const app = express();
const port = process.env.PORT || 3000;

// NEU: Express anweisen, dem Proxy zu vertrauen
app.set('trust proxy', 1);

// 3. Globale Variablen und Hilfsfunktionen
const hd = new Holidays('DE', 'NW');
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils');
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint'); // Pfad ggf. anpassen

// Hilfsfunktionen (parseTime, calculateWorkHours, convertToCSV)
// -> Diese können bei Bedarf auch in eine separate utils-Datei ausgelagert werden
function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  let diffInMin = endMinutes - startMinutes;
  if (diffInMin < 0) {
      diffInMin += 24 * 60; // Korrigiert für Mitternacht
  }
  return diffInMin / 60;
}

async function convertToCSV(database, data) {
    if (!data || data.length === 0) return '';
    const csvRows = [];
    const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std", "Differenz", "Bemerkung"];
    csvRows.push(headers.join(','));
    let employeeMap = new Map();
    try {
        const empRes = await database.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees');
        empRes.rows.forEach(emp => employeeMap.set(emp.name.toLowerCase(), emp));
    } catch(e) {
        console.error("Fehler beim Abrufen der Mitarbeiterdaten für CSV-Sollstunden:", e);
    }

    for (const row of data) {
        let dateFormatted = "";
        let dateForCalc = null;
        if (row.date) {
        try {
            const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
            dateForCalc = dateObj.toISOString().split('T')[0];
            const year = dateObj.getUTCFullYear();
            const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getUTCDate()).padStart(2, '0');
            dateFormatted = `${day}.${month}.${year}`;
        } catch (e) { dateFormatted = String(row.date); }
        }
        const startTimeFormatted = row.startTime || ""; // Kommt als HH:MI
        const endTimeFormatted = row.endTime || ""; // Kommt als HH:MI
        const istHours = parseFloat(row.hours) || 0;
        let expectedHours = 0;
        const employeeData = employeeMap.get(String(row.name).toLowerCase());
        if(employeeData && dateForCalc && typeof getExpectedHours === 'function') {
            try {
                 // Prüfen, ob an diesem Tag eine Abwesenheit eingetragen ist (ignoriert Sollstunden)
                const absenceCheck = await database.query('SELECT 1 FROM absences WHERE employee_id = $1 AND date = $2', [employeeData.id, dateForCalc]);
                if (absenceCheck.rows.length === 0) { // Nur wenn KEINE Abwesenheit
                    expectedHours = getExpectedHours(employeeData, dateForCalc);
                }
            } catch (e) { console.error(`Fehler Soll-Std CSV (MA: ${row.name}, D: ${dateForCalc}):`, e); }
        }
        const diffHours = istHours - expectedHours;
        const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
        const values = [
            row.id, row.name, dateFormatted, startTimeFormatted, endTimeFormatted,
            istHours.toFixed(2), expectedHours.toFixed(2), diffHours.toFixed(2), commentFormatted
        ];
        csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}
// server.js Fortsetzung - Middleware

// 4. Middleware konfigurieren
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*', // Sicherer machen für Produktion! z.B. URL deines Frontends
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session Middleware
app.use(session({
    store: new pgSession({
        pool: db, // Übergibt den Pool an connect-pg-simple
        tableName: 'user_sessions' // Name der Session-Tabelle in der DB
    }),
    secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-secret-fuer-dev', // UNBEDINGT IN .env ÄNDERN!
    resave: false, // Nicht speichern, wenn sich nichts geändert hat
    saveUninitialized: false, // Keine leeren Sessions speichern
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Cookie nur über HTTPS senden (wenn 'production') -> wird durch 'trust proxy' korrekt behandelt
        maxAge: 1000 * 60 * 60 * 24, // Gültigkeit 24 Stunden
        httpOnly: true, // Verhindert Zugriff via JS im Browser (Sicherheit+)
        sameSite: 'lax' // Explizit setzen ('lax' ist guter Standard, schützt vor CSRF in vielen Fällen)
    }
}));

// Statische Dateien ausliefern (HTML, CSS, Client-JS)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
    // Prüft, ob die Session existiert UND der isAdmin-Marker gesetzt ist
    if (req.session && req.session.isAdmin === true) {
        next(); // Zugriff erlaubt, fahre mit der nächsten Middleware/Route fort
    } else {
        // Logge den fehlgeschlagenen Versuch für Diagnosezwecke
        console.warn(`isAdmin Check FAILED für Session ID: ${req.sessionID} - isAdmin Flag: ${req.session?.isAdmin} - URL: ${req.originalUrl} von IP ${req.ip}`);
        // Sende Fehlerstatus 403 (Forbidden)
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.'); // Zugriff verweigert
    }
}
// server.js Fortsetzung - DB Setup

// 5. Datenbank-Setup Funktion
const setupTables = async () => {
  try {
    // Tabelle für Mitarbeiter
    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mo_hours DOUBLE PRECISION DEFAULT 0,
        di_hours DOUBLE PRECISION DEFAULT 0,
        mi_hours DOUBLE PRECISION DEFAULT 0,
        do_hours DOUBLE PRECISION DEFAULT 0,
        fr_hours DOUBLE PRECISION DEFAULT 0
      );
    `);
    console.log("Tabelle 'employees' geprüft/erstellt.");

    // Tabelle für erfasste Arbeitszeiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        date DATE NOT NULL,
        starttime TIME,
        endtime TIME,
        hours DOUBLE PRECISION,
        comment TEXT
      );
    `);
    // Index für schnellere Abfragen nach Name und Datum
    await db.query(`CREATE INDEX IF NOT EXISTS idx_work_hours_name_date ON work_hours (LOWER(name), date);`);
    console.log("Tabelle 'work_hours' und Index geprüft/erstellt.");

    // Tabelle für Monatsbilanzen
    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- Wichtig: Löscht Bilanz wenn MA gelöscht wird
        year_month DATE NOT NULL, -- Erster Tag des Monats als Datum (YYYY-MM-01)
        difference DOUBLE PRECISION, -- Differenz Ist/Soll dieses Monats
        carry_over DOUBLE PRECISION, -- Übertrag am Ende dieses Monats (Saldo)
        UNIQUE (employee_id, year_month) -- Jeder MA nur ein Eintrag pro Monat
      );
    `);
    // Index für schnellere Abfragen
    await db.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    console.log("Tabelle 'monthly_balance' und Index geprüft/erstellt.");

    // Tabelle für Abwesenheiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS absences (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- Wichtig: Löscht Abwesenheit wenn MA gelöscht wird
        date DATE NOT NULL,
        absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')), -- Gültige Typen
        credited_hours DOUBLE PRECISION NOT NULL, -- Gutgeschriebene Stunden (basierend auf Soll)
        comment TEXT,
        UNIQUE (employee_id, date) -- Pro MA nur ein Eintrag pro Tag
      );
    `);
     // Index für schnellere Abfragen
    await db.query(`CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);`);
    console.log("Tabelle 'absences' und Index geprüft/erstellt.");

    // Tabelle für Sessions prüfen (wird von connect-pg-simple normalerweise selbst erstellt)
    const sessionTableCheck = await db.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_sessions');`);
    if (!sessionTableCheck.rows[0].exists) {
        console.log("Session-Tabelle 'user_sessions' wird von connect-pg-simple erstellt...");
    } else {
        console.log("Session-Tabelle 'user_sessions' existiert.");
    }

  } catch (err) {
    console.error("!!! Kritischer Datenbank Setup Fehler:", err);
    process.exit(1); // Beendet den Server bei DB-Setup-Fehler
  }
};

// 6. Datenbank-Setup ausführen
setupTables()
  .then(() => {
    console.log('>>> Datenbank Setup erfolgreich abgeschlossen.');
  })
  .catch((err) => {
    console.error('!!! FEHLER beim Ausführen von setupTables:', err);
    process.exit(1); // Beendet den Server bei DB-Setup-Fehler
  });
// server.js Fortsetzung - Öffentliche Endpunkte

// ==========================================
// Öffentliche Endpunkte (kein Login nötig)
// ==========================================

// Health Check Endpoint (nützlich für Deployment-Checks)
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Liefert Liste aller Mitarbeiter (ID und Name)
app.get('/employees', async (req, res) => {
  try {
    // Hole nur ID und Name, sortiert nach Name
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows); // Sende als JSON-Array
  } catch (err) {
    console.error("DB Fehler GET /employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Prüft den letzten Eintrag eines Mitarbeiters, um den nächsten Buchungsstatus zu bestimmen
app.get('/next-booking-details', async (req, res) => {
  const { name } = req.query; // Mitarbeitername aus Query-Parameter
  if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' });

  try {
    // Suche den letzten Eintrag für den Mitarbeiter (ignoriert Groß/Kleinschreibung)
    // Sortiert nach Datum absteigend, dann Startzeit absteigend (NULLS LAST, falls Startzeit fehlt)
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
      FROM work_hours WHERE LOWER(name) = LOWER($1) ORDER BY date DESC, starttime DESC NULLS LAST LIMIT 1;`;
    const result = await db.query(query, [name.toLowerCase()]);

    let nextBooking = 'arbeitsbeginn', entryId = null, startDate = null, startTime = null;

    if (result.rows.length > 0) {
      const lastEntry = result.rows[0];
      // Wenn der letzte Eintrag eine Startzeit, aber KEINE Endzeit hat -> Arbeitsende ist nächster Schritt
      if (lastEntry.starttime_formatted && !lastEntry.endtime) {
        nextBooking = 'arbeitsende';
        entryId = lastEntry.id; // Die ID des offenen Eintrags
        // Datum und Startzeit für Anzeige im Frontend zurückgeben
        startDate = lastEntry.date instanceof Date ? lastEntry.date.toISOString().split('T')[0] : lastEntry.date; // Format YYYY-MM-DD
        startTime = lastEntry.starttime_formatted; // Format HH:MI
      }
    }
    // Sende den Status und ggf. Details des offenen Eintrags
    res.json({ nextBooking, id: entryId, startDate, startTime });
  } catch (err) {
    console.error("Fehler /next-booking-details:", err);
    res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
  }
});

// Bucht den Arbeitsbeginn
app.post('/log-start', async (req, res) => {
    const { name, date, startTime } = req.body;
    // Validierung der Eingabedaten
    if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten (Name, Datum YYYY-MM-DD, Startzeit HH:MM).' });
    }

    try {
        // Prüfen, ob Mitarbeiter existiert (case-insensitive) und korrekten Namen holen
        const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
        if (empCheck.rows.length === 0) return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
        const dbEmployeeName = empCheck.rows[0].name; // Den Namen aus der DB verwenden

        // Prüfen, ob es bereits einen offenen Eintrag für diesen Tag gibt
        const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
        const checkOpenResult = await db.query(checkOpenQuery, [dbEmployeeName.toLowerCase(), date]);
        if (checkOpenResult.rows.length > 0) return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Arbeitsbeginn.` });

        // Optional: Prüfung auf abgeschlossene Einträge am selben Tag (auskommentiert für Mehrfachbuchungen)
        // const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
        // const checkCompleteResult = await db.query(checkCompleteQuery, [dbEmployeeName.toLowerCase(), date]);
        // if (checkCompleteResult.rows.length > 0) console.warn(`Warnung: Mitarbeiter ${dbEmployeeName} bucht erneut Start am ${date}...`);

        // Neuen Eintrag erstellen
        const insertQuery = `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`;
        const insertResult = await db.query(insertQuery, [dbEmployeeName, date, startTime]);
        const newEntryId = insertResult.rows[0].id;
        console.log(`Start gebucht: ${dbEmployeeName}, ${date}, ${startTime} (ID: ${newEntryId})`);
        res.status(201).json({ id: newEntryId }); // Status 201 Created, sende ID zurück

    } catch (err) { console.error("Fehler /log-start:", err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' }); }
});

// Bucht das Arbeitsende und berechnet die Stunden
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params; // ID aus der URL
  const { endTime, comment } = req.body; // Endzeit und Kommentar aus dem Request Body
  // Validierung
  if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit HH:MM).' });
  }
  const entryId = parseInt(id);

  try {
    // Eintrag holen, um Startzeit zu bekommen und zu prüfen, ob er existiert/offen ist
    const entryResult = await db.query(
      `SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE id = $1`,
      [entryId]
    );
    if (entryResult.rows.length === 0) return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
    const entry = entryResult.rows[0];
    if (entry.endtime) return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` }); // Conflict
    if (!entry.starttime_formatted) return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden.` });

    // Arbeitsstunden berechnen
    const netHours = calculateWorkHours(entry.starttime_formatted, endTime);
    if (netHours < 0) { // Sollte durch die Logik in calculateWorkHours jetzt nicht mehr passieren, aber sicher ist sicher
      console.warn(`Negative Arbeitszeit für ID ${entryId} (${entry.starttime_formatted} - ${endTime}) berechnet. Speichere 0.`);
    }

    // Eintrag aktualisieren
    const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`;
    await db.query(updateQuery, [endTime, comment || null, netHours >= 0 ? netHours : 0, entryId]); // Speichere 0 bei negativem Ergebnis
    console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Stunden: ${netHours.toFixed(2)})`);
    res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) });

  } catch (err) { console.error(`Fehler /log-end/${entryId}:`, err); res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' }); }
});

// Liefert Zusammenfassung der Stunden für einen Tag und den laufenden Monat
app.get('/summary-hours', async (req, res) => {
  const { name, date } = req.query;
  // Validierung
  if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
  }

  try {
    // Tägliche Stunden summieren
    const dailyResult = await db.query(
      `SELECT SUM(hours) AS total_daily_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL`,
      [name.toLowerCase(), date]
    );
    const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0;

    // Monatliche Stunden summieren (vom 1. des Monats bis zum angegebenen Datum)
    const yearMonthDay = date.split('-');
    const year = parseInt(yearMonthDay[0]);
    const month = parseInt(yearMonthDay[1]);
    const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
    const lastDayForQuery = date; // Bis zum angefragten Tag

    const monthlyResult = await db.query(
      `SELECT SUM(hours) AS total_monthly_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`,
      [name.toLowerCase(), firstDayOfMonth, lastDayForQuery]
    );
    const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0;

    res.json({ dailyHours, monthlyHours }); // Sende beide Werte als JSON

  } catch (err) { console.error(`Fehler /summary-hours (${name}, ${date}):`, err); res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' }); }
});
// server.js Fortsetzung - Admin Login/Logout, Arbeitszeiten Admin

// ==========================================
// Admin Endpunkte (Login erforderlich via isAdmin Middleware)
// ==========================================

// Admin-Login
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  // Kritischer Fehler, wenn kein Admin-Passwort gesetzt ist
  if (!adminPassword) { console.error("!!! ADMIN_PASSWORD ist nicht gesetzt!"); return res.status(500).send("Serverkonfigurationsfehler."); }
  if (!password) { return res.status(400).send("Passwort fehlt."); }

  if (password === adminPassword) {
    // Passwort korrekt: Session regenerieren (verhindert Session Fixation)
    req.session.regenerate((errReg) => {
      if (errReg) { console.error("Fehler beim Regenerieren der Session:", errReg); return res.status(500).send("Session Fehler."); }
      // isAdmin-Flag in der neuen Session setzen
      req.session.isAdmin = true;
      // Session speichern (wichtig nach regenerate)
      req.session.save((errSave) => {
        if (errSave) { console.error("Fehler beim Speichern der Session:", errSave); return res.status(500).send("Session Speicherfehler."); }
        console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`);
        res.status(200).send("Admin erfolgreich angemeldet.");
      });
    });
  } else {
    console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`);
    res.status(401).send("Ungültiges Passwort."); // Unauthorized
  }
});

// Admin-Logout
app.post("/admin-logout", isAdmin, (req, res) => { // isAdmin schützt den Logout-Endpunkt
  if (req.session) {
    const sessionId = req.sessionID;
    // Session zerstören
    req.session.destroy(err => {
      if (err) { console.error("Fehler beim Zerstören der Session:", err); return res.status(500).send("Fehler beim Logout."); }
      res.clearCookie('connect.sid'); // Session-Cookie löschen (Name anpassen, falls geändert)
      console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else {
    // Sollte nicht passieren, wenn isAdmin verwendet wird, aber sicher ist sicher
    return res.status(200).send("Keine aktive Session zum Abmelden gefunden.");
  }
});

// Arbeitszeiten für Admin anzeigen (mit Filterung)
app.get('/admin-work-hours', isAdmin, async (req, res) => {
    const { employeeId, year, month } = req.query;
    // +++ LOGGING START +++
    const logPrefix = `[ROUTE:/admin-work-hours] EmpID: ${employeeId}, M: ${month}/${year}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    // +++ LOGGING ENDE +++

    // Basis-Query mit JOIN, um den Mitarbeiternamen zu bekommen
    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
    const whereClauses = []; // Array für WHERE-Bedingungen
    const queryParams = []; // Array für Query-Parameter ($1, $2, ...)
    let paramIndex = 1; // Zähler für Parameter-Platzhalter

    // Filter nach Mitarbeiter-ID (wenn angegeben und nicht 'all'/'')
    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId);
        if (isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});}
        whereClauses.push(`e.id = $${paramIndex++}`);
        queryParams.push(empIdInt);
    }
    // Filter nach Jahr und Monat (wenn beides angegeben)
    if (year && month) {
        const parsedYear = parseInt(year);
        const parsedMonth = parseInt(month);
        // Validierung für Jahr/Monat
        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) {
            console.error(`${logPrefix} ERROR - Invalid year/month.`);
            return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' });
        }
        try {
            // Datumsbereich für den Monat erstellen (UTC)
            const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
            const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Erster Tag des Folgemonats (exklusiv)
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt');
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];
            // WHERE-Bedingungen hinzufügen
            whereClauses.push(`w.date >= $${paramIndex++}`);
            queryParams.push(startDateStr);
            whereClauses.push(`w.date < $${paramIndex++}`); // Wichtig: '<' für exklusives Enddatum
            queryParams.push(endDateStr);
        } catch(dateError) {
            console.error(`${logPrefix} ERROR - Date processing error:`, dateError);
            return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` });
        }
    }

    // Finale Query zusammenbauen
    let finalQuery = baseQuery;
    if (whereClauses.length > 0) {
        finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; // Bedingungen mit AND verknüpfen
    }
    // Sortierung hinzufügen
    finalQuery += ` ORDER BY w.date DESC, e.name ASC, w.starttime ASC NULLS LAST;`;

    console.log(`${logPrefix} Executing query: ${finalQuery.substring(0, 200)}... Params: ${queryParams}`); // Log query start

    try {
        const result = await db.query(finalQuery, queryParams);
        console.log(`${logPrefix} Query successful, ${result.rows.length} rows found. Formatting and sending response.`); // Log success
        // Datum formatieren (optional, aber oft besser für Frontend)
        const formattedRows = result.rows.map(row => ({
            ...row,
            date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date // Sicherstellen YYYY-MM-DD
        }));
        res.json(formattedRows);
    } catch (err) {
        console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); // Log error
        res.status(500).send('Serverfehler beim Laden der gefilterten Arbeitszeiten.');
    }
});

// CSV-Download für Admin (berücksichtigt Filter)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
    // +++ LOGGING START +++
    const logPrefix = `[ROUTE:/admin-download-csv] Query: ${JSON.stringify(req.query)}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    // +++ LOGGING ENDE +++
    const { employeeId, year, month } = req.query;

    // Query-Logik (fast identisch zu /admin-work-hours, aber andere Sortierung für CSV)
    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;
    let filterDesc = ""; // Für Dateinamen

    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId);
        if (isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'}); }
        whereClauses.push(`e.id = $${paramIndex++}`);
        queryParams.push(empIdInt);
        try { // Mitarbeitername für Dateinamen holen
            const nameRes = await db.query('SELECT name FROM employees WHERE id = $1', [empIdInt]);
            if(nameRes.rows.length > 0) filterDesc = nameRes.rows[0].name.replace(/[^a-z0-9]/gi, '_'); // Namen bereinigen
        } catch {}
    } else {
        filterDesc = "alle_MA";
    }

    if (year && month) {
        const parsedYear = parseInt(year);
        const parsedMonth = parseInt(month);
        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) {
            console.error(`${logPrefix} ERROR - Invalid year/month.`);
            return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' });
        }
        try {
            const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
            const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt');
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];
            whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr);
            whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr);
            filterDesc += `_${year}_${String(parsedMonth).padStart(2,'0')}`;
        } catch(dateError) {
            console.error(`${logPrefix} ERROR - Date processing error:`, dateError);
            return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` });
        }
    } else {
        filterDesc += "_alle_Zeiten";
    }

    let finalQuery = baseQuery;
    if (whereClauses.length > 0) finalQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    // Sortierung für CSV: chronologisch
    finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS LAST;`;

    console.log(`${logPrefix} Executing query for CSV: ${finalQuery.substring(0, 200)}... Params: ${queryParams}`); // Log query start

    try {
        const result = await db.query(finalQuery, queryParams);
        console.log(`${logPrefix} Query successful, ${result.rows.length} rows found. Generating CSV...`); // Log success
        const csvData = await convertToCSV(db, result.rows); // Nutzt die erweiterte convertToCSV
        const filename = `arbeitszeiten_${filterDesc}_${new Date().toISOString().split('T')[0]}.csv`;
        // Setze Header für CSV-Download mit UTF-8
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        // Füge BOM hinzu für Excel-Kompatibilität mit Umlauten etc.
        res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));
        console.log(`${logPrefix} CSV sent successfully.`); // Log completion
    } catch (err) {
        console.error(`${logPrefix} ERROR - DB or CSV Error: ${err.message}`, err.stack); // Log error
        res.status(500).send('Serverfehler beim Erstellen des CSV-Exports.');
    }
});

// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/api/admin/update-hours] ID: ${req.body?.id}, Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`);
  // +++ LOGGING ENDE +++
  const { id, date, startTime, endTime, comment } = req.body;
  const entryId = parseInt(id);

  // Validierung
  if (isNaN(entryId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).json({ message: 'Ungültige ID.' }); }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`${logPrefix} ERROR - Invalid Date.`); return res.status(400).json({ message: 'Ungültiges Datum.' }); }
  if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) { console.error(`${logPrefix} ERROR - Invalid startTime.`); return res.status(400).json({ message: 'Ungültige Startzeit.' }); }
  if (!endTime || !/^\d{2}:\d{2}$/.test(endTime)) { console.error(`${logPrefix} ERROR - Invalid endTime.`); return res.status(400).json({ message: 'Ungültige Endzeit.' }); }

  // Stunden neu berechnen
  const netHours = calculateWorkHours(startTime, endTime);
  if (netHours < 0) console.warn(`${logPrefix} Negative work hours calculated. Saving 0.`);

  try {
      console.log(`${logPrefix} Checking if entry exists...`);
      // Optional: Prüfen ob Eintrag existiert (sollte nicht nötig sein, da Update sonst fehlschlägt)
      // const checkResult = await db.query('SELECT 1 FROM work_hours WHERE id = $1', [entryId]);
      // if (checkResult.rows.length === 0) { console.warn(`${logPrefix} Entry not found.`); return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` });}

      console.log(`${logPrefix} Updating entry in DB...`);
      const query = `UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6;`;
      const result = await db.query(query, [date, startTime, endTime, netHours >= 0 ? netHours : 0, comment || null, entryId]);

      if (result.rowCount > 0) {
          console.log(`${logPrefix} Update successful.`);
          res.status(200).send('Eintrag aktualisiert.');
      } else {
          // Das sollte nur passieren, wenn die ID nicht existiert
          console.warn(`${logPrefix} Update failed (rowCount=0). Entry ID ${entryId} likely not found.`);
          res.status(404).send(`Eintrag ID ${entryId} nicht gefunden oder nicht aktualisiert.`);
      }
  } catch (err) { console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); res.status(500).send('Serverfehler Update.'); }
});

// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/api/admin/delete-hours] ID: ${req.params?.id}, Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received.`);
  // +++ LOGGING ENDE +++
  const { id } = req.params;
  const entryId = parseInt(id);
  if (isNaN(entryId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.'); }

  try {
    console.log(`${logPrefix} Deleting entry from DB...`);
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]);

    if (result.rowCount > 0) {
        console.log(`${logPrefix} Delete successful.`);
        res.status(200).send('Eintrag gelöscht.');
    } else {
        console.warn(`${logPrefix} Entry not found.`);
        res.status(404).send(`Eintrag ID ${entryId} nicht gefunden.`);
    }
  } catch (err) { console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); res.status(500).send('Serverfehler Löschen.'); }
});

// Admin: Alle Daten löschen (Arbeitszeiten, Bilanzen, Abwesenheiten) - SEHR GEFÄHRLICH!
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/adminDeleteData] Session: ${req.sessionID} -`;
  console.warn(`${logPrefix} !!! DELETE ALL DATA REQUEST RECEIVED !!!`);
  // +++ LOGGING ENDE +++

  // Doppelte Sicherheitsabfrage im Frontend ist entscheidend!

  let client; // DB Client für Transaktion
  try {
      client = await db.connect(); // Verbindung aus Pool holen
      await client.query('BEGIN'); // Transaktion starten

      // Reihenfolge beachten wegen Foreign Keys (obwohl ON DELETE CASCADE helfen sollte)
      console.warn(`${logPrefix} Deleting monthly_balance...`);
      const resultMB = await client.query('DELETE FROM monthly_balance');
      console.warn(`${logPrefix} -> ${resultMB.rowCount} rows deleted.`);

      console.warn(`${logPrefix} Deleting absences...`);
      const resultAbs = await client.query('DELETE FROM absences');
      console.warn(`${logPrefix} -> ${resultAbs.rowCount} rows deleted.`);

      console.warn(`${logPrefix} Deleting work_hours...`);
      const resultWH = await client.query('DELETE FROM work_hours');
      console.warn(`${logPrefix} -> ${resultWH.rowCount} rows deleted.`);

      await client.query('COMMIT'); // Transaktion abschließen, wenn alles ok war
      console.warn(`${logPrefix} !!! ALL DATA DELETED SUCCESSFULLY !!!`);
      res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiten, ${resultMB.rowCount} Bilanzen und ${resultAbs.rowCount} Abwesenheiten wurden gelöscht.`);

  } catch (err) {
      if (client) await client.query('ROLLBACK'); // Bei Fehler: Transaktion zurückrollen!
      console.error(`${logPrefix} !!! CRITICAL DB ERROR DURING DELETE ALL: ${err.message}`, err.stack);
      res.status(500).send('Serverfehler beim Löschen. Transaktion zurückgerollt.');
  } finally {
      if (client) client.release(); // Verbindung zurück in den Pool geben
  }
});
// server.js Fortsetzung - Mitarbeiterverwaltung

// --- Mitarbeiterverwaltung ---
app.get('/admin/employees', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/admin/employees GET] Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received.`);
  // +++ LOGGING ENDE +++
  try {
    console.log(`${logPrefix} Querying employees...`);
    // Alle Mitarbeiterdaten abrufen, sortiert nach Name
    const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC');
    console.log(`${logPrefix} Query successful, found ${result.rows.length} employees.`);
    res.json(result.rows);
  } catch (err) { console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); res.status(500).send('Serverfehler Laden MA.'); }
});

app.post('/admin/employees', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/admin/employees POST] Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`);
  // +++ LOGGING ENDE +++
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : ''; // Whitespace entfernen

  // Validierung
  if (!trimmedName) { console.error(`${logPrefix} ERROR - Empty name.`); return res.status(400).send('Name darf nicht leer sein.'); }
  // Stunden parsen (Standard 0) und auf negativ prüfen
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
  if (hours.some(h => h < 0)) { console.error(`${logPrefix} ERROR - Negative hours.`); return res.status(400).send('Stunden dürfen nicht negativ sein.');}

  try {
    console.log(`${logPrefix} Inserting new employee '${trimmedName}'...`);
    const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`; // Gibt den neuen Eintrag zurück
    const result = await db.query(query, [trimmedName, ...hours]);
    console.log(`${logPrefix} Insert successful. ID: ${result.rows[0].id}`);
    res.status(201).json(result.rows[0]); // Status 201 Created

  } catch (err) {
    // Fehlerbehandlung für UNIQUE Constraint (doppelter Name)
    if (err.code === '23505') { // PostgreSQL Fehlercode für unique_violation
      console.warn(`${logPrefix} Conflict - Employee name '${trimmedName}' already exists.`);
      res.status(409).send(`Mitarbeiter '${trimmedName}' existiert bereits.`); // Conflict
    } else {
      // Anderer DB-Fehler
      console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack);
      res.status(500).send('Serverfehler Hinzufügen MA.');
    }
  }
});

app.put('/admin/employees/:id', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/admin/employees PUT] ID: ${req.params?.id}, Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`);
  // +++ LOGGING ENDE +++
  const { id } = req.params;
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const employeeId = parseInt(id);
  const trimmedName = name ? name.trim() : '';

  // Validierung
  if (isNaN(employeeId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.'); }
  if (!trimmedName) { console.error(`${logPrefix} ERROR - Empty name.`); return res.status(400).send('Name darf nicht leer sein.'); }
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
  if (hours.some(h => h < 0)) { console.error(`${logPrefix} ERROR - Negative hours.`); return res.status(400).send('Stunden dürfen nicht negativ sein.');}

  let client; // Für Transaktion
  try {
      client = await db.connect();
      await client.query('BEGIN'); // Transaktion starten
      console.log(`${logPrefix} Transaction started.`);

      // 1. Alten Namen holen (für den Fall, dass er sich ändert)
      console.log(`${logPrefix} Fetching old name...`);
      // FOR UPDATE sperrt die Zeile für andere Transaktionen
      const oldNameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);
      if (oldNameResult.rows.length === 0) {
          await client.query('ROLLBACK'); // Transaktion abbrechen
          console.warn(`${logPrefix} Employee not found.`);
          return res.status(404).send(`Mitarbeiter ID ${employeeId} nicht gefunden.`);
      }
      const oldName = oldNameResult.rows[0].name;
      const newName = trimmedName;

      // 2. Mitarbeiterdaten in 'employees' aktualisieren
      console.log(`${logPrefix} Updating employee table... Old: ${oldName}, New: ${newName}`);
      const updateEmpQuery = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
      await client.query(updateEmpQuery, [newName, ...hours, employeeId]);

      // 3. Wenn Name geändert wurde, auch in 'work_hours' aktualisieren (case-insensitive Vergleich)
      if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) {
          console.log(`${logPrefix} Name changed, updating work_hours...`);
          const workHoursUpdateResult = await client.query(
              `UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`,
              [newName, oldName.toLowerCase()] // Neuen Namen setzen, wo der alte Name (lower case) stand
          );
          console.log(`${logPrefix} -> ${workHoursUpdateResult.rowCount} work_hours rows updated.`);
      }

      await client.query('COMMIT'); // Transaktion erfolgreich abschließen
      console.log(`${logPrefix} Transaction committed successfully.`);
      res.status(200).send('Mitarbeiterdaten aktualisiert.');

  } catch (err) {
      if (client) await client.query('ROLLBACK'); // Bei Fehler zurückrollen
      console.error(`${logPrefix} ERROR during transaction. Rolled back. Error: ${err.message}`, err.stack);
      // Spezifische Fehlerbehandlung
      if (err.code === '23505') { // Namenskonflikt
          res.status(409).send(`Name '${trimmedName}' existiert bereits.`);
      } else {
          res.status(500).send('Serverfehler Update MA.');
      }
  } finally {
      if (client) client.release(); // Verbindung freigeben
  }
});

app.delete('/admin/employees/:id', isAdmin, async (req, res) => {
  // +++ LOGGING START +++
  const logPrefix = `[ROUTE:/admin/employees DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`;
  console.warn(`${logPrefix} !!! DELETE EMPLOYEE REQUEST RECEIVED !!!`);
  // +++ LOGGING ENDE +++
  const { id } = req.params;
  const employeeId = parseInt(id);
  if (isNaN(employeeId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.');}

  let client; // Für Transaktion
  try {
    client = await db.connect();
    await client.query('BEGIN'); // Transaktion starten
    console.log(`${logPrefix} Transaction started.`);

    // Optional aber gut für Logging: Namen holen, bevor gelöscht wird
    console.log(`${logPrefix} Fetching employee name...`);
    const nameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);
    if (nameResult.rows.length === 0) {
        await client.query('ROLLBACK');
        console.warn(`${logPrefix} Employee not found.`);
        return res.status(404).send(`Mitarbeiter ID ${employeeId} nicht gefunden.`);
    }
    const employeeName = nameResult.rows[0].name;

    // WICHTIG: Aufgrund von `ON DELETE CASCADE` in den Tabellen `monthly_balance` und `absences`
    // werden die zugehörigen Einträge dort automatisch gelöscht, wenn der Mitarbeiter gelöscht wird.
    // Wir müssen aber die `work_hours` manuell löschen, da dort kein Foreign Key mit CASCADE definiert ist.

    // 1. Arbeitszeiten für diesen Mitarbeiter löschen
    console.warn(`${logPrefix} Deleting work_hours for ${employeeName}...`);
    const workHoursDeleteResult = await client.query(
        'DELETE FROM work_hours WHERE LOWER(name) = LOWER($1)', // Lösche alle Einträge mit diesem Namen (case-insensitive)
        [employeeName.toLowerCase()]
    );
    console.warn(`${logPrefix} -> ${workHoursDeleteResult.rowCount} work_hours rows deleted.`);

    // 2. Mitarbeiter aus 'employees' löschen (löst CASCADE für Bilanzen und Abwesenheiten aus)
    console.warn(`${logPrefix} Deleting employee ${employeeName} (ID: ${employeeId}) from employees table (cascades to absences, monthly_balance)...`);
    const deleteEmpResult = await client.query('DELETE FROM employees WHERE id = $1', [employeeId]);

    if (deleteEmpResult.rowCount > 0) {
        await client.query('COMMIT'); // Transaktion erfolgreich
        console.warn(`${logPrefix} !!! Employee and related data deleted successfully. Transaction committed. !!!`);
        res.status(200).send('Mitarbeiter und alle zugehörigen Daten gelöscht.');
    } else {
        // Sollte nicht passieren, wenn Name gefunden wurde, aber sicher ist sicher
        await client.query('ROLLBACK');
        console.warn(`${logPrefix} Employee delete failed (rowCount=0). Rolled back.`);
        res.status(404).send(`Mitarbeiter ID ${employeeId} nicht gelöscht (nicht gefunden?).`);
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK'); // Bei Fehler zurückrollen!
    console.error(`${logPrefix} !!! CRITICAL ERROR during employee delete. Rolled back. Error: ${err.message}`, err.stack);
    // Fehlerbehandlung für Foreign Key, obwohl CASCADE das verhindern sollte
    if (err.code === '23503') { // foreign_key_violation
        res.status(409).send('Löschen nicht möglich: Abhängige Daten existieren (sollte durch CASCADE nicht passieren!). Bitte Admin prüfen.');
    } else {
        res.status(500).send('Serverfehler Löschen MA.');
    }
  } finally {
      if (client) client.release(); // Verbindung freigeben
  }
});
// server.js Fortsetzung - Auswertungen

// --- Auswertungen ---

// Admin: Monatsauswertung berechnen und zurückgeben
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;
  const logPrefix = `[ROUTE:/calculate-monthly-balance] MA: ${name}, Date: ${month}/${year}, Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received.`);

  // Validierung
  if (!name || !year || !month || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4 || isNaN(parseInt(month)) || month < 1 || month > 12) {
      console.error(`${logPrefix} ERROR - Invalid input.`);
      return res.status(400).json({ message: "Ungültige Eingabe: Name, Jahr (YYYY) und Monat (1-12) erforderlich." });
  }

  try {
    // Rufe die Berechnungsfunktion aus calculationUtils.js auf
    console.log(`${logPrefix} Calling calculateMonthlyData...`);
    const result = await calculateMonthlyData(db, name, year, month); // Übergibt DB-Pool
    console.log(`${logPrefix} calculateMonthlyData successful. Sending response.`);
    res.json(result); // Sende das Ergebnis als JSON

  } catch (err) {
    console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`);
    // Spezifische Fehlerbehandlung (z.B. Mitarbeiter nicht gefunden)
    if (err.message && err.message.toLowerCase().includes("nicht gefunden")) {
      res.status(404).json({ message: err.message }); // Not Found
    } else {
      res.status(500).json({ message: `Serverfehler bei der Monatsberechnung: ${err.message}` }); // Internal Server Error
    }
  }
});

// Admin: Periodenauswertung (Quartal/Jahr) berechnen und zurückgeben
app.get('/calculate-period-balance', isAdmin, async (req, res) => {
  const { name, year, periodType, periodValue } = req.query;
  const logPrefix = `[ROUTE:/calculate-period-balance] MA: ${name}, Year: ${year}, Type: ${periodType}, Val: ${periodValue}, Session: ${req.sessionID} -`;
  console.log(`${logPrefix} Request received.`);

  // Basisvalidierung
  if (!name || !year || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4) {
      console.error(`${logPrefix} ERROR - Invalid name or year.`);
      return res.status(400).json({ message: "Ungültige Eingabe: Name und Jahr (YYYY) erforderlich." });
  }

  // Periodentyp validieren
  const periodTypeUpper = periodType ? periodType.toUpperCase() : null;
  if (!periodTypeUpper || !['QUARTER', 'YEAR'].includes(periodTypeUpper)) {
      console.error(`${logPrefix} ERROR - Invalid periodType.`);
      return res.status(400).json({ message: "Ungültiger Periodentyp. Erlaubt sind 'QUARTER' oder 'YEAR'." });
  }

  // Periodenwert validieren (nur für Quartal relevant)
  let parsedPeriodValue = null;
  if (periodTypeUpper === 'QUARTER') {
      parsedPeriodValue = parseInt(periodValue);
      if (!periodValue || isNaN(parsedPeriodValue) || parsedPeriodValue < 1 || parsedPeriodValue > 4) {
          console.error(`${logPrefix} ERROR - Invalid periodValue for QUARTER.`);
          return res.status(400).json({ message: "Ungültiges Quartal (1-4) für Periodentyp 'QUARTER' erforderlich." });
      }
  }

  try {
    // Rufe die Berechnungsfunktion aus calculationUtils.js auf
    console.log(`${logPrefix} Calling calculatePeriodData...`);
    const result = await calculatePeriodData(db, name, year, periodTypeUpper, parsedPeriodValue); // Übergibt DB-Pool
    console.log(`${logPrefix} calculatePeriodData successful. Sending response.`);
    res.json(result); // Sende Ergebnis als JSON

  } catch (err) {
    console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`);
    // Spezifische Fehlerbehandlung
    if (err.message && err.message.toLowerCase().includes("nicht gefunden")) {
      res.status(404).json({ message: err.message }); // Not Found
    } else {
      res.status(500).json({ message: `Serverfehler bei der Periodenberechnung: ${err.message}` }); // Internal Server Error
    }
  }
});
// server.js Fortsetzung - Abwesenheiten

// --- Abwesenheiten ---

// GET: Abwesenheiten für einen Mitarbeiter abrufen
app.get('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId } = req.query;
    const empIdInt = parseInt(employeeId);
    const logPrefix = `[ROUTE:/admin/absences] EmpID: ${employeeId}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);

    // Validierung
    if (!employeeId || isNaN(empIdInt)) {
        console.error(`${logPrefix} ERROR - Invalid employeeId.`);
        return res.status(400).json({ message: 'Gültige numerische employeeId als Query-Parameter erforderlich.' });
    }

    try {
        console.log(`${logPrefix} Querying absences from DB...`);
        // Abwesenheiten für die gegebene Mitarbeiter-ID holen, nach Datum sortiert
        const query = `SELECT id, date, absence_type, credited_hours, comment FROM absences WHERE employee_id = $1 ORDER BY date DESC`;
        const result = await db.query(query, [empIdInt]);
        console.log(`${logPrefix} DB query successful, found ${result.rows.length} entries. Formatting and sending response.`);

        // Datum formatieren (sicherstellen YYYY-MM-DD)
        const formattedResult = result.rows.map(row => ({
            ...row,
            date: (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date)
        }));
        res.json(formattedResult);

    } catch (err) {
        console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`, err.stack);
        res.status(500).json({ message: 'Serverfehler beim Laden der Abwesenheiten.' });
    }
});


// POST: Neue Abwesenheit hinzufügen
app.post('/admin/absences', isAdmin, async (req, res) => {
    // +++ LOGGING START +++
    const logPrefix = `[ROUTE:/admin/absences POST] Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`);
    // +++ LOGGING ENDE +++
    const { employeeId, date, absenceType, comment } = req.body;

    // Validierung
    const empIdInt = parseInt(employeeId);
    if (!employeeId || isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Gültige numerische employeeId erforderlich.' }); }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`${logPrefix} ERROR - Invalid date.`); return res.status(400).json({ message: 'Gültiges Datum im Format YYYY-MM-DD erforderlich.' }); }
    if (!absenceType || !['VACATION', 'SICK', 'PUBLIC_HOLIDAY'].includes(absenceType.toUpperCase())) { console.error(`${logPrefix} ERROR - Invalid absenceType.`); return res.status(400).json({ message: "Ungültiger absenceType. Erlaubt: 'VACATION', 'SICK', 'PUBLIC_HOLIDAY'." }); }

    const normalizedAbsenceType = absenceType.toUpperCase();
    const targetDate = new Date(date + 'T00:00:00Z'); // UTC für konsistente Wochentagsberechnung
    const dayOfWeek = targetDate.getUTCDay(); // 0=So, 6=Sa

    // Keine Buchung am Wochenende
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        const fd = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'});
        console.warn(`${logPrefix} Attempt to book absence on weekend (${fd}).`);
        return res.status(400).json({ message: `Abwesenheiten können nicht am Wochenende (${fd}) gebucht werden.` });
    }

    // Wenn Typ 'PUBLIC_HOLIDAY', prüfen ob es wirklich einer ist
    if (normalizedAbsenceType === 'PUBLIC_HOLIDAY') {
        const isHoliday = hd.isHoliday(targetDate); // Nutzt date-holidays Instanz
        if (!isHoliday || isHoliday.type !== 'public') { // Prüfen ob wirklich public holiday
            const fd = targetDate.toLocaleDateString('de-DE',{timeZone:'UTC'});
            console.warn(`${logPrefix} Attempt to book non-public-holiday ${fd} as PUBLIC_HOLIDAY for MA ${empIdInt}.`);
            return res.status(400).json({ message: `Das Datum ${fd} ist laut System kein gesetzlicher Feiertag in NRW.` });
        }
    }

    let client; // Für Transaktion
    try {
        client = await db.connect();
        await client.query('BEGIN'); // Transaktion starten
        console.log(`${logPrefix} Transaction started.`);

        // Mitarbeiterdaten holen für Soll-Stunden-Berechnung
        console.log(`${logPrefix} Fetching employee data for ID ${empIdInt}...`);
        const empResult = await client.query('SELECT * FROM employees WHERE id = $1', [empIdInt]);
        if (empResult.rows.length === 0) {
            await client.query('ROLLBACK');
            console.warn(`${logPrefix} Employee not found.`);
            return res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden.` });
        }
        const employeeData = empResult.rows[0];

        // Soll-Stunden für den Tag berechnen
        console.log(`${logPrefix} Calculating expected hours for ${date}...`);
        const expectedHoursForDay = getExpectedHours(employeeData, date); // Nutzt Funktion aus calculationUtils
        let credited_hours = expectedHoursForDay;

        // Bei Urlaub/Krankheit: Keine Buchung, wenn Soll=0
        if (normalizedAbsenceType !== 'PUBLIC_HOLIDAY' && expectedHoursForDay <= 0) {
            const fd = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'});
            await client.query('ROLLBACK');
            console.warn(`${logPrefix} Cannot book absence, employee has 0 expected hours on ${fd}.`);
            return res.status(400).json({ message: `Buchung nicht möglich: Mitarbeiter ${employeeData.name} hat an diesem Tag (${fd}) keine Soll-Stunden.` });
        }
        // Sicherstellen, dass Gutschrift nicht negativ ist (sollte nicht passieren)
        credited_hours = Math.max(0, credited_hours);

        // Abwesenheit einfügen
        console.log(`${logPrefix} Inserting absence (Type: ${normalizedAbsenceType}, Credited: ${credited_hours})...`);
        const insertQuery = `INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id, date, absence_type, credited_hours, comment;`; // Gibt den erstellten Eintrag zurück
        const insertResult = await client.query(insertQuery, [empIdInt, date, normalizedAbsenceType, credited_hours, comment || null]);

        await client.query('COMMIT'); // Transaktion erfolgreich
        console.log(`${logPrefix} Transaction committed. Absence ID: ${insertResult.rows[0].id}`);

        // Formatiertes Ergebnis zurückgeben
        const createdAbsence = {
            ...insertResult.rows[0],
            date: insertResult.rows[0].date.toISOString().split('T')[0], // Format YYYY-MM-DD
            credited_hours: parseFloat(insertResult.rows[0].credited_hours) || 0 // Als Zahl
        };
        res.status(201).json(createdAbsence); // Status 201 Created

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Bei Fehler zurückrollen
        console.error(`${logPrefix} ERROR during transaction. Rolled back. Error: ${err.message}`, err.stack);
        // Spezifische Fehlerbehandlung
        if (err.code === '23505') { // UNIQUE constraint violation (employee_id, date)
            const fd = new Date(date+'T00:00:00Z').toLocaleDateString('de-DE',{timeZone:'UTC'});
            res.status(409).json({ message: `Für diesen Mitarbeiter existiert bereits ein Abwesenheitseintrag am ${fd}.` }); // Conflict
        } else if (err.code === '23503') { // Foreign Key violation (employee_id existiert nicht)
            res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden (FK Fehler).`}); // Not Found
        } else {
            res.status(500).json({ message: 'Serverfehler beim Hinzufügen der Abwesenheit.' });
        }
    } finally {
        if (client) client.release(); // Verbindung freigeben
    }
});

// DELETE: Abwesenheit löschen
app.delete('/admin/absences/:id', isAdmin, async (req, res) => {
    // +++ LOGGING START +++
    const logPrefix = `[ROUTE:/admin/absences DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    // +++ LOGGING ENDE +++
    const { id } = req.params;
    const absenceId = parseInt(id);

    // Validierung
    if (isNaN(absenceId)) {
        console.error(`${logPrefix} ERROR - Invalid ID.`);
        return res.status(400).send('Ungültige Abwesenheits-ID.');
    }

    try {
        console.log(`${logPrefix} Deleting absence from DB...`);
        const result = await db.query('DELETE FROM absences WHERE id = $1', [absenceId]); // Lösche nach ID

        if (result.rowCount > 0) {
            console.log(`${logPrefix} Delete successful.`);
            res.status(200).send('Abwesenheitseintrag erfolgreich gelöscht.');
        } else {
            // Kein Eintrag mit dieser ID gefunden
            console.warn(`${logPrefix} Absence not found.`);
            res.status(404).send(`Abwesenheitseintrag mit ID ${absenceId} nicht gefunden.`);
        }
    } catch (err) {
        console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack);
        res.status(500).send('Serverfehler beim Löschen der Abwesenheit.');
    }
});


// POST: Feiertage automatisch generieren für alle Mitarbeiter für ein Jahr
app.post('/admin/generate-holidays', isAdmin, async (req, res) => {
    // +++ LOGGING START +++
    const logPrefix = `[ROUTE:/admin/generate-holidays POST] Year: ${req.body?.year}, Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Request received.`);
    // +++ LOGGING ENDE +++
    const { year } = req.body;

    // Validierung Jahr
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - 5; // Erlaube Generierung für die letzten 5 Jahre
    const maxYear = currentYear + 5; // Und die nächsten 5 Jahre
    const targetYear = parseInt(year);
    if (!year || isNaN(targetYear) || targetYear < minYear || targetYear > maxYear) {
        console.error(`${logPrefix} ERROR - Invalid year.`);
        return res.status(400).json({ message: `Ungültiges oder fehlendes Jahr. Bitte ein Jahr zwischen ${minYear} und ${maxYear} angeben.` });
    }

    console.log(`${logPrefix} Starting holiday generation for NRW, year ${targetYear}...`);
    let client; // Für Transaktion
    let generatedCount = 0; // Zähler für neu erstellte Einträge
    let skippedCount = 0; // Zähler für übersprungene Einträge (weil schon vorhanden)
    let processedEmployees = 0; // Zähler für Mitarbeiter

    try {
        client = await db.connect();
        await client.query('BEGIN'); // Transaktion starten
        console.log(`${logPrefix} Transaction started.`);

        // Alle Mitarbeiter holen
        console.log(`${logPrefix} Fetching employees...`);
        const empResult = await client.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name');
        const employees = empResult.rows;
        processedEmployees = employees.length;
        if (processedEmployees === 0) {
            await client.query('ROLLBACK');
            console.warn(`${logPrefix} No employees found. Aborting generation.`);
            return res.status(404).json({ message: "Keine Mitarbeiter gefunden, für die Feiertage generiert werden könnten." });
        }
        console.log(`${logPrefix} -> ${processedEmployees} employees found.`);

        // Gesetzliche Feiertage für das Jahr holen (NRW)
        console.log(`${logPrefix} Fetching public holidays for ${targetYear}...`);
        const holidaysOfYear = hd.getHolidays(targetYear);
        const publicHolidays = holidaysOfYear.filter(h => h.type === 'public'); // Nur gesetzliche
        console.log(`${logPrefix} -> ${publicHolidays.length} public holidays found.`);

        // Query zum Einfügen, mit ON CONFLICT DO NOTHING, um bestehende Einträge nicht zu überschreiben
        const insertQuery = `
            INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment)
            VALUES ($1, $2, 'PUBLIC_HOLIDAY', $3, $4)
            ON CONFLICT (employee_id, date) DO NOTHING;
        `; // Verhindert Doppeleinträge pro Mitarbeiter pro Tag

        // Durch alle gesetzlichen Feiertage iterieren
        for (const holiday of publicHolidays) {
            const holidayDateString = holiday.date.split(' ')[0]; // Format YYYY-MM-DD
            const holidayDate = new Date(holidayDateString + 'T00:00:00Z');
            const dayOfWeek = holidayDate.getUTCDay(); // 0=So, 6=Sa

            // Wochenenden überspringen
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                // console.log(`${logPrefix} Skipping weekend holiday: ${holiday.name} (${holidayDateString})`);
                continue;
            }

            // Durch alle Mitarbeiter iterieren
            for (const employee of employees) {
                // Soll-Stunden für diesen Mitarbeiter an diesem Wochentag berechnen
                const expectedHours = getExpectedHours(employee, holidayDateString);

                // Nur eintragen, wenn Mitarbeiter an diesem Tag Soll-Stunden > 0 hat
                if (expectedHours > 0) {
                    const result = await client.query(insertQuery, [
                        employee.id,
                        holidayDateString,
                        expectedHours,
                        holiday.name // Kommentar ist der Name des Feiertags
                    ]);
                    // Zählen, ob ein Eintrag erstellt wurde (rowCount > 0) oder übersprungen (rowCount = 0)
                    if (result.rowCount > 0) {
                        generatedCount++;
                    } else {
                        skippedCount++;
                    }
                }
            }
        }

        await client.query('COMMIT'); // Transaktion abschließen
        console.log(`${logPrefix} Transaction committed. Generated: ${generatedCount}, Skipped: ${skippedCount}.`);
        res.status(200).json({
            message: `Feiertage für ${targetYear} erfolgreich generiert/geprüft.`,
            generated: generatedCount,
            skipped: skippedCount,
            employees: processedEmployees
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Bei Fehler zurückrollen!
        console.error(`${logPrefix} !!! CRITICAL ERROR during holiday generation. Rolled back. Error: ${err.message}`, err.stack);
        res.status(500).json({ message: `Serverfehler bei der Feiertagsgenerierung: ${err.message}` });
    } finally {
        if (client) client.release(); // Verbindung freigeben
    }
});

// ****** NEUER ENDPUNKT HIER EINGEFÜGT ******
// NEU: Endpunkt zum Löschen ALLER 'PUBLIC_HOLIDAY' Abwesenheitseinträge
app.delete('/admin/delete-public-holidays', isAdmin, async (req, res) => {
    // +++ LOGGING START +++
    const logPrefix = `[ROUTE:/admin/delete-public-holidays DELETE] Session: ${req.sessionID} -`;
    console.warn(`${logPrefix} !!! DELETE ALL PUBLIC HOLIDAY ENTRIES REQUEST RECEIVED !!!`);
    // +++ LOGGING ENDE +++

    try {
        console.log(`${logPrefix} Deleting all entries with absence_type = 'PUBLIC_HOLIDAY' from DB...`);
        const result = await db.query(`DELETE FROM absences WHERE absence_type = 'PUBLIC_HOLIDAY'`); // <- Der eigentliche Löschbefehl

        console.warn(`${logPrefix} Delete successful. ${result.rowCount} 'PUBLIC_HOLIDAY' entries deleted.`);
        res.status(200).json({
            message: `Erfolgreich ${result.rowCount} Abwesenheitseinträge vom Typ 'Feiertag' gelöscht.`
        });

    } catch (err) {
        console.error(`${logPrefix} !!! CRITICAL ERROR during public holiday delete. Error: ${err.message}`, err.stack);
        res.status(500).json({
             message: `Serverfehler beim Löschen der Feiertagseinträge: ${err.message}`
        });
    }
});
// ****** ENDE NEUER ENDPUNKT ******
// server.js Fortsetzung - PDF Router & Server Start

// --- PDF Router ---
try {
    // Übergibt die initialisierte DB-Instanz an den PDF-Router
    app.use('/api/pdf', monthlyPdfRouter(db));
    console.log("PDF-Router unter /api/pdf eingebunden.");
} catch(routerError) {
    // Fehler beim Laden oder Initialisieren des Routers abfangen
    console.error("!!! Kritischer Fehler beim Einbinden des PDF-Routers:", routerError);
    // Optional: Serverstart verhindern oder Fehlerseite anzeigen
}


// --- Server Start ---
app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (Passwort fehlt!)'}`);
  // Versuche, DB-Infos anzuzeigen
  try {
      if(db && typeof db.options === 'object') {
          console.log(` Datenbank verbunden (Pool erstellt): Host=${process.env.PGHOST || db.options.host || '??'}, Port=${process.env.PGPORT || db.options.port || '??'}, DB=${process.env.PGDATABASE || db.options.database || '??'}`);
      } else if (db) {
          console.warn("!!! DB Pool Objekt 'db' existiert, aber Status unklar.");
      } else {
          console.error("!!! KRITISCH: DB Pool ('db') konnte nicht initialisiert werden!");
      }
  } catch (e) { console.error("Fehler beim Loggen der DB-Details:", e); }
  console.log(` Feiertagsmodul: DE / NW`);
  console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(` Frontend aus: '${path.join(__dirname, 'public')}'`);
  console.log(` Trust Proxy Setting: ${app.get('trust proxy')}`); // Logge trust proxy setting
  // Versuche, Session-Cookie-Einstellungen anzuzeigen
  try {
    const sessionOptions = app.get('session options'); // Versuch, Optionen zu holen (funktioniert evtl. nicht direkt)
    console.log(` Session Cookie Settings: secure=${process.env.NODE_ENV === 'production'}, sameSite='${sessionOptions?.cookie?.sameSite || session.options?.cookie?.sameSite || 'lax (default?)'}'`);
  } catch(e) { console.warn("Konnte Session Cookie Settings nicht detailliert loggen.")}
  console.log(`=======================================================`);
});
