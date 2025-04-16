// server.js - KORRIGIERTE VERSION

// *** KORREKTUR START ***
// 1. Notwendige Bibliotheken importieren
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const dotenv = require('dotenv');
const Holidays = require('date-holidays'); // Behalten für Feiertagslogik
const { Pool } = require('pg'); // NEU: PostgreSQL-Bibliothek importieren

dotenv.config(); // Umgebungsvariablen laden (z.B. für DB-URL und Admin-Passwort)

// NEU: Datenbankverbindung herstellen
// Nutzt die DATABASE_URL aus den Umgebungsvariablen (von Railway oder .env)
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Wichtig für Railway/Heroku - ggf. anpassen, falls SSL-Fehler auftreten
  // ssl: {
  //   rejectUnauthorized: false
  // }
});

// Datenbankverbindung testen (optional aber empfohlen)
db.connect((err, client, release) => {
  if (err) {
    console.error('!!! Kritischer Fehler beim Verbinden mit der Datenbank:', err.stack);
    process.exit(1); // Beenden, wenn DB nicht erreichbar
  } else {
    console.log('>>> Datenbank erfolgreich verbunden.');
    release(); // Verbindung sofort wieder freigeben
  }
});


// 2. Express App initialisieren
const app = express();
const port = process.env.PORT || 3000;

// 3. Globale Variablen und Hilfsfunktionen
const hd = new Holidays('DE', 'NW'); // Feiertagsinstanz für NRW behalten

// Importiere Berechnungs-Utils und PDF-Router
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils');
const monthlyPdfRouter = require('./routes/monthlyPdfEndpoint'); // Pfad prüfen! './routes/' oder './' ? Annahme: './routes/'

// Hilfsfunktion zum Berechnen von Arbeitsstunden (aus alter timeUtils.js übernommen)
function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  // Einfache Differenz
  let diffInMin = endMinutes - startMinutes;
  // Korrektur für Arbeit über Mitternacht (vereinfacht: Annahme < 24h)
  if (diffInMin < 0) {
      diffInMin += 24 * 60; // 24 Stunden addieren
      console.log(`Arbeitszeit über Mitternacht erkannt (${startTime} - ${endTime}). Dauer berechnet als ${diffInMin / 60}h.`);
  }
  return diffInMin / 60;
}

// Hilfsfunktion für CSV Konvertierung (aus alter timeUtils.js übernommen)
async function convertToCSV(database, data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  // Spalten erweitert für Soll/Ist/Diff
  const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std", "Differenz", "Bemerkung"];
  csvRows.push(headers.join(','));

  // Hole alle Mitarbeiterdaten für die Soll-Stunden-Berechnung einmalig
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
        dateForCalc = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD für getExpectedHours
        const year = dateObj.getUTCFullYear();
        const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getUTCDate()).padStart(2, '0');
        dateFormatted = `${day}.${month}.${year}`;
      } catch (e) {
          dateFormatted = String(row.date);
          console.warn("CSV Datumskonvertierung fehlgeschlagen für:", row.date);
      }
    }
    const startTimeFormatted = row.startTime || ""; // Kommt als HH:MI
    const endTimeFormatted = row.endTime || "";     // Kommt als HH:MI
    const istHours = parseFloat(row.hours) || 0;

    let expectedHours = 0;
    const employeeData = employeeMap.get(String(row.name).toLowerCase());
    if(employeeData && dateForCalc && typeof getExpectedHours === 'function') {
        try {
            // Prüfe auf Abwesenheit an diesem Tag
            const absenceCheck = await database.query('SELECT 1 FROM absences WHERE employee_id = $1 AND date = $2', [employeeData.id, dateForCalc]);
            if (absenceCheck.rows.length === 0) { // Nur Soll berechnen, wenn keine Abwesenheit
                expectedHours = getExpectedHours(employeeData, dateForCalc);
            }
            // An Abwesenheitstagen ist Soll = 0 für die Differenz in dieser Tabelle
        } catch (e) {
            console.error(`Fehler bei Soll-Stunden-Berechnung für CSV (MA: ${row.name}, Datum: ${dateForCalc}):`, e);
        }
    }

    const diffHours = istHours - expectedHours;
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`; // Korrektes Escaping für CSV

    const values = [
      row.id,
      row.name,
      dateFormatted,
      startTimeFormatted,
      endTimeFormatted,
      istHours.toFixed(2),
      expectedHours.toFixed(2),
      diffHours.toFixed(2),
      commentFormatted
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}
// *** KORREKTUR ENDE (Teil 1) ***
// server.js - KORRIGIERTE VERSION - Teil 2

// 4. Middleware konfigurieren
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*', // Konfigurierbare CORS-Herkunft
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session Middleware (NACH DB Initialisierung)
app.use(session({
    store: new pgSession({
        pool: db,                // Übergabe des initialisierten DB-Pools
        tableName: 'user_sessions' // Name der Session-Tabelle in der DB
    }),
    secret: process.env.SESSION_SECRET || 'fallback-secret-key', // Starkes Secret in .env speichern!
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Nur HTTPS im Prod-Modus
        maxAge: 1000 * 60 * 60 * 24 // 24 Stunden Gültigkeit
        // httpOnly: true, // Empfohlen, verhindert Zugriff via JS im Browser
        // sameSite: 'lax' // Empfohlen, Schutz gegen CSRF
    }
}));

// Statische Dateien ausliefern (für Frontend HTML/CSS/JS)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    console.warn(`Zugriffsversuch auf Admin-Route ohne Admin-Session: ${req.originalUrl} von IP ${req.ip}`);
    res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
  }
}
// server.js - KORRIGIERTE VERSION - Teil 3

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
        -- Zukünftig evtl.: bundesland VARCHAR(2) DEFAULT 'NW'
      );
    `);
    console.log("Tabelle 'employees' geprüft/erstellt.");

    // Tabelle für erfasste Arbeitszeiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL, -- Referenziert nicht direkt, um Löschung von MA zu ermöglichen ohne Datenverlust hier
        date DATE NOT NULL,
        starttime TIME,
        endtime TIME,
        hours DOUBLE PRECISION,
        comment TEXT
      );
    `);
    // Index zur schnelleren Suche nach Name und Datum
    await db.query(`CREATE INDEX IF NOT EXISTS idx_work_hours_name_date ON work_hours (LOWER(name), date);`);
    console.log("Tabelle 'work_hours' und Index geprüft/erstellt.");

    // Tabelle für Monatsbilanzen
    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- Löscht Bilanzen, wenn MA gelöscht wird
        year_month DATE NOT NULL, -- Speichert den ersten Tag des Monats
        difference DOUBLE PRECISION,
        carry_over DOUBLE PRECISION,
        UNIQUE (employee_id, year_month)
      );
    `);
     // Index zur schnelleren Suche nach Mitarbeiter und Monat
    await db.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    console.log("Tabelle 'monthly_balance' und Index geprüft/erstellt.");

    // Tabelle für Abwesenheiten
    await db.query(`
      CREATE TABLE IF NOT EXISTS absences (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- Löscht Abwesenheiten, wenn MA gelöscht wird
        date DATE NOT NULL,
        absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')), -- Typ einschränken
        credited_hours DOUBLE PRECISION NOT NULL, -- Gutgeschriebene Stunden
        comment TEXT,
        UNIQUE (employee_id, date) -- Ein Eintrag pro Mitarbeiter pro Tag
      );
    `);
    // Index zur schnelleren Suche
    await db.query(`CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);`);
    console.log("Tabelle 'absences' und Index geprüft/erstellt.");

    // NEU: Tabelle für Sessions (automatisch von connect-pg-simple verwaltet)
    // Überprüfen, ob die Tabelle existiert, da sie von connect-pg-simple verwaltet wird.
    const sessionTableCheck = await db.query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'user_sessions'
        );
    `);
    if (!sessionTableCheck.rows[0].exists) {
        console.log("Session-Tabelle 'user_sessions' wird von connect-pg-simple erstellt...");
        // Normalerweise erstellt connect-pg-simple die Tabelle selbst,
        // aber man könnte hier auch explizit CREATE TABLE ausführen, falls nötig.
    } else {
        console.log("Session-Tabelle 'user_sessions' existiert.");
    }


  } catch (err) {
    // WICHTIG: Hier wird der Fehler jetzt korrekt abgefangen, falls setupTables fehlschlägt
    console.error("!!! Kritischer Datenbank Setup Fehler:", err);
    // Beende den Prozess, wenn die Tabellen nicht eingerichtet werden können
    process.exit(1);
  }
};

// *** KORREKTUR START ***
// 6. Datenbank-Setup ausführen (NACH db definition, VOR Routen)
// Wir rufen setupTables auf und nutzen .then/.catch, da es eine async Funktion ist
setupTables()
  .then(() => {
    console.log('>>> Datenbank Setup erfolgreich abgeschlossen.');
    // Erst HIER den Server starten oder Routen definieren, die DB brauchen.
    // Die Routendefinitionen können aber auch vorher stehen, solange der Server erst
    // nach erfolgreichem Setup auf Anfragen lauscht.
  })
  .catch((err) => {
    // Fehler wurde schon in setupTables geloggt und Prozess beendet,
    // aber sicherheitshalber hier nochmal loggen.
    console.error('!!! FEHLER beim Ausführen von setupTables:', err);
    process.exit(1); // Prozess sicherheitshalber beenden
  });
// *** KORREKTUR ENDE (Teil 3) ***
// server.js - KORRIGIERTE VERSION - Teil 4

// ==========================================
// Öffentliche Endpunkte (kein Login nötig)
// ==========================================

// Health Check Endpoint
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Liefert Liste aller Mitarbeiter (ID und Name)
app.get('/employees', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("DB Fehler GET /employees:", err);
    res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Prüft den letzten Eintrag eines Mitarbeiters, um den nächsten Buchungsstatus zu bestimmen
app.get('/next-booking-details', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ message: 'Name ist erforderlich.' });

  try {
    // Suche den letzten Eintrag für den Namen, sortiert nach Datum und Startzeit absteigend.
    // NULLS LAST bei starttime, falls jemand nur Datum einträgt (sollte nicht passieren).
    const query = `
      SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
      FROM work_hours
      WHERE LOWER(name) = LOWER($1)
      ORDER BY date DESC, starttime DESC NULLS LAST
      LIMIT 1;
    `;
    const result = await db.query(query, [name.toLowerCase()]);

    let nextBooking = 'arbeitsbeginn'; // Standard ist Start
    let entryId = null;
    let startDate = null;
    let startTime = null;

    if (result.rows.length > 0) {
      const lastEntry = result.rows[0];
      // Wenn eine Startzeit existiert, aber keine Endzeit, ist der nächste Schritt 'Arbeitsende'
      if (lastEntry.starttime_formatted && !lastEntry.endtime) {
        nextBooking = 'arbeitsende';
        entryId = lastEntry.id;
        // Datum im Format YYYY-MM-DD zurückgeben
        startDate = lastEntry.date instanceof Date ? lastEntry.date.toISOString().split('T')[0] : lastEntry.date;
        startTime = lastEntry.starttime_formatted;
      }
    }
    // Sende den Status und ggf. Details des offenen Eintrags zurück
    res.json({ nextBooking, id: entryId, startDate, startTime });
  } catch (err) {
    console.error("Fehler /next-booking-details:", err);
    res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
  }
});

// Bucht den Arbeitsbeginn
app.post('/log-start', async (req, res) => {
    const { name, date, startTime } = req.body;
    if (!name || !date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten (Name, Datum YYYY-MM-DD, Startzeit HH:MM).' });
    }

    try {
        // 1. Prüfen, ob Mitarbeiter existiert und korrekten Namen holen
        const empCheck = await db.query('SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1)', [name.toLowerCase()]);
        if (empCheck.rows.length === 0) {
            return res.status(404).json({ message: `Mitarbeiter '${name}' nicht gefunden.` });
        }
        const dbEmployeeName = empCheck.rows[0].name; // Korrekten Namen aus DB verwenden

        // 2. Prüfen, ob bereits ein OFFENER Eintrag für diesen Tag existiert
        const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
        const checkOpenResult = await db.query(checkOpenQuery, [dbEmployeeName.toLowerCase(), date]);
        if (checkOpenResult.rows.length > 0) {
            return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Arbeitsbeginn.` });
        }

        // 3. Prüfen, ob bereits ein ABGESCHLOSSENER Eintrag für diesen Tag existiert (optional, je nach Anforderung)
        // Wenn mehrere Buchungen pro Tag erlaubt sein sollen, diese Prüfung entfernen.
        const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
        const checkCompleteResult = await db.query(checkCompleteQuery, [dbEmployeeName.toLowerCase(), date]);
        if (checkCompleteResult.rows.length > 0) {
             // Statt Fehler: Hinweis geben oder weitere Buchung erlauben? Hier aktuell Fehler.
            // return res.status(409).json({ message: `An diesem Tag wurde bereits eine vollständige Arbeitszeit erfasst. Mehrfachbuchungen sind aktuell nicht vorgesehen.` });
             console.warn(`Warnung: Mitarbeiter ${dbEmployeeName} bucht erneut Start am ${date}, obwohl bereits ein abgeschlossener Eintrag existiert.`);
        }


        // 4. Neuen Eintrag erstellen
        const insertQuery = `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`;
        const insertResult = await db.query(insertQuery, [dbEmployeeName, date, startTime]);
        const newEntryId = insertResult.rows[0].id;

        console.log(`Start gebucht: ${dbEmployeeName}, ${date}, ${startTime} (ID: ${newEntryId})`);
        res.status(201).json({ id: newEntryId }); // ID des neuen Eintrags zurückgeben

    } catch (err) {
        console.error("Fehler /log-start:", err);
        res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' });
    }
});

// Bucht das Arbeitsende und berechnet die Stunden
app.put('/log-end/:id', async (req, res) => {
  const { id } = req.params;
  const { endTime, comment } = req.body; // Kommentar ist optional

  if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit HH:MM).' });
  }
  const entryId = parseInt(id);

  try {
    // 1. Eintrag finden und prüfen, ob er offen ist
    const entryResult = await db.query(
      `SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
       FROM work_hours WHERE id = $1`,
      [entryId]
    );

    if (entryResult.rows.length === 0) {
      return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
    }
    const entry = entryResult.rows[0];

    if (entry.endtime) {
      return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` });
    }
    if (!entry.starttime_formatted) {
      // Sollte nicht passieren, wenn /log-start korrekt funktioniert
      return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden. Kann Ende nicht buchen.` });
    }

    // 2. Arbeitsstunden berechnen
    const netHours = calculateWorkHours(entry.starttime_formatted, endTime);
    if (netHours < 0) {
         console.warn(`Negative Arbeitszeit berechnet für ID ${entryId} (${entry.starttime_formatted} - ${endTime}). Wird als 0 gespeichert.`);
         // Optional: Fehler zurückgeben oder auf 0 setzen? Hier wird aktualisiert, aber Stunden könnten falsch sein.
         // return res.status(400).json({ message: `Fehler: Endzeit (${endTime}) liegt vor Startzeit (${entry.starttime_formatted}).` });
    }


    // 3. Eintrag aktualisieren
    const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`;
    await db.query(updateQuery, [endTime, comment || null, netHours >= 0 ? netHours : 0, entryId]); // Bei negativer Zeit 0 speichern

    console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Stunden: ${netHours.toFixed(2)})`);
    res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) });

  } catch (err) {
    console.error(`Fehler /log-end/${entryId}:`, err);
    res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' });
  }
});

// Liefert Zusammenfassung der Stunden für einen Tag und den laufenden Monat
app.get('/summary-hours', async (req, res) => {
  const { name, date } = req.query;
  if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Name und Datum (YYYY-MM-DD) erforderlich.' });
  }

  try {
    // Stunden für den spezifischen Tag
    const dailyResult = await db.query(
        `SELECT SUM(hours) AS total_daily_hours
         FROM work_hours
         WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL`,
         // WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL AND endtime IS NOT NULL`, // Nur abgeschlossene? Oder alle? Aktuell alle.
        [name.toLowerCase(), date]
    );
    const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0;

    // Stunden für den Monat bis einschließlich des gegebenen Datums
    const yearMonthDay = date.split('-');
    const year = parseInt(yearMonthDay[0]);
    const month = parseInt(yearMonthDay[1]);
    // Erster Tag des Monats (UTC)
    const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
    // Letzter Tag für die Query ist der angefragte Tag
    const lastDayForQuery = date;

    const monthlyResult = await db.query(
        `SELECT SUM(hours) AS total_monthly_hours
         FROM work_hours
         WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`,
        [name.toLowerCase(), firstDayOfMonth, lastDayForQuery]
    );
    const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours
                       ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0;

    res.json({ dailyHours, monthlyHours });

  } catch (err) {
    console.error(`Fehler /summary-hours (${name}, ${date}):`, err);
    res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' });
  }
});
// server.js - KORRIGIERTE VERSION - Teil 5

// ==========================================
// Admin Endpunkte (Login erforderlich via isAdmin Middleware)
// ==========================================

// Admin-Login
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.error("!!! ADMIN_PASSWORD ist nicht in den Umgebungsvariablen gesetzt! Login nicht möglich.");
    return res.status(500).send("Serverkonfigurationsfehler.");
  }
  if (!password) {
    return res.status(400).send("Passwort fehlt.");
  }

  if (password === adminPassword) {
    // Passwort korrekt, Session neu generieren und Admin-Status setzen
    req.session.regenerate((errReg) => {
      if (errReg) {
        console.error("Fehler beim Regenerieren der Session:", errReg);
        return res.status(500).send("Session Fehler.");
      }
      // Setze Admin-Status in der neuen Session
      req.session.isAdmin = true;
      // Speichere die Session explizit
      req.session.save((errSave) => {
        if (errSave) {
          console.error("Fehler beim Speichern der Session:", errSave);
          return res.status(500).send("Session Speicherfehler.");
        }
        console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`);
        res.status(200).send("Admin erfolgreich angemeldet.");
      });
    });
  } else {
    // Passwort falsch
    console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`);
    res.status(401).send("Ungültiges Passwort.");
  }
});

// Admin-Logout
app.post("/admin-logout", isAdmin, (req, res) => { // isAdmin prüft, ob überhaupt eingeloggt
  if (req.session) {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
      if (err) {
        console.error("Fehler beim Zerstören der Session:", err);
        return res.status(500).send("Fehler beim Logout.");
      }
      // Cookie im Browser löschen
      res.clearCookie('connect.sid'); // Name des Session-Cookies (Standard)
      console.log(`Admin abgemeldet (Session ID: ${sessionId}).`);
      return res.status(200).send("Erfolgreich abgemeldet.");
    });
  } else {
    // Sollte nicht passieren, wenn isAdmin Middleware funktioniert
    return res.status(200).send("Keine aktive Session zum Abmelden gefunden.");
  }
});


// Arbeitszeiten für Admin anzeigen (mit Filterung nach Mitarbeiter und/oder Monat)
app.get('/admin-work-hours', isAdmin, async (req, res) => {
    const { employeeId, year, month } = req.query;

    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment,
                       TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
                       TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
                     FROM work_hours w
                     JOIN employees e ON LOWER(w.name) = LOWER(e.name)`; // Join über Mitarbeiternamen (case-insensitive)
    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    // Filter nach Mitarbeiter-ID
    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId);
        if (isNaN(empIdInt)) {
            return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});
        }
        // Wichtig: Filtern über die ID aus der 'employees' Tabelle
        whereClauses.push(`e.id = $${paramIndex++}`);
        queryParams.push(empIdInt);
    }

    // Filter nach Jahr und Monat
    if (year && month) {
        const parsedYear = parseInt(year);
        const parsedMonth = parseInt(month);
        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) {
             return res.status(400).json({ message: 'Ungültiges Jahr oder Monat angegeben (YYYY, MM).' });
        }
        try {
            // Datumsbereich für den Monat (UTC)
            const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); // Erster Tag des Monats
            const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); // Erster Tag des Folgemonats
             if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datumsobjekt erstellt');

            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];

            whereClauses.push(`w.date >= $${paramIndex++}`);
            queryParams.push(startDateStr);
            whereClauses.push(`w.date < $${paramIndex++}`); // Exklusiv endDate
            queryParams.push(endDateStr);
        } catch(dateError) {
            console.error("Fehler beim Erstellen des Datumsfilters:", dateError);
            return res.status(400).json({ message: `Fehler bei der Verarbeitung des Datums ${year}-${month}.` });
        }
    }

    let finalQuery = baseQuery;
    if (whereClauses.length > 0) {
        finalQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    // Sortierung: Neueste zuerst, dann nach Name, dann nach Startzeit
    finalQuery += ` ORDER BY w.date DESC, e.name ASC, w.starttime ASC NULLS LAST;`;

    try {
        const result = await db.query(finalQuery, queryParams);
        // Konvertiere Datum vor dem Senden in YYYY-MM-DD String falls nötig
        const formattedRows = result.rows.map(row => ({
            ...row,
            date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date
        }));
        res.json(formattedRows);
    } catch (err) {
        console.error("DB Fehler GET /admin-work-hours (gefiltert):", err);
        res.status(500).send('Serverfehler beim Laden der gefilterten Arbeitszeiten.');
    }
});


// CSV-Download für Admin (berücksichtigt Filter)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  // HINWEIS: Diese Version übernimmt die Filter aus /admin-work-hours
  // Es ist performanter, die Daten direkt gefiltert abzufragen als alle zu holen und dann zu filtern.
    const { employeeId, year, month } = req.query; // Dieselben Filter wie oben

    let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment,
                       TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
                       TO_CHAR(w.endtime, 'HH24:MI') AS "endTime"
                     FROM work_hours w
                     JOIN employees e ON LOWER(w.name) = LOWER(e.name)`;
    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;
    let filterDesc = "alle"; // Für Dateinamen

    if (employeeId && employeeId !== 'all' && employeeId !== '') {
        const empIdInt = parseInt(employeeId);
        if (isNaN(empIdInt)) return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'});
        whereClauses.push(`e.id = $${paramIndex++}`);
        queryParams.push(empIdInt);
         try { // Namen für Dateinamen holen
            const nameRes = await db.query('SELECT name FROM employees WHERE id = $1', [empIdInt]);
            if(nameRes.rows.length > 0) filterDesc = nameRes.rows[0].name.replace(/[^a-z0-9]/gi, '_');
         } catch {}
    } else {
        filterDesc = "alle_MA";
    }

    if (year && month) {
        const parsedYear = parseInt(year); const parsedMonth = parseInt(month);
        if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) {
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
            console.error("CSV Datumsfehler Filter:", dateError);
            return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` });
        }
    } else {
        filterDesc += "_alle_Zeiten";
    }

    let finalQuery = baseQuery;
    if (whereClauses.length > 0) { finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; }
    // Sortierung für CSV: Älteste zuerst
    finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS LAST;`;

  try {
    const result = await db.query(finalQuery, queryParams);
    const csvData = await convertToCSV(db, result.rows); // Nutzt die verbesserte Funktion mit Soll-Stunden

    const filename = `arbeitszeiten_${filterDesc}_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM für Excel-Kompatibilität mit Umlauten
    res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')]));
  } catch (err) {
    console.error("DB Fehler GET /admin-download-csv:", err);
    res.status(500).send('Serverfehler beim Erstellen des CSV-Exports.');
  }
});


// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  const { id, date, startTime, endTime, comment } = req.body;
  const entryId = parseInt(id);

  // Validierung
  if (isNaN(entryId)) {
      return res.status(400).json({ message: 'Ungültige oder fehlende Eintrag-ID.' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
       return res.status(400).json({ message: 'Ungültiges oder fehlendes Datum (Format YYYY-MM-DD).' });
  }
   if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) {
       return res.status(400).json({ message: 'Ungültige oder fehlende Startzeit (Format HH:MM).' });
  }
   if (!endTime || !/^\d{2}:\d{2}$/.test(endTime)) {
       return res.status(400).json({ message: 'Ungültige oder fehlende Endzeit (Format HH:MM).' });
  }

  // Stunden neu berechnen
  const netHours = calculateWorkHours(startTime, endTime);
   if (netHours < 0) {
       console.warn(`Admin Update ID ${entryId}: Negative Arbeitszeit (${startTime} - ${endTime}). Speichere 0 Stunden.`);
        // Optional Fehler werfen oder mit 0 speichern? Aktuell 0.
        // return res.status(400).json({ message: `Fehler: Endzeit (${endTime}) liegt vor Startzeit (${startTime}).` });
   }


  try {
      // Prüfen ob Eintrag existiert (optional, UPDATE wirft keinen Fehler wenn nicht gefunden)
      const checkResult = await db.query('SELECT 1 FROM work_hours WHERE id = $1', [entryId]);
      if (checkResult.rows.length === 0) {
          return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
      }

      // Update durchführen
      const query = `UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6;`;
      const result = await db.query(query, [date, startTime, endTime, netHours >= 0 ? netHours : 0, comment || null, entryId]);

      if (result.rowCount > 0) {
          console.log(`Admin Update erfolgreich für work_hours ID ${entryId}`);
          res.status(200).send('Eintrag erfolgreich aktualisiert.');
      } else {
           // Sollte wegen der Prüfung oben nicht passieren
          res.status(404).send(`Eintrag ID ${entryId} konnte nicht aktualisiert werden (evtl. existiert er nicht).`);
      }
  } catch (err) {
      console.error(`DB Fehler PUT /api/admin/update-hours (ID: ${entryId}):`, err);
      res.status(500).send('Serverfehler beim Aktualisieren des Eintrags.');
  }
});


// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  const entryId = parseInt(id);

  if (isNaN(entryId)) {
      return res.status(400).send('Ungültige ID.');
  }

  try {
    // Lösche den Eintrag mit der gegebenen ID
    const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]);

    if (result.rowCount > 0) {
      // Mindestens eine Zeile wurde gelöscht
      console.log(`Admin Delete erfolgreich für work_hours ID ${entryId}`);
      res.status(200).send('Eintrag erfolgreich gelöscht.');
    } else {
      // Keine Zeile wurde gelöscht (ID nicht gefunden)
      res.status(404).send(`Eintrag mit ID ${entryId} nicht gefunden.`);
    }
  } catch (err) {
    console.error(`DB Fehler DELETE /api/admin/delete-hours (ID: ${entryId}):`, err);
    res.status(500).send('Serverfehler beim Löschen des Eintrags.');
  }
});


// Admin: Alle Arbeitszeiten, Bilanzen UND Abwesenheiten löschen (EXTREM GEFÄHRLICH!)
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
  console.warn("!!! ACHTUNG: Admin löscht ALLE Arbeits-, Bilanz- und Abwesenheitsdaten über /adminDeleteData !!!");

  // Zusätzliche Sicherheitsabfrage oder Mechanismus wäre hier sinnvoll (z.B. Bestätigungspasswort)
  // Aktuell wird bei Aufruf direkt gelöscht!

  let client; // Für Transaktion
  try {
      client = await db.connect();
      await client.query('BEGIN'); // Start transaction

      console.log("Lösche Monatsbilanzen...");
      const resultMB = await client.query('DELETE FROM monthly_balance');
      console.log(` -> ${resultMB.rowCount} Monatsbilanzen gelöscht.`);

      console.log("Lösche Abwesenheiten...");
      const resultAbs = await client.query('DELETE FROM absences');
      console.log(` -> ${resultAbs.rowCount} Abwesenheiten gelöscht.`);

      console.log("Lösche Arbeitszeiten...");
      const resultWH = await client.query('DELETE FROM work_hours');
      console.log(` -> ${resultWH.rowCount} Arbeitszeiten gelöscht.`);

      await client.query('COMMIT'); // Commit transaction
      console.log("!!! Alle Arbeits-, Bilanz- und Abwesenheitsdaten erfolgreich gelöscht !!!");
      res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiten, ${resultMB.rowCount} Bilanzen und ${resultAbs.rowCount} Abwesenheiten wurden unwiderruflich gelöscht.`);

  } catch (err) {
      if (client) {
          await client.query('ROLLBACK'); // Rollback transaction on error
      }
      console.error("!!! Kritischer DB Fehler bei /adminDeleteData:", err);
      res.status(500).send('Serverfehler beim Löschen aller Daten. Transaktion zurückgerollt.');
  } finally {
       if (client) {
          client.release(); // Release client connection
       }
  }
});

// --- Mitarbeiterverwaltung ---

// Admin: Liste aller Mitarbeiter holen
app.get('/admin/employees', isAdmin, async (req, res) => {
  try {
    // Wähle alle relevanten Spalten aus
    const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
      console.error("DB Fehler GET /admin/employees:", err);
      res.status(500).send('Serverfehler beim Laden der Mitarbeiterliste.');
  }
});

// Admin: Neuen Mitarbeiter hinzufügen
app.post('/admin/employees', isAdmin, async (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  const trimmedName = name ? name.trim() : '';

  // Validierung
  if (!trimmedName) {
      return res.status(400).send('Name darf nicht leer sein.');
  }
  // Stunden validieren (sollten Zahlen sein, default 0)
  const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
  if (hours.some(h => h < 0)) {
      return res.status(400).send('Stunden dürfen nicht negativ sein.');
  }

  try {
    // Füge neuen Mitarbeiter ein und gib die eingefügten Daten zurück
    const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   RETURNING *;`; // Gibt die komplette neue Zeile zurück
    const result = await db.query(query, [trimmedName, ...hours]);

    console.log(`Admin Add Mitarbeiter erfolgreich: ${trimmedName} (ID: ${result.rows[0].id})`);
    res.status(201).json(result.rows[0]); // Sende die neu erstellten Mitarbeiterdaten zurück

  } catch (err) {
    // Fehlerbehandlung für Unique Constraint (doppelter Name)
    if (err.code === '23505') { // PostgreSQL Unique Violation Code
      console.warn(`Versuch, existierenden Mitarbeiter hinzuzufügen: ${trimmedName}`);
      res.status(409).send(`Ein Mitarbeiter mit dem Namen '${trimmedName}' existiert bereits.`); // 409 Conflict
    } else {
      console.error("DB Fehler POST /admin/employees:", err);
      res.status(500).send('Serverfehler beim Hinzufügen des Mitarbeiters.');
    }
  }
});


// Admin: Mitarbeiterdaten aktualisieren
app.put('/admin/employees/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
    const employeeId = parseInt(id);
    const trimmedName = name ? name.trim() : '';

    // Validierung
    if (isNaN(employeeId)) {
        return res.status(400).send('Ungültige Mitarbeiter-ID.');
    }
    if (!trimmedName) {
        return res.status(400).send('Name darf nicht leer sein.');
    }
    const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0);
     if (hours.some(h => h < 0)) {
        return res.status(400).send('Stunden dürfen nicht negativ sein.');
    }


    let client; // Für Transaktion
    try {
        client = await db.connect();
        await client.query('BEGIN'); // Start transaction

        // 1. Alten Namen holen (für evtl. Update in work_hours)
        const oldNameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]); // Sperrt die Zeile
        if (oldNameResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).send(`Mitarbeiter mit ID ${employeeId} nicht gefunden.`);
        }
        const oldName = oldNameResult.rows[0].name;
        const newName = trimmedName;

        // 2. Mitarbeiterdaten aktualisieren
        const updateEmpQuery = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
        await client.query(updateEmpQuery, [newName, ...hours, employeeId]);

        // 3. Wenn sich der Name geändert hat, auch in work_hours aktualisieren
        // WICHTIG: Dies kann bei großen Tabellen langsam sein!
        if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) {
            console.log(`Name geändert von '${oldName}' zu '${newName}'. Aktualisiere work_hours...`);
            const workHoursUpdateResult = await client.query(
                `UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`,
                [newName, oldName.toLowerCase()]
            );
            console.log(` -> ${workHoursUpdateResult.rowCount} Einträge in work_hours auf neuen Namen aktualisiert.`);
            // HINWEIS: Namen in alten Bilanzen/Abwesenheiten werden NICHT aktualisiert, da diese über employee_id verknüpft sind.
        }

        await client.query('COMMIT'); // Commit transaction
        console.log(`Admin Update Mitarbeiter erfolgreich für ID ${employeeId}. Alter Name: ${oldName}, Neuer Name: ${newName}`);
        res.status(200).send('Mitarbeiterdaten erfolgreich aktualisiert.');

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Rollback on error

        if (err.code === '23505') { // Unique constraint violation (Name)
            console.warn(`Namenskonflikt beim Update für MA ID ${employeeId}: Versuchter Name '${trimmedName}' existiert bereits.`);
            res.status(409).send(`Der Name '${trimmedName}' wird bereits von einem anderen Mitarbeiter verwendet.`);
        } else {
            console.error(`DB Fehler PUT /admin/employees/${employeeId}:`, err);
            res.status(500).send('Serverfehler beim Aktualisieren der Mitarbeiterdaten.');
        }
    } finally {
        if (client) client.release(); // Release connection
    }
});


// Admin: Mitarbeiter löschen
app.delete('/admin/employees/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  const employeeId = parseInt(id);

  if (isNaN(employeeId)) {
      return res.status(400).send('Ungültige Mitarbeiter-ID.');
  }

  let client; // Für Transaktion
  try {
    client = await db.connect();
    await client.query('BEGIN'); // Start transaction

    // 1. Namen des Mitarbeiters holen (für Logs und evtl. work_hours Löschung)
    const nameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);
    if (nameResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send(`Mitarbeiter mit ID ${employeeId} nicht gefunden.`);
    }
    const employeeName = nameResult.rows[0].name;
    console.log(`Versuche Mitarbeiter ${employeeName} (ID: ${employeeId}) zu löschen...`);

    // 2. Zugehörige Daten löschen (explizit, obwohl ON DELETE CASCADE existiert, zur Klarheit)
    // Reihenfolge beachten wegen Foreign Keys, falls CASCADE nicht genutzt würde.
    // Mit ON DELETE CASCADE werden Bilanzen und Abwesenheiten automatisch gelöscht.

    // 2a. Arbeitszeiten löschen (sind nicht per FK mit ID verknüpft, sondern nur Name!)
    // Lösche alle Einträge, deren Name (case-insensitive) dem zu löschenden Mitarbeiter entspricht.
    console.log(`Lösche Arbeitszeiten für ${employeeName}...`);
    const workHoursDeleteResult = await client.query('DELETE FROM work_hours WHERE LOWER(name) = LOWER($1)', [employeeName.toLowerCase()]);
    console.log(` -> ${workHoursDeleteResult.rowCount} Arbeitszeit-Einträge gelöscht.`);

    // 2b. Mitarbeiter löschen (löst ON DELETE CASCADE für Bilanzen und Abwesenheiten aus)
    console.log(`Lösche Mitarbeiter ${employeeName} (ID: ${employeeId}) aus 'employees'...`);
    const deleteEmpResult = await client.query('DELETE FROM employees WHERE id = $1', [employeeId]);

    // 3. Prüfen, ob Mitarbeiter tatsächlich gelöscht wurde
    if (deleteEmpResult.rowCount > 0) {
      await client.query('COMMIT'); // Commit transaction
      console.log(`Admin Delete Mitarbeiter ID ${employeeId} (${employeeName}) und zugehörige Daten erfolgreich.`);
      res.status(200).send(`Mitarbeiter '${employeeName}' und alle zugehörigen Daten (Arbeitszeiten, Bilanzen, Abwesenheiten) wurden gelöscht.`);
    } else {
      // Sollte nicht passieren wegen Prüfung oben
      await client.query('ROLLBACK');
      console.warn(`Mitarbeiter ID ${employeeId} nicht gefunden während des Löschvorgangs nach initialer Prüfung.`);
      res.status(404).send(`Mitarbeiter mit ID ${employeeId} konnte nicht gelöscht werden (nicht gefunden).`);
    }

  } catch (err) {
    if (client) await client.query('ROLLBACK'); // Rollback on error

    // Falls ON DELETE CASCADE nicht funktioniert oder andere FK-Probleme auftreten
    if (err.code === '23503') { // Foreign key violation
        console.error(`FK Fehler beim Löschen von MA ID ${employeeId}:`, err);
        res.status(409).send('Fehler: Abhängige Daten konnten nicht gelöscht werden (Foreign Key Constraint).');
    } else {
        console.error(`DB Fehler DELETE /admin/employees/${employeeId}:`, err);
        res.status(500).send('Serverfehler beim Löschen des Mitarbeiters.');
    }
  } finally {
    if (client) client.release(); // Release connection
  }
});

// --- Auswertungen ---

// Admin: Monatsauswertung berechnen und zurückgeben
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
  const { name, year, month } = req.query;

  // Validierung
  if (!name || !year || !month || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4 || isNaN(parseInt(month)) || month < 1 || month > 12) {
    return res.status(400).json({ message: "Ungültige Eingabe: Name, Jahr (YYYY) und Monat (1-12) erforderlich." });
  }

  try {
    // Rufe die Berechnungsfunktion auf
    const result = await calculateMonthlyData(db, name, year, month);
    console.log(`Admin Monatsauswertung erfolgreich für: ${result.employeeName || name} (${String(month).padStart(2,'0')}/${year})`);
    res.json(result); // Sende das Ergebnis als JSON zurück

  } catch (err) {
    console.error(`Fehler /calculate-monthly-balance (Name: ${name}, ${month}/${year}):`, err);
    // Spezifische Fehlermeldung für nicht gefundenen Mitarbeiter
    if (err.message && err.message.toLowerCase().includes("nicht gefunden")) {
      res.status(404).json({ message: err.message });
    } else {
      // Allgemeiner Serverfehler
      res.status(500).json({ message: `Serverfehler bei der Monatsberechnung: ${err.message}` });
    }
  }
});


// Admin: Periodenauswertung (Quartal/Jahr) berechnen und zurückgeben
app.get('/calculate-period-balance', isAdmin, async (req, res) => {
  const { name, year, periodType, periodValue } = req.query;

  // Validierung
  if (!name || !year || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4) {
       return res.status(400).json({ message: "Ungültige Eingabe: Name und Jahr (YYYY) erforderlich." });
  }
  const periodTypeUpper = periodType ? periodType.toUpperCase() : null;
  if (!periodTypeUpper || !['QUARTER', 'YEAR'].includes(periodTypeUpper)) {
    return res.status(400).json({ message: "Ungültiger Periodentyp. Erlaubt sind 'QUARTER' oder 'YEAR'." });
  }
  let parsedPeriodValue = null;
  if (periodTypeUpper === 'QUARTER') {
      parsedPeriodValue = parseInt(periodValue);
      if (!periodValue || isNaN(parsedPeriodValue) || parsedPeriodValue < 1 || parsedPeriodValue > 4) {
        return res.status(400).json({ message: "Ungültiges Quartal (1-4) für Periodentyp 'QUARTER' erforderlich." });
      }
  }

  try {
    // Rufe die Berechnungsfunktion auf
    const result = await calculatePeriodData(db, name, year, periodTypeUpper, parsedPeriodValue);
    console.log(`Admin Periodenauswertung erfolgreich für: ${result.employeeName || name} (${year} ${result.periodIdentifier})`);
    res.json(result); // Sende das Ergebnis als JSON zurück

  } catch (err) {
    console.error(`Fehler /calculate-period-balance (Name: ${name}, ${year}, ${periodTypeUpper}, ${parsedPeriodValue}):`, err);
    if (err.message && err.message.toLowerCase().includes("nicht gefunden")) {
      res.status(404).json({ message: err.message });
    } else {
      res.status(500).json({ message: `Serverfehler bei der Periodenberechnung: ${err.message}` });
    }
  }
});


// --- Abwesenheiten ---

// GET: Abwesenheiten für einen Mitarbeiter abrufen
app.get('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId } = req.query;
    const empIdInt = parseInt(employeeId);

    if (!employeeId || isNaN(empIdInt)) {
        return res.status(400).json({ message: 'Gültige numerische employeeId als Query-Parameter erforderlich.' });
    }

    try {
        // Abfrage aller Abwesenheiten für die gegebene Mitarbeiter-ID, sortiert nach Datum absteigend
        const query = `SELECT id, date, absence_type, credited_hours, comment
                       FROM absences
                       WHERE employee_id = $1
                       ORDER BY date DESC`;
        const result = await db.query(query, [empIdInt]);

        // Formatieren des Datums in YYYY-MM-DD vor dem Senden
        const formattedResult = result.rows.map(row => ({
            ...row,
            date: (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date)
        }));
        res.json(formattedResult);

    } catch (err) {
        console.error(`Fehler GET /admin/absences für employeeId ${empIdInt}:`, err);
        res.status(500).json({ message: 'Serverfehler beim Laden der Abwesenheiten.' });
    }
});


// POST: Neue Abwesenheit hinzufügen
app.post('/admin/absences', isAdmin, async (req, res) => {
    const { employeeId, date, absenceType, comment } = req.body;

    // --- Validierung ---
    const empIdInt = parseInt(employeeId);
    if (!employeeId || isNaN(empIdInt)) {
        return res.status(400).json({ message: 'Gültige numerische employeeId erforderlich.' });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'Gültiges Datum im Format YYYY-MM-DD erforderlich.' });
    }
    if (!absenceType || !['VACATION', 'SICK', 'PUBLIC_HOLIDAY'].includes(absenceType.toUpperCase())) {
        return res.status(400).json({ message: "Ungültiger absenceType. Erlaubt: 'VACATION', 'SICK', 'PUBLIC_HOLIDAY'." });
    }
    const normalizedAbsenceType = absenceType.toUpperCase(); // Sicherstellen, dass Großbuchstaben verwendet werden

    const targetDate = new Date(date + 'T00:00:00Z'); // UTC Datum für Konsistenz
    const dayOfWeek = targetDate.getUTCDay(); // 0=So, 6=Sa

    // Verhindere Buchungen am Wochenende (optional, je nach Anforderung)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
         const formattedDate = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'});
         return res.status(400).json({ message: `Abwesenheiten können nicht am Wochenende (${formattedDate}) gebucht werden.` });
    }

    // Prüfung, ob es sich tatsächlich um einen Feiertag handelt, wenn Typ PUBLIC_HOLIDAY
    if (normalizedAbsenceType === 'PUBLIC_HOLIDAY') {
        const isHoliday = hd.isHoliday(targetDate); // Nutzt die initialisierte 'hd' Instanz
        if (!isHoliday) {
             const formattedTargetDate = targetDate.toLocaleDateString('de-DE',{timeZone:'UTC'});
             console.warn(`Admin (${req.sessionID}) versucht ${formattedTargetDate} als Feiertag für MA ${empIdInt} zu buchen, aber isHoliday()=false.`);
             return res.status(400).json({ message: `Das Datum ${formattedTargetDate} ist laut System kein gesetzlicher Feiertag in NRW.` });
        }
    }
    // --- Ende Validierung ---

    let client;
    try {
        client = await db.connect();
        await client.query('BEGIN'); // Transaktion starten

        // 1. Mitarbeiterdaten holen (für Soll-Stunden-Berechnung)
        const empResult = await client.query('SELECT * FROM employees WHERE id = $1', [empIdInt]);
        if (empResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden.` });
        }
        const employeeData = empResult.rows[0];

        // 2. Soll-Stunden für diesen Tag ermitteln (aus calculationUtils)
        const expectedHoursForDay = getExpectedHours(employeeData, date); // date ist YYYY-MM-DD

        // 3. Gutgeschriebene Stunden festlegen
        let credited_hours = expectedHoursForDay;

        // Wichtige Logik: Nur bei Urlaub/Krank prüfen, ob Soll > 0 war. Feiertage immer eintragen, wenn sie auf Mo-Fr fallen (geprüft oben).
        if (normalizedAbsenceType !== 'PUBLIC_HOLIDAY' && expectedHoursForDay <= 0) {
             const formattedDate = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'});
             await client.query('ROLLBACK');
             return res.status(400).json({ message: `Buchung nicht möglich: Mitarbeiter ${employeeData.name} hat an diesem Tag (${formattedDate}) keine Soll-Stunden.` });
        }
        // Bei Feiertagen werden die Soll-Stunden gutgeschrieben, auch wenn sie 0 wären (selten),
        // da der Tag als ganzer Tag zählt. Minimal 0 gutschreiben.
        credited_hours = Math.max(0, credited_hours);


        // 4. Abwesenheit einfügen (oder bei Konflikt Fehler werfen)
        const insertQuery = `INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment)
                             VALUES ($1, $2, $3, $4, $5)
                             RETURNING id, date, absence_type, credited_hours, comment;`;
        const insertResult = await client.query(insertQuery, [empIdInt, date, normalizedAbsenceType, credited_hours, comment || null]);

        await client.query('COMMIT'); // Transaktion abschließen

        // Aufbereitetes Ergebnis zurückgeben
        const createdAbsence = {
            ...insertResult.rows[0],
            date: insertResult.rows[0].date.toISOString().split('T')[0], // Datum als YYYY-MM-DD
            credited_hours: parseFloat(insertResult.rows[0].credited_hours) || 0
        };

        console.log(`Admin Add Absence: MA ID ${empIdInt}, Date ${date}, Type ${normalizedAbsenceType}, Hours ${credited_hours.toFixed(2)}`);
        res.status(201).json(createdAbsence);

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Rollback bei Fehlern

        if (err.code === '23505') { // Unique constraint violation (employee_id, date)
            const fd = new Date(date+'T00:00:00Z').toLocaleDateString('de-DE',{timeZone:'UTC'});
            res.status(409).json({ message: `Für diesen Mitarbeiter existiert bereits ein Abwesenheitseintrag am ${fd}.` });
        } else if (err.code === '23503') { // Foreign key violation (employee_id existiert nicht mehr?)
            res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden (Foreign Key Fehler).`});
        } else {
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
    const absenceId = parseInt(id);

    if (isNaN(absenceId)) {
        return res.status(400).send('Ungültige Abwesenheits-ID.');
    }

    try {
        // Lösche den Eintrag mit der gegebenen ID
        const result = await db.query('DELETE FROM absences WHERE id = $1', [absenceId]);

        if (result.rowCount > 0) {
            // Eintrag wurde gelöscht
            console.log(`Admin Delete Absence ID ${absenceId} erfolgreich.`);
            res.status(200).send('Abwesenheitseintrag erfolgreich gelöscht.');
        } else {
            // Eintrag nicht gefunden
            res.status(404).send(`Abwesenheitseintrag mit ID ${absenceId} nicht gefunden.`);
        }
    } catch (err) {
        console.error(`Fehler DELETE /admin/absences/${absenceId}:`, err);
        res.status(500).send('Serverfehler beim Löschen der Abwesenheit.');
    }
});


// POST: Feiertage automatisch generieren für alle Mitarbeiter für ein Jahr
app.post('/admin/generate-holidays', isAdmin, async (req, res) => {
    const { year } = req.body;
    const currentYear = new Date().getFullYear();

    // Validierung des Jahres (z.B. aktuelles Jahr +/- 5 Jahre)
    const minYear = currentYear - 5;
    const maxYear = currentYear + 5;
    const targetYear = parseInt(year);

    if (!year || isNaN(targetYear) || targetYear < minYear || targetYear > maxYear) {
        return res.status(400).json({ message: `Ungültiges oder fehlendes Jahr. Bitte ein Jahr zwischen ${minYear} und ${maxYear} angeben.` });
    }

    console.log(`Starte automatische Generierung der Feiertage für NRW im Jahr ${targetYear}...`);
    let client; // Datenbank-Client für Transaktion
    let generatedCount = 0;
    let skippedCount = 0;
    let processedEmployees = 0;

    try {
        client = await db.connect(); // Verbindung für Transaktion holen
        await client.query('BEGIN'); // Transaktion starten

        // 1. Alle Mitarbeiter holen (inkl. Soll-Stunden)
        const empResult = await client.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name');
        const employees = empResult.rows;
        processedEmployees = employees.length;

        if (processedEmployees === 0) {
             await client.query('ROLLBACK');
             console.warn(`Feiertagsgenerierung für ${targetYear} abgebrochen: Keine Mitarbeiter in der Datenbank gefunden.`);
             return res.status(404).json({ message: "Keine Mitarbeiter gefunden, für die Feiertage generiert werden könnten." });
        }
        console.log(`   - ${processedEmployees} Mitarbeiter gefunden.`);

        // 2. Gesetzliche Feiertage für NRW im Zieljahr holen
        const holidaysOfYear = hd.getHolidays(targetYear); // Nutzt die globale 'hd' Instanz
        const publicHolidays = holidaysOfYear.filter(h => h.type === 'public');
        console.log(`   - ${publicHolidays.length} gesetzliche Feiertage für ${targetYear} in NRW gefunden.`);

        // Query für das Einfügen vorbereiten (mit ON CONFLICT DO NOTHING)
        const insertQuery = `
            INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment)
            VALUES ($1, $2, 'PUBLIC_HOLIDAY', $3, $4)
            ON CONFLICT (employee_id, date) DO NOTHING;
        `; // Verhindert Duplikate für denselben Tag/Mitarbeiter

        // 3. Durch jeden gesetzlichen Feiertag iterieren
        for (const holiday of publicHolidays) {
            // Wichtig: Datumsobjekt und String korrekt behandeln
             // holiday.date ist oft "YYYY-MM-DD HH:MM:SS", wir brauchen nur "YYYY-MM-DD"
            const holidayDateString = holiday.date.split(' ')[0];
            const holidayDate = new Date(holidayDateString + 'T00:00:00Z'); // UTC für Konsistenz
            const dayOfWeek = holidayDate.getUTCDay(); // 0=So, 6=Sa

            // Überspringe Wochenenden (Sa/So)
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                // console.log(`   - Überspringe Feiertag '${holiday.name}' am ${holidayDateString} (Wochenende).`);
                continue; // Nächster Feiertag
            }

            // 4. Durch jeden Mitarbeiter iterieren
            for (const employee of employees) {
                // Ermittle die normalen Soll-Stunden des Mitarbeiters für diesen Wochentag
                const expectedHours = getExpectedHours(employee, holidayDateString); // Nutzt Funktion aus calculationUtils

                // Nur wenn der Mitarbeiter an diesem Wochentag normalerweise arbeiten würde (>0 Soll-Stunden)
                // ODER wenn der Feiertag als ganzer Tag zählt (hier implizit, da wir nur Mo-Fr betrachten)
                if (expectedHours > 0) {
                     // Gutschrift = Normale Soll-Stunden für diesen Tag
                    const credited_hours = expectedHours;
                    const holidayName = holiday.name; // Name des Feiertags

                    // Versuche, den Eintrag einzufügen
                    const result = await client.query(insertQuery, [
                        employee.id,
                        holidayDateString, // YYYY-MM-DD
                        credited_hours,
                        holidayName
                    ]);

                    if (result.rowCount > 0) {
                        generatedCount++; // Zähle erfolgreiche Einfügungen
                    } else {
                        skippedCount++; // Zähle Einträge, die übersprungen wurden (wegen ON CONFLICT)
                    }
                } else {
                     // Mitarbeiter hat an diesem Wochentag 0 Soll-Stunden -> kein Eintrag nötig
                     // skippedCount++; // Optional: Auch diese Fälle zählen? Nein, da nicht versucht einzufügen.
                }
            } // Ende Schleife Mitarbeiter
        } // Ende Schleife Feiertage

        await client.query('COMMIT'); // Transaktion erfolgreich abschließen
        console.log(`Feiertagsgenerierung für ${targetYear} abgeschlossen. ${generatedCount} Einträge erstellt, ${skippedCount} bereits vorhandene übersprungen.`);
        res.status(200).json({
            message: `Feiertage für ${targetYear} erfolgreich generiert/geprüft.`,
            generated: generatedCount,
            skipped: skippedCount, // Anzahl bereits existierender Einträge
            employees: processedEmployees
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Transaktion bei Fehler abbrechen
        console.error(`!!! Schwerer Fehler bei der Feiertagsgenerierung für Jahr ${targetYear}:`, err);
        res.status(500).json({ message: `Serverfehler bei der Feiertagsgenerierung: ${err.message}` });
    } finally {
        if (client) client.release(); // Verbindung immer freigeben
    }
});


// --- PDF Router ---
// Stelle sicher, dass die DB-Verbindung korrekt übergeben wird
// Pfad zu monthlyPdfEndpoint.js anpassen, falls er nicht in './routes/' liegt!
// Beispiel: Wenn im selben Verzeichnis: require('./monthlyPdfEndpoint')
try {
    app.use('/api/pdf', monthlyPdfRouter(db)); // Übergibt die initialisierte DB-Instanz
} catch(routerError) {
    console.error("!!! Fehler beim Einbinden des PDF-Routers:", routerError);
    console.error("!!! Stellen Sie sicher, dass die Datei './routes/monthlyPdfEndpoint.js' existiert und korrekt exportiert wird.");
    // Optional: Serverstart verhindern, wenn kritische Teile fehlen
    // process.exit(1);
}


// --- Server Start ---
app.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` Server läuft auf Port ${port}`);
  console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (ADMIN_PASSWORD fehlt!)'}`);
  // Überprüfe, ob db.options existiert, um sicherzustellen, dass der Pool erstellt wurde
  if(db && typeof db.options === 'object') {
    console.log(` Datenbank verbunden (Pool erstellt): Host=${process.env.PGHOST || db.options.host || 'localhost'}, Port=${process.env.PGPORT || db.options.port || 5432}, DB=${process.env.PGDATABASE || db.options.database}`);
  } else if (db) {
       console.warn("!!! Datenbank-Pool-Objekt 'db' existiert, aber 'db.options' ist nicht verfügbar. Status unklar.");
  } else {
      console.error("!!! KRITISCH: Datenbankverbindung ('db' Pool) konnte nicht initialisiert werden! Server startet evtl. nicht korrekt.");
  }
  console.log(` Feiertagsmodul initialisiert für: DE / NW`);
  console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(` Frontend wird aus '${path.join(__dirname, 'public')}' bereitgestellt.`);
  console.log(`=======================================================`);
});
