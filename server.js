// server.js - KORRIGIERTE VERSION (... + Mitarbeiter-Passwörter + Mitarbeiter Login/Logout/Auth Middleware)

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
const bcrypt = require('bcrypt'); // Für Passwort-Hashing

dotenv.config();

// Datenbankverbindung herstellen
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { // Nur wenn nötig für lokale Entwicklung oder bestimmte Hoster
  //   rejectUnauthorized: false
  // }
});

// Datenbankverbindung testen (nur beim Start)
db.connect((err, client, release) => {
  if (err) {
    console.error('!!! Kritischer Fehler beim ersten Verbindungsversuch mit der Datenbank:', err.stack);
    // Programm nicht beenden, versuchen es später erneut im Setup
  } else {
    console.log('>>> Datenbank beim ersten Test erfolgreich verbunden.');
    release();
  }
});

// 2. Express App initialisieren
const app = express();
const port = process.env.PORT || 3000;

// Express anweisen, dem Proxy zu vertrauen
app.set('trust proxy', 1);

// 3. Globale Variablen und Hilfsfunktionen
const hd = new Holidays('DE', 'NW');
let calculateMonthlyData, calculatePeriodData, getExpectedHours, monthlyPdfRouter;
try {
    ({ calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('./utils/calculationUtils'));
    monthlyPdfRouter = require('./routes/monthlyPdfEndpoint');
} catch (e) {
    console.error("!!! FEHLER beim Laden von Hilfsmodulen (calculationUtils / monthlyPdfEndpoint):", e);
    console.error("!!! Stellen Sie sicher, dass die Dateien './utils/calculationUtils.js' und './routes/monthlyPdfEndpoint.js' existieren und korrekt exportieren.");
    process.exit(1);
}
const csvDateOptions = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };

function parseTime(timeStr) { /* ... unverändert ... */ if (!timeStr || !timeStr.includes(':')) return 0; const [hh, mm] = timeStr.split(':'); return parseInt(hh, 10) * 60 + parseInt(mm, 10); }
function calculateWorkHours(startTime, endTime) { /* ... unverändert ... */ if (!startTime || !endTime) return 0; const startMinutes = parseTime(startTime); const endMinutes = parseTime(endTime); let diffInMin = endMinutes - startMinutes; if (diffInMin < 0) { diffInMin += 24 * 60; } return diffInMin / 60; }
async function convertToCSV(database, data) { /* ... unverändert ... */ if (!data || data.length === 0) return ''; const csvRows = []; const headers = ["ID", "Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Ist-Std", "Soll-Std", "Differenz", "Bemerkung"]; csvRows.push(headers.join(',')); let employeeMap = new Map(); try { const empRes = await database.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees'); empRes.rows.forEach(emp => employeeMap.set(emp.name.toLowerCase(), emp)); } catch(e) { console.error("Fehler beim Abrufen der Mitarbeiterdaten für CSV-Sollstunden:", e); } for (const row of data) { let dateFormatted = ""; let dateForCalc = null; if (row.date) { try { const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date); dateForCalc = dateObj.toISOString().split('T')[0]; if (!isNaN(dateObj.getTime())) { dateFormatted = dateObj.toLocaleDateString('de-DE', csvDateOptions); } else { dateFormatted = String(row.date); } } catch (e) { dateFormatted = String(row.date); console.warn("Fehler bei CSV-Datumsformatierung:", row.date, e); } } const startTimeFormatted = row.startTime || ""; const endTimeFormatted = row.endTime || ""; const istHours = parseFloat(row.hours) || 0; let expectedHours = 0; const employeeData = employeeMap.get(String(row.name).toLowerCase()); if(employeeData && dateForCalc && typeof getExpectedHours === 'function') { try { const absenceCheck = await database.query('SELECT 1 FROM absences WHERE employee_id = $1 AND date = $2', [employeeData.id, dateForCalc]); if (absenceCheck.rows.length === 0) { expectedHours = getExpectedHours(employeeData, dateForCalc); } } catch (e) { console.error(`Fehler Soll-Std CSV (MA: ${row.name}, D: ${dateForCalc}):`, e); } } const diffHours = istHours - expectedHours; const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`; const values = [ row.id, row.name, dateFormatted, startTimeFormatted, endTimeFormatted, istHours.toFixed(2), expectedHours.toFixed(2), diffHours.toFixed(2), commentFormatted ]; csvRows.push(values.join(',')); } return csvRows.join('\n'); }


// 4. Middleware konfigurieren
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session Middleware
app.use(session({
    store: new pgSession({ pool: db, tableName: 'user_sessions' }),
    secret: process.env.SESSION_SECRET || 'sehr-geheimes-fallback-secret-fuer-dev',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24, httpOnly: true, sameSite: 'lax' }
}));

// Statische Dateien ausliefern
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// AUTHENTIFIZIERUNGS-MIDDLEWARE (NEU + isAdmin)
// ==========================================

// Middleware zur Prüfung ob Admin eingeloggt ist
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        console.warn(`isAdmin Check FAILED für Session ID: ${req.sessionID} - URL: ${req.originalUrl} von IP ${req.ip}`);
        // Bei API-Routen 403 senden, sonst ggf. zur Loginseite leiten
        if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/admin')) {
             res.status(403).json({ message: 'Zugriff verweigert. Admin-Login erforderlich.' });
        } else {
             res.redirect('/'); // Oder eine spezifische Admin-Login-Seite
        }
    }
}

// NEU: Middleware zur Prüfung ob Mitarbeiter eingeloggt ist
function isEmployee(req, res, next) {
    if (req.session && req.session.isEmployee === true && req.session.employeeId) {
        next(); // Zugriff erlaubt
    } else {
        console.warn(`isEmployee Check FAILED für Session ID: ${req.sessionID} - URL: ${req.originalUrl} von IP ${req.ip}`);
        res.status(401).json({ message: 'Authentifizierung erforderlich. Bitte anmelden.' }); // 401 Unauthorized
    }
}


// 5. Datenbank-Setup Funktion (unverändert zu vorheriger Vollversion)
const setupTables = async () => {
  try {
    const client = await db.connect();
    console.log(">>> DB-Verbindung für Setup hergestellt.");
    await client.query(`CREATE TABLE IF NOT EXISTS employees ( id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT, mo_hours DOUBLE PRECISION DEFAULT 0, di_hours DOUBLE PRECISION DEFAULT 0, mi_hours DOUBLE PRECISION DEFAULT 0, do_hours DOUBLE PRECISION DEFAULT 0, fr_hours DOUBLE PRECISION DEFAULT 0 );`);
    console.log("Tabelle 'employees' geprüft/erstellt.");
    await client.query(`CREATE TABLE IF NOT EXISTS work_hours ( id SERIAL PRIMARY KEY, name TEXT NOT NULL, date DATE NOT NULL, starttime TIME, endtime TIME, hours DOUBLE PRECISION, comment TEXT );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_hours_name_date ON work_hours (LOWER(name), date);`);
    console.log("Tabelle 'work_hours' und Index geprüft/erstellt.");
    await client.query(`CREATE TABLE IF NOT EXISTS monthly_balance ( id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, year_month DATE NOT NULL, difference DOUBLE PRECISION, carry_over DOUBLE PRECISION, UNIQUE (employee_id, year_month) );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_monthly_balance_employee_year_month ON monthly_balance (employee_id, year_month);`);
    console.log("Tabelle 'monthly_balance' und Index geprüft/erstellt.");
    await client.query(`CREATE TABLE IF NOT EXISTS absences ( id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date DATE NOT NULL, absence_type TEXT NOT NULL CHECK (absence_type IN ('VACATION', 'SICK', 'PUBLIC_HOLIDAY')), credited_hours DOUBLE PRECISION NOT NULL, comment TEXT, UNIQUE (employee_id, date) );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_absences_employee_date ON absences (employee_id, date);`);
    console.log("Tabelle 'absences' und Index geprüft/erstellt.");
    const sessionTableCheck = await client.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_sessions');`);
    if (!sessionTableCheck.rows[0].exists) { console.log("Session-Tabelle 'user_sessions' wird von connect-pg-simple erstellt..."); } else { console.log("Session-Tabelle 'user_sessions' existiert."); }
    client.release(); console.log(">>> DB-Verbindung für Setup freigegeben.");
  } catch (err) { console.error("!!! Kritischer Datenbank Setup Fehler:", err); process.exit(1); }
};


// ==========================================
// AUTHENTIFIZIERUNGS-ROUTEN (NEU + Admin)
// ==========================================

// NEU: Mitarbeiter-Login
app.post("/login", async (req, res) => {
    const { employeeName, password } = req.body;
    const logPrefix = `[ROUTE:/login] Name: ${employeeName} -`;
    console.log(`${logPrefix} Login-Versuch gestartet.`);

    if (!employeeName || !password) {
        console.warn(`${logPrefix} Fehlende Anmeldedaten.`);
        return res.status(400).json({ message: "Mitarbeitername und Passwort erforderlich." });
    }

    try {
        // Mitarbeiter suchen (Groß-/Kleinschreibung ignorieren, aber exakten Namen speichern)
        const findUserQuery = 'SELECT id, name, password_hash FROM employees WHERE LOWER(name) = LOWER($1)';
        const userResult = await db.query(findUserQuery, [employeeName]);

        if (userResult.rows.length === 0) {
            console.warn(`${logPrefix} Mitarbeiter nicht gefunden.`);
            return res.status(401).json({ message: "Mitarbeitername oder Passwort ungültig." });
        }

        const user = userResult.rows[0];

        // Prüfen, ob der Mitarbeiter überhaupt ein Passwort hat (wichtig für Migration)
        if (!user.password_hash) {
            console.warn(`${logPrefix} Mitarbeiter ${user.name} (ID: ${user.id}) hat kein Passwort gesetzt. Login nicht möglich.`);
            return res.status(401).json({ message: "Für diesen Mitarbeiter ist kein Login möglich. Bitte Admin kontaktieren." });
        }

        // Passwort vergleichen
        const match = await bcrypt.compare(password, user.password_hash);

        if (match) {
            // Passwort korrekt - Session starten
            req.session.regenerate((errReg) => {
                if (errReg) {
                    console.error(`${logPrefix} Fehler beim Regenerieren der Session für ${user.name}:`, errReg);
                    return res.status(500).json({ message: "Interner Serverfehler beim Login (Session Regenerate)." });
                }

                // Wichtige Benutzerinfos in der Session speichern
                req.session.isEmployee = true;
                req.session.employeeId = user.id;
                req.session.employeeName = user.name; // Exakten Namen aus DB verwenden

                req.session.save((errSave) => {
                    if (errSave) {
                        console.error(`${logPrefix} Fehler beim Speichern der Session für ${user.name}:`, errSave);
                        return res.status(500).json({ message: "Interner Serverfehler beim Login (Session Save)." });
                    }
                    console.log(`${logPrefix} Mitarbeiter ${user.name} (ID: ${user.id}) erfolgreich angemeldet. Session ID: ${req.sessionID}`);
                    // Nur notwendige Infos zurücksenden (kein Passwort-Hash!)
                    res.status(200).json({
                        message: "Login erfolgreich.",
                        employee: { id: user.id, name: user.name }
                    });
                });
            });
        } else {
            // Passwort falsch
            console.warn(`${logPrefix} Falsches Passwort für Mitarbeiter ${user.name} (ID: ${user.id}).`);
            res.status(401).json({ message: "Mitarbeitername oder Passwort ungültig." });
        }

    } catch (err) {
        console.error(`${logPrefix} Kritischer Fehler während des Login-Vorgangs:`, err);
        res.status(500).json({ message: "Interner Serverfehler beim Login." });
    }
});

// NEU: Mitarbeiter-Logout
app.post("/logout", isEmployee, (req, res) => { // Benutzt isEmployee Middleware
    const employeeName = req.session.employeeName; // Name aus Session für Log holen
    const logPrefix = `[ROUTE:/logout] MA: ${employeeName} - Session: ${req.sessionID} -`;
    console.log(`${logPrefix} Logout wird durchgeführt.`);
    req.session.destroy(err => {
        if (err) {
            console.error(`${logPrefix} Fehler beim Zerstören der Session:`, err);
            return res.status(500).json({ message: "Fehler beim Logout." });
        }
        res.clearCookie('connect.sid'); // Standard-Cookie-Name
        console.log(`${logPrefix} Session zerstört und Cookie gelöscht.`);
        res.status(200).json({ message: "Erfolgreich abgemeldet." });
    });
});


// Admin-Login (unverändert)
app.post("/admin-login", (req, res) => { /* ... unverändert ... */ const { password } = req.body; const adminPassword = process.env.ADMIN_PASSWORD; if (!adminPassword) { console.error("!!! ADMIN_PASSWORD ist nicht gesetzt!"); return res.status(500).send("Serverkonfigurationsfehler."); } if (!password) { return res.status(400).send("Passwort fehlt."); } if (password === adminPassword) { req.session.regenerate((errReg) => { if (errReg) { console.error("Fehler beim Regenerieren der Session:", errReg); return res.status(500).send("Session Fehler."); } req.session.isAdmin = true; req.session.save((errSave) => { if (errSave) { console.error("Fehler beim Speichern der Session:", errSave); return res.status(500).send("Session Speicherfehler."); } console.log(`Admin erfolgreich angemeldet. Session ID: ${req.sessionID}`); res.status(200).send("Admin erfolgreich angemeldet."); }); }); } else { console.warn(`Fehlgeschlagener Admin-Loginversuch von IP ${req.ip}`); res.status(401).send("Ungültiges Passwort."); } });

// Admin-Logout (unverändert)
app.post("/admin-logout", isAdmin, (req, res) => { /* ... unverändert ... */ if (req.session) { const sessionId = req.sessionID; req.session.destroy(err => { if (err) { console.error("Fehler beim Zerstören der Session:", err); return res.status(500).send("Fehler beim Logout."); } res.clearCookie('connect.sid'); console.log(`Admin abgemeldet (Session ID: ${sessionId}).`); return res.status(200).send("Erfolgreich abgemeldet."); }); } else { return res.status(200).send("Keine aktive Session zum Abmelden gefunden."); } });
// ==========================================
// GESCHÜTZTE MITARBEITER-ENDPUNKTE (NEU!)
// ==========================================
// Diese Routen erfordern jetzt einen Mitarbeiter-Login (isEmployee Middleware)

// Liefert Details für den nächsten Buchungsschritt des eingeloggten Mitarbeiters
app.get('/api/employee/next-booking-details', isEmployee, async (req, res) => {
    const employeeId = req.session.employeeId; // ID aus der Session holen!
    const employeeName = req.session.employeeName; // Name aus Session für Logging
    const logPrefix = `[ROUTE:/api/employee/next-booking-details] MA_ID: ${employeeId} -`;
    console.log(`${logPrefix} Anfrage erhalten.`);

    if (!employeeId) { // Sollte durch Middleware nicht passieren, aber sicher ist sicher
         console.error(`${logPrefix} Kritischer Fehler: employeeId fehlt in der Session!`);
         return res.status(401).json({ message: 'Ungültige Session.' });
    }

    try {
        // Mitarbeiter anhand der ID suchen, um den korrekten Namen sicherzustellen
        const empResult = await db.query('SELECT name FROM employees WHERE id = $1', [employeeId]);
        if(empResult.rows.length === 0){
             console.error(`${logPrefix} Mitarbeiter mit ID ${employeeId} nicht mehr in DB gefunden! Session evtl. veraltet.`);
             // Session zerstören, da ungültig
             req.session.destroy();
             res.clearCookie('connect.sid');
             return res.status(401).json({ message: 'Mitarbeiter nicht gefunden, bitte neu anmelden.' });
        }
        const currentEmployeeName = empResult.rows[0].name; // Namen aus DB verwenden

        const query = `
            SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
            FROM work_hours
            WHERE LOWER(name) = LOWER($1) -- Suche immer noch über Namen, da alte Daten existieren könnten
            ORDER BY date DESC, starttime DESC NULLS LAST
            LIMIT 1;
        `;
        const result = await db.query(query, [currentEmployeeName.toLowerCase()]);
        let nextBooking = 'arbeitsbeginn', entryId = null, startDate = null, startTime = null;
        if (result.rows.length > 0) {
            const lastEntry = result.rows[0];
            if (lastEntry.starttime_formatted && !lastEntry.endtime) {
                nextBooking = 'arbeitsende';
                entryId = lastEntry.id;
                startDate = lastEntry.date instanceof Date ? lastEntry.date.toISOString().split('T')[0] : lastEntry.date;
                startTime = lastEntry.starttime_formatted;
            }
        }
        console.log(`${logPrefix} Nächste Aktion für ${currentEmployeeName}: ${nextBooking}`);
        res.json({ nextBooking, id: entryId, startDate, startTime });
    } catch (err) {
        console.error(`${logPrefix} Fehler:`, err);
        res.status(500).json({ message: 'Serverfehler beim Prüfen des Buchungsstatus.' });
    }
});

// Bucht den Arbeitsbeginn für den eingeloggten Mitarbeiter
app.post('/api/employee/log-start', isEmployee, async (req, res) => {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName; // Namen aus Session verwenden!
    const { date, startTime } = req.body; // Datum und Zeit kommen vom Client
    const logPrefix = `[ROUTE:/api/employee/log-start] MA: ${employeeName} (ID:${employeeId}) -`;
    console.log(`${logPrefix} Anfrage erhalten mit Date: ${date}, Time: ${startTime}`);

    if (!date || !startTime || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
        console.warn(`${logPrefix} Ungültige Daten: Date=${date}, Time=${startTime}`);
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten (Datum YYYY-MM-DD, Startzeit HH:MM).' });
    }

    try {
        // Prüfen auf offene Einträge
        const checkOpenQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NULL`;
        const checkOpenResult = await db.query(checkOpenQuery, [employeeName.toLowerCase(), date]);
        if (checkOpenResult.rows.length > 0) {
             console.warn(`${logPrefix} Konflikt: Bereits offener Eintrag für ${date}.`);
             return res.status(409).json({ message: `Für diesen Tag existiert bereits ein nicht abgeschlossener Arbeitsbeginn.` });
        }

        // Prüfen auf abgeschlossene Einträge (Mehrfachbuchung)
        const checkCompleteQuery = `SELECT id FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND endtime IS NOT NULL`;
        const checkCompleteResult = await db.query(checkCompleteQuery, [employeeName.toLowerCase(), date]);
        if (checkCompleteResult.rows.length > 0) {
            console.warn(`${logPrefix} Konflikt: Bereits abgeschlossener Eintrag für ${date}. Mehrfachbuchung blockiert.`);
            return res.status(409).json({ message: `Für diesen Tag existiert bereits eine abgeschlossene Arbeitszeitbuchung. Mehrfachbuchungen pro Tag sind nicht erlaubt.` });
        }

        // Eintrag erstellen (Namen aus Session verwenden!)
        const insertQuery = `INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`;
        const insertResult = await db.query(insertQuery, [employeeName, date, startTime]);
        const newEntryId = insertResult.rows[0].id;
        console.log(`${logPrefix} Start gebucht: ${date}, ${startTime} (ID: ${newEntryId})`);
        res.status(201).json({ id: newEntryId });

    } catch (err) {
        console.error(`${logPrefix} Fehler:`, err);
        // Spezifische DB-Fehler prüfen? (z.B. FK Constraint, falls Name geändert wurde)
        res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsbeginns.' });
    }
});

// Bucht das Arbeitsende für den eingeloggten Mitarbeiter
app.put('/api/employee/log-end/:id', isEmployee, async (req, res) => {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const { id } = req.params;
    const { endTime, comment } = req.body;
    const logPrefix = `[ROUTE:/api/employee/log-end] MA: ${employeeName} (ID:${employeeId}) - EntryID: ${id} -`;
    console.log(`${logPrefix} Anfrage erhalten mit Time: ${endTime}`);

    if (!endTime || !id || isNaN(parseInt(id)) || !/^\d{2}:\d{2}$/.test(endTime)) {
        console.warn(`${logPrefix} Ungültige Daten: ID=${id}, Time=${endTime}`);
        return res.status(400).json({ message: 'Fehlende oder ungültige Daten (ID, Endzeit HH:MM).' });
    }
    const entryId = parseInt(id);

    try {
        // Eintrag holen und prüfen, ob er zum eingeloggten Mitarbeiter gehört!
        const entryResult = await db.query(
            `SELECT name, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime FROM work_hours WHERE id = $1 AND LOWER(name) = LOWER($2)`,
            [entryId, employeeName.toLowerCase()] // Prüfung auf Mitarbeiter!
        );
        if (entryResult.rows.length === 0) {
            console.warn(`${logPrefix} Eintrag nicht gefunden oder gehört nicht zu diesem Mitarbeiter.`);
            // Prüfen ob Eintrag existiert aber anderem MA gehört
            const existsCheck = await db.query('SELECT 1 FROM work_hours WHERE id = $1', [entryId]);
            if(existsCheck.rows.length > 0) {
                 return res.status(403).json({ message: `Zugriff verweigert: Dieser Eintrag gehört nicht Ihnen.` });
            } else {
                 return res.status(404).json({ message: `Eintrag mit ID ${entryId} nicht gefunden.` });
            }
        }
        const entry = entryResult.rows[0];

        if (entry.endtime) {
             console.warn(`${logPrefix} Konflikt: Eintrag wurde bereits abgeschlossen.`);
             return res.status(409).json({ message: `Eintrag ID ${entryId} wurde bereits abgeschlossen.` });
        }
        if (!entry.starttime_formatted) {
             console.error(`${logPrefix} Fehler: Keine Startzeit für Eintrag gefunden.`);
             return res.status(400).json({ message: `Keine Startzeit für Eintrag ID ${entryId} gefunden.` });
        }

        const netHours = calculateWorkHours(entry.starttime_formatted, endTime);
        if (netHours < 0) {
            console.warn(`${logPrefix} Negative Arbeitszeit (${entry.starttime_formatted} - ${endTime}) berechnet. Speichere 0.`);
        }

        const updateQuery = `UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`;
        await db.query(updateQuery, [endTime, comment || null, netHours >= 0 ? netHours : 0, entryId]);

        console.log(`${logPrefix} Ende gebucht: ${endTime} (Stunden: ${netHours.toFixed(2)})`);
        res.status(200).json({ message: 'Arbeitsende erfolgreich gespeichert.', calculatedHours: netHours.toFixed(2) });

    } catch (err) {
        console.error(`${logPrefix} Fehler:`, err);
        res.status(500).json({ message: 'Serverfehler beim Buchen des Arbeitsendes.' });
    }
});

// Liefert Stundenübersicht für den eingeloggten Mitarbeiter
app.get('/api/employee/summary-hours', isEmployee, async (req, res) => {
    const employeeId = req.session.employeeId;
    const employeeName = req.session.employeeName;
    const { date } = req.query; // Datum kommt als Query-Parameter
    const logPrefix = `[ROUTE:/api/employee/summary-hours] MA: ${employeeName} (ID:${employeeId}) - Date: ${date} -`;
    console.log(`${logPrefix} Anfrage erhalten.`);

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.warn(`${logPrefix} Ungültiges Datum: ${date}`);
        return res.status(400).json({ message: 'Datum (YYYY-MM-DD) erforderlich.' });
    }

    try {
        // Tagesstunden
        const dailyResult = await db.query(
            `SELECT SUM(hours) AS total_daily_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL`,
            [employeeName.toLowerCase(), date]
        );
        const dailyHours = dailyResult.rows.length > 0 ? (parseFloat(dailyResult.rows[0].total_daily_hours) || 0) : 0;

        // Monatsstunden
        const yearMonthDay = date.split('-');
        const year = parseInt(yearMonthDay[0]);
        const month = parseInt(yearMonthDay[1]);
        const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
        const lastDayForQuery = date;

        const monthlyResult = await db.query(
            `SELECT SUM(hours) AS total_monthly_hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`,
            [employeeName.toLowerCase(), firstDayOfMonth, lastDayForQuery]
        );
        const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_monthly_hours ? (parseFloat(monthlyResult.rows[0].total_monthly_hours) || 0) : 0;

        console.log(`${logPrefix} Ergebnis: Daily=${dailyHours.toFixed(2)}, Monthly=${monthlyHours.toFixed(2)}`);
        res.json({ dailyHours, monthlyHours });

    } catch (err) {
        console.error(`${logPrefix} Fehler:`, err);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Stundenzusammenfassung.' });
    }
});

// ==========================================
// ADMIN Endpunkte (isAdmin Middleware)
// ==========================================
// (Unverändert von vorheriger Version, außer Mitarbeiterverwaltung nutzt jetzt Passwörter)

// Arbeitszeiten für Admin anzeigen
app.get('/admin-work-hours', isAdmin, async (req, res, next) => { /* ... unverändert ... */ const { employeeId, year, month } = req.query; const logPrefix = `[ROUTE:/admin-work-hours] EmpID: ${employeeId}, M: ${month}/${year}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); try { let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`; const whereClauses = []; const queryParams = []; let paramIndex = 1; if (employeeId && employeeId !== 'all' && employeeId !== '') { const empIdInt = parseInt(employeeId); if (isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'}); } whereClauses.push(`e.id = $${paramIndex++}`); queryParams.push(empIdInt); } if (year && month) { const parsedYear = parseInt(year); const parsedMonth = parseInt(month); if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) { console.error(`${logPrefix} ERROR - Invalid year/month.`); return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' }); } try { const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt'); const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0]; whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr); whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr); } catch(dateError) { console.error(`${logPrefix} ERROR - Date processing error:`, dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); } } let finalQuery = baseQuery; if (whereClauses.length > 0) { finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; } finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS FIRST;`; console.log(`${logPrefix} Executing query: ${finalQuery.substring(0, 200)}... Params: ${queryParams}`); const result = await db.query(finalQuery, queryParams); console.log(`${logPrefix} Query successful, ${result.rows.length} rows found.`); const formattedRows = result.rows.map(row => ({ ...row, date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date })); res.json(formattedRows); } catch (err) { console.error(`${logPrefix} ERROR - DB or processing error: ${err.message}`); next(err); } });
// CSV-Download für Admin
app.get('/admin-download-csv', isAdmin, async (req, res, next) => { /* ... unverändert ... */ const logPrefix = `[ROUTE:/admin-download-csv] Query: ${JSON.stringify(req.query)}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); try { const { employeeId, year, month } = req.query; let baseQuery = `SELECT w.id, e.name, w.date, w.hours, w.comment, TO_CHAR(w.starttime, 'HH24:MI') AS "startTime", TO_CHAR(w.endtime, 'HH24:MI') AS "endTime" FROM work_hours w JOIN employees e ON LOWER(w.name) = LOWER(e.name)`; const whereClauses = []; const queryParams = []; let paramIndex = 1; let filterDesc = ""; if (employeeId && employeeId !== 'all' && employeeId !== '') { const empIdInt = parseInt(employeeId); if (isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Ungültige Mitarbeiter-ID.'}); } whereClauses.push(`e.id = $${paramIndex++}`); queryParams.push(empIdInt); try { const nameRes = await db.query('SELECT name FROM employees WHERE id = $1', [empIdInt]); if(nameRes.rows.length > 0) filterDesc = nameRes.rows[0].name.replace(/[^a-z0-9]/gi, '_'); } catch {} } else { filterDesc = "alle_MA"; } if (year && month) { const parsedYear = parseInt(year); const parsedMonth = parseInt(month); if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || String(parsedYear).length !== 4) { console.error(`${logPrefix} ERROR - Invalid year/month.`); return res.status(400).json({ message: 'Ungültiges Jahr/Monat.' }); } try { const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)); const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 1)); if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error('Ungültiges Datum erstellt'); const startDateStr = startDate.toISOString().split('T')[0]; const endDateStr = endDate.toISOString().split('T')[0]; whereClauses.push(`w.date >= $${paramIndex++}`); queryParams.push(startDateStr); whereClauses.push(`w.date < $${paramIndex++}`); queryParams.push(endDateStr); filterDesc += `_${year}_${String(parsedMonth).padStart(2,'0')}`; } catch(dateError) { console.error(`${logPrefix} ERROR - Date processing error:`, dateError); return res.status(400).json({ message: `Datumsfehler für ${year}-${month}.` }); } } else { filterDesc += "_alle_Zeiten"; } let finalQuery = baseQuery; if (whereClauses.length > 0) finalQuery += ` WHERE ${whereClauses.join(' AND ')}`; finalQuery += ` ORDER BY w.date ASC, e.name ASC, w.starttime ASC NULLS FIRST;`; console.log(`${logPrefix} Executing query for CSV: ${finalQuery.substring(0, 200)}... Params: ${queryParams}`); const result = await db.query(finalQuery, queryParams); console.log(`${logPrefix} Query successful, ${result.rows.length} rows found. Generating CSV...`); const csvData = await convertToCSV(db, result.rows); const filename = `arbeitszeiten_${filterDesc}_${new Date().toISOString().split('T')[0]}.csv`; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csvData, 'utf-8')])); console.log(`${logPrefix} CSV sent successfully.`); } catch (err) { console.error(`${logPrefix} ERROR - DB or CSV generation error: ${err.message}`); next(err); } });
// Admin: Arbeitszeiteintrag aktualisieren
app.put('/api/admin/update-hours', isAdmin, async (req, res, next) => { /* ... unverändert ... */ const logPrefix = `[ROUTE:/api/admin/update-hours] ID: ${req.body?.id}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`); try { const { id, date, startTime, endTime, comment } = req.body; const entryId = parseInt(id); if (isNaN(entryId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).json({ message: 'Ungültige ID.' }); } if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`${logPrefix} ERROR - Invalid Date.`); return res.status(400).json({ message: 'Ungültiges Datum.' }); } if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) { console.error(`${logPrefix} ERROR - Invalid startTime.`); return res.status(400).json({ message: 'Ungültige Startzeit.' }); } if (!endTime || !/^\d{2}:\d{2}$/.test(endTime)) { console.error(`${logPrefix} ERROR - Invalid endTime.`); return res.status(400).json({ message: 'Ungültige Endzeit.' }); } const netHours = calculateWorkHours(startTime, endTime); if (netHours < 0) console.warn(`${logPrefix} Negative work hours calculated. Saving 0.`); console.log(`${logPrefix} Checking if entry exists...`); const checkResult = await db.query('SELECT 1 FROM work_hours WHERE id = $1', [entryId]); if (checkResult.rows.length === 0) { console.warn(`${logPrefix} Entry not found.`); return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` }); } console.log(`${logPrefix} Updating entry in DB...`); const query = `UPDATE work_hours SET date = $1, starttime = $2, endtime = $3, hours = $4, comment = $5 WHERE id = $6;`; const result = await db.query(query, [date, startTime, endTime, netHours >= 0 ? netHours : 0, comment || null, entryId]); if (result.rowCount > 0) { console.log(`${logPrefix} Update successful.`); res.status(200).send('Eintrag aktualisiert.'); } else { console.warn(`${logPrefix} Update failed (rowCount=0).`); res.status(404).send(`Eintrag ID ${entryId} nicht aktualisiert.`); } } catch (err) { console.error(`${logPrefix} ERROR - DB or processing error: ${err.message}`); next(err); } });
// Admin: Arbeitszeiteintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res, next) => { /* ... unverändert ... */ const logPrefix = `[ROUTE:/api/admin/delete-hours] ID: ${req.params?.id}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); try { const { id } = req.params; const entryId = parseInt(id); if (isNaN(entryId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.'); } console.log(`${logPrefix} Deleting entry from DB...`); const result = await db.query('DELETE FROM work_hours WHERE id = $1', [entryId]); if (result.rowCount > 0) { console.log(`${logPrefix} Delete successful.`); res.status(200).send('Eintrag gelöscht.'); } else { console.warn(`${logPrefix} Entry not found.`); res.status(404).send(`Eintrag ID ${entryId} nicht gefunden.`); } } catch (err) { console.error(`${logPrefix} ERROR - DB Error: ${err.message}`); next(err); } });
// Admin: Alle Daten löschen
app.delete('/adminDeleteData', isAdmin, async (req, res, next) => { /* ... unverändert ... */ const logPrefix = `[ROUTE:/adminDeleteData] Session: ${req.sessionID} -`; console.warn(`${logPrefix} !!! DELETE ALL DATA REQUEST RECEIVED !!!`); let client; try { client = await db.connect(); await client.query('BEGIN'); console.warn(`${logPrefix} Deleting monthly_balance...`); const resultMB = await client.query('DELETE FROM monthly_balance'); console.warn(`${logPrefix} -> ${resultMB.rowCount} rows deleted.`); console.warn(`${logPrefix} Deleting absences...`); const resultAbs = await client.query('DELETE FROM absences'); console.warn(`${logPrefix} -> ${resultAbs.rowCount} rows deleted.`); console.warn(`${logPrefix} Deleting work_hours...`); const resultWH = await client.query('DELETE FROM work_hours'); console.warn(`${logPrefix} -> ${resultWH.rowCount} rows deleted.`); await client.query('COMMIT'); console.warn(`${logPrefix} !!! ALL DATA DELETED SUCCESSFULLY !!!`); res.status(200).send(`Alle ${resultWH.rowCount} Arbeitszeiten, ${resultMB.rowCount} Bilanzen und ${resultAbs.rowCount} Abwesenheiten wurden gelöscht.`); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} !!! CRITICAL DB ERROR DURING DELETE ALL: ${err.message}`, err.stack); next(err); } finally { if (client) client.release(); } });
// --- Mitarbeiterverwaltung (angepasst für Passwort) ---
app.get('/admin/employees', isAdmin, async (req, res, next) => { /* ... unverändert ... */ try { const logPrefix = `[ROUTE:/admin/employees GET] Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); console.log(`${logPrefix} Querying employees...`); const result = await db.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name ASC'); console.log(`${logPrefix} Query successful, found ${result.rows.length} employees.`); res.json(result.rows); } catch (err) { console.error(`[ROUTE:/admin/employees GET] ERROR - DB Error: ${err.message}`, err.stack); next(err); } });
app.post('/admin/employees', isAdmin, async (req, res, next) => { /* ... unverändert (mit PW hash) ... */ const logPrefix = `[ROUTE:/admin/employees POST] Session: ${req.sessionID} -`; try { console.log(`${logPrefix} Request received. Data: ${JSON.stringify(req.body)}`); const { name, password, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body; const trimmedName = name ? name.trim() : ''; if (!trimmedName) { console.error(`${logPrefix} ERROR - Empty name.`); return res.status(400).send('Name darf nicht leer sein.'); } if (!password || password.length < 6) { console.error(`${logPrefix} ERROR - Password missing or too short.`); return res.status(400).send('Passwort fehlt oder ist zu kurz (mind. 6 Zeichen).'); } const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0); if (hours.some(h => h < 0)) { console.error(`${logPrefix} ERROR - Negative hours.`); return res.status(400).send('Stunden dürfen nicht negativ sein.'); } const saltRounds = 10; const passwordHash = await bcrypt.hash(password, saltRounds); console.log(`${logPrefix} Password hashed successfully.`); console.log(`${logPrefix} Inserting new employee '${trimmedName}'...`); const query = `INSERT INTO employees (name, password_hash, mo_hours, di_hours, mi_hours, do_hours, fr_hours) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours;`; const result = await db.query(query, [trimmedName, passwordHash, ...hours]); console.log(`${logPrefix} Insert successful. ID: ${result.rows[0].id}`); res.status(201).json(result.rows[0]); } catch (err) { console.error(`${logPrefix} ERROR - DB Error or processing error: ${err.message}`, err.stack); if (err.code === '23505') { console.warn(`${logPrefix} Conflict - Employee name '${req.body.name}' already exists.`); res.status(409).send(`Mitarbeiter '${req.body.name}' existiert bereits.`); } else { next(err); } } });
app.put('/admin/employees/:id', isAdmin, async (req, res, next) => { /* ... unverändert (mit PW hash update) ... */ let client; const logPrefix = `[ROUTE:/admin/employees PUT] ID: ${req.params?.id}, Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { id } = req.params; const { name, newPassword, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body; const employeeId = parseInt(id); const trimmedName = name ? name.trim() : ''; if (isNaN(employeeId)) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.'); } if (!trimmedName) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Empty name.`); return res.status(400).send('Name darf nicht leer sein.'); } if (newPassword && newPassword.length < 6) { console.error(`${logPrefix} ERROR - New password too short.`); await client.query('ROLLBACK'); return res.status(400).send('Neues Passwort ist zu kurz (mind. 6 Zeichen).'); } const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || 0); if (hours.some(h => h < 0)) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Negative hours.`); return res.status(400).send('Stunden dürfen nicht negativ sein.');} const oldNameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]); if (oldNameResult.rows.length === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee not found.`); return res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); } const oldName = oldNameResult.rows[0].name; const newName = trimmedName; console.log(`${logPrefix} Updating employee table... Old: ${oldName}, New: ${newName}`); let updateQuery = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6`; const queryParams = [newName, ...hours]; let paramIndex = 7; if (newPassword) { const saltRounds = 10; const passwordHash = await bcrypt.hash(newPassword, saltRounds); console.log(`${logPrefix} New password provided, hashing and adding to update.`); updateQuery += `, password_hash = $${paramIndex++}`; queryParams.push(passwordHash); } updateQuery += ` WHERE id = $${paramIndex};`; queryParams.push(employeeId); console.log(`${logPrefix} Executing update query...`); await client.query(updateQuery, queryParams); if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) { console.log(`${logPrefix} Name changed, updating work_hours...`); const workHoursUpdateResult = await client.query(`UPDATE work_hours SET name = $1 WHERE LOWER(name) = LOWER($2)`, [newName, oldName.toLowerCase()]); console.log(`${logPrefix} -> ${workHoursUpdateResult.rowCount} work_hours rows updated.`); } await client.query('COMMIT'); console.log(`${logPrefix} Transaction committed successfully.`); res.status(200).send('Mitarbeiterdaten aktualisiert.'); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR during transaction. Rolled back. Error: ${err.message}`, err.stack); if (err.code === '23505') { res.status(409).send(`Name '${req.body.name}' existiert bereits.`); } else { next(err); } } finally { if (client) client.release(); } });
app.delete('/admin/employees/:id', isAdmin, async (req, res, next) => { /* ... unverändert ... */ let client; const logPrefix = `[ROUTE:/admin/employees DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { id } = req.params; const employeeId = parseInt(id); if (isNaN(employeeId)) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige ID.');} const nameResult = await client.query('SELECT name FROM employees WHERE id = $1 FOR UPDATE', [employeeId]); if (nameResult.rows.length === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee not found.`); return res.status(404).send(`MA ID ${employeeId} nicht gefunden.`); } const employeeName = nameResult.rows[0].name; console.warn(`${logPrefix} Deleting employee ${employeeName} (ID: ${employeeId}) from employees table (cascades to absences, monthly_balance, work_hours)...`); const deleteEmpResult = await client.query('DELETE FROM employees WHERE id = $1', [employeeId]); if (deleteEmpResult.rowCount > 0) { await client.query('COMMIT'); console.warn(`${logPrefix} !!! Employee and related data deleted successfully. Transaction committed. !!!`); res.status(200).send('Mitarbeiter und zugehörige Daten gelöscht.'); } else { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee delete failed (rowCount=0). Rolled back.`); res.status(404).send(`MA ID ${employeeId} nicht gelöscht (nicht gefunden?).`); } } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} !!! CRITICAL ERROR during employee delete. Rolled back. Error: ${err.message}`, err.stack); if (err.code === '23503') { res.status(409).send('FK Fehler: Abhängige Daten existieren (sollte nicht passieren mit CASCADE).'); } else { next(err); } } finally { if (client) client.release(); } });

// --- Auswertungen (unverändert) ---
app.get('/calculate-monthly-balance', isAdmin, async (req, res, next) => { /* ... unverändert ... */ try { const { name, year, month } = req.query; const logPrefix = `[ROUTE:/calculate-monthly-balance] MA: ${name}, Date: ${month}/${year}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); if (!name || !year || !month || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4 || isNaN(parseInt(month)) || month < 1 || month > 12) { console.error(`${logPrefix} ERROR - Invalid input.`); return res.status(400).json({ message: "Ungültige Eingabe: Name, Jahr (YYYY) und Monat (1-12) erforderlich." }); } console.log(`${logPrefix} Calling calculateMonthlyData...`); const result = await calculateMonthlyData(db, name, year, month); console.log(`${logPrefix} calculateMonthlyData successful. Sending response.`); res.json(result); } catch (err) { const logPrefix = `[ROUTE:/calculate-monthly-balance] MA: ${req.query.name}, Date: ${req.query.month}/${req.query.year}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`); if (err.message && err.message.toLowerCase().includes("nicht gefunden")) { res.status(404).json({ message: err.message }); } else { next(err); } } });
app.get('/calculate-period-balance', isAdmin, async (req, res, next) => { /* ... unverändert ... */ try { const { name, year, periodType, periodValue } = req.query; const logPrefix = `[ROUTE:/calculate-period-balance] MA: ${name}, Year: ${year}, Type: ${periodType}, Val: ${periodValue}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); if (!name || !year || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4) { console.error(`${logPrefix} ERROR - Invalid name or year.`); return res.status(400).json({ message: "Ungültige Eingabe: Name und Jahr (YYYY) erforderlich." }); } const periodTypeUpper = periodType ? periodType.toUpperCase() : null; if (!periodTypeUpper || !['QUARTER', 'YEAR'].includes(periodTypeUpper)) { console.error(`${logPrefix} ERROR - Invalid periodType.`); return res.status(400).json({ message: "Ungültiger Periodentyp. Erlaubt sind 'QUARTER' oder 'YEAR'." }); } let parsedPeriodValue = null; if (periodTypeUpper === 'QUARTER') { parsedPeriodValue = parseInt(periodValue); if (!periodValue || isNaN(parsedPeriodValue) || parsedPeriodValue < 1 || parsedPeriodValue > 4) { console.error(`${logPrefix} ERROR - Invalid periodValue for QUARTER.`); return res.status(400).json({ message: "Ungültiges Quartal (1-4) für Periodentyp 'QUARTER' erforderlich." }); } } console.log(`${logPrefix} Calling calculatePeriodData...`); const result = await calculatePeriodData(db, name, year, periodTypeUpper, parsedPeriodValue); console.log(`${logPrefix} calculatePeriodData successful. Sending response.`); res.json(result); } catch (err) { const logPrefix = `[ROUTE:/calculate-period-balance] MA: ${req.query.name}, Year: ${req.query.year}, Type: ${req.query.periodType}, Val: ${req.query.periodValue}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`); if (err.message && err.message.toLowerCase().includes("nicht gefunden")) { res.status(404).json({ message: err.message }); } else { next(err); } } });

// --- Abwesenheiten Admin (unverändert) ---
app.get('/admin/absences', isAdmin, async (req, res, next) => { /* ... unverändert ... */ try { const { employeeId } = req.query; const empIdInt = parseInt(employeeId); const logPrefix = `[ROUTE:/admin/absences GET] EmpID: ${employeeId}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); if (!employeeId || isNaN(empIdInt)) { console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Gültige numerische employeeId als Query-Parameter erforderlich.' }); } console.log(`${logPrefix} Querying absences from DB...`); const query = `SELECT id, date, absence_type, credited_hours, comment FROM absences WHERE employee_id = $1 ORDER BY date ASC`; const result = await db.query(query, [empIdInt]); console.log(`${logPrefix} DB query successful, found ${result.rows.length} entries. Formatting and sending response.`); const formattedResult = result.rows.map(row => ({ ...row, date: (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date) })); res.json(formattedResult); } catch (err) { const logPrefix = `[ROUTE:/admin/absences GET] EmpID: ${req.query.employeeId}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - Error during processing: ${err.message}`, err.stack); next(err); } });
app.post('/admin/absences', isAdmin, async (req, res, next) => { /* ... unverändert ... */ let client; const logPrefix = `[ROUTE:/admin/absences POST] Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { employeeId, date, absenceType, comment } = req.body; const empIdInt = parseInt(employeeId); if (!employeeId || isNaN(empIdInt)) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Invalid employeeId.`); return res.status(400).json({ message: 'Gültige numerische employeeId erforderlich.' }); } if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Invalid date.`); return res.status(400).json({ message: 'Gültiges Datum im Format YYYY-MM-DD erforderlich.' }); } if (!absenceType || !['VACATION', 'SICK', 'PUBLIC_HOLIDAY'].includes(absenceType.toUpperCase())) { await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR - Invalid absenceType.`); return res.status(400).json({ message: "Ungültiger absenceType. Erlaubt: 'VACATION', 'SICK', 'PUBLIC_HOLIDAY'." }); } const normalizedAbsenceType = absenceType.toUpperCase(); const targetDate = new Date(date + 'T00:00:00Z'); const dayOfWeek = targetDate.getUTCDay(); if (dayOfWeek === 0 || dayOfWeek === 6) { const fd = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'}); console.warn(`${logPrefix} Attempt to book absence on weekend (${fd}).`); await client.query('ROLLBACK'); return res.status(400).json({ message: `Abwesenheiten können nicht am Wochenende (${fd}) gebucht werden.` }); } if (normalizedAbsenceType === 'PUBLIC_HOLIDAY') { const isHoliday = hd.isHoliday(targetDate); if (!isHoliday || isHoliday.type !== 'public') { const fd = targetDate.toLocaleDateString('de-DE',{timeZone:'UTC'}); console.warn(`${logPrefix} Attempt to book non-public-holiday ${fd} as PUBLIC_HOLIDAY for MA ${empIdInt}. Actual type: ${isHoliday?.type || 'none'}`); await client.query('ROLLBACK'); return res.status(400).json({ message: `Das Datum ${fd} ist laut System kein gesetzlicher Feiertag in NRW.` }); } } console.log(`${logPrefix} Fetching employee data for ID ${empIdInt}...`); const empResult = await client.query('SELECT * FROM employees WHERE id = $1', [empIdInt]); if (empResult.rows.length === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} Employee not found.`); return res.status(404).json({ message: `Mitarbeiter mit ID ${empIdInt} nicht gefunden.` }); } const employeeData = empResult.rows[0]; console.log(`${logPrefix} Calculating expected hours for ${date}...`); const expectedHoursForDay = getExpectedHours(employeeData, date); let credited_hours = expectedHoursForDay; if (normalizedAbsenceType !== 'PUBLIC_HOLIDAY' && expectedHoursForDay <= 0) { const fd = targetDate.toLocaleDateString('de-DE',{weekday: 'long', timeZone:'UTC'}); await client.query('ROLLBACK'); console.warn(`${logPrefix} Cannot book absence, employee has 0 expected hours on ${fd}.`); return res.status(400).json({ message: `Buchung nicht möglich: Mitarbeiter ${employeeData.name} hat an diesem Tag (${fd}) keine Soll-Stunden.` }); } credited_hours = Math.max(0, credited_hours); console.log(`${logPrefix} Inserting absence (Type: ${normalizedAbsenceType}, Credited: ${credited_hours})...`); const insertQuery = `INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id, date, absence_type, credited_hours, comment;`; const insertResult = await client.query(insertQuery, [empIdInt, date, normalizedAbsenceType, credited_hours, comment || null]); await client.query('COMMIT'); console.log(`${logPrefix} Transaction committed. Absence ID: ${insertResult.rows[0].id}`); const createdAbsence = { ...insertResult.rows[0], date: insertResult.rows[0].date.toISOString().split('T')[0], credited_hours: parseFloat(insertResult.rows[0].credited_hours) || 0 }; res.status(201).json(createdAbsence); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} ERROR during transaction. Rolled back. Error: ${err.message}`, err.stack); if (err.code === '23505') { const fd = new Date(req.body.date+'T00:00:00Z').toLocaleDateString('de-DE',{timeZone:'UTC'}); res.status(409).json({ message: `Für diesen Mitarbeiter existiert bereits ein Abwesenheitseintrag am ${fd}.` }); } else if (err.code === '23503') { res.status(404).json({ message: `Mitarbeiter mit ID ${req.body.employeeId} nicht gefunden (FK Fehler).`}); } else { next(err); } } finally { if (client) client.release(); } });
app.delete('/admin/absences/:id', isAdmin, async (req, res, next) => { /* ... unverändert ... */ try { const logPrefix = `[ROUTE:/admin/absences DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`; console.log(`${logPrefix} Request received.`); const { id } = req.params; const absenceId = parseInt(id); if (isNaN(absenceId)) { console.error(`${logPrefix} ERROR - Invalid ID.`); return res.status(400).send('Ungültige Abwesenheits-ID.');} console.log(`${logPrefix} Deleting absence from DB...`); const result = await db.query('DELETE FROM absences WHERE id = $1', [absenceId]); if (result.rowCount > 0) { console.log(`${logPrefix} Delete successful.`); res.status(200).send('Abwesenheitseintrag erfolgreich gelöscht.'); } else { console.warn(`${logPrefix} Absence not found.`); res.status(404).send(`Abwesenheitseintrag mit ID ${absenceId} nicht gefunden.`); } } catch (err) { const logPrefix = `[ROUTE:/admin/absences DELETE] ID: ${req.params?.id}, Session: ${req.sessionID} -`; console.error(`${logPrefix} ERROR - DB Error: ${err.message}`, err.stack); next(err); } });
app.post('/admin/generate-holidays', isAdmin, async (req, res, next) => { /* ... unverändert ... */ let client; const logPrefix = `[ROUTE:/admin/generate-holidays POST] Year: ${req.body?.year}, Session: ${req.sessionID} -`; try { client = await db.connect(); await client.query('BEGIN'); console.log(`${logPrefix} Transaction started.`); const { year } = req.body; const currentYear = new Date().getFullYear(); const minYear = currentYear - 5; const maxYear = currentYear + 5; const targetYear = parseInt(year); if (!year || isNaN(targetYear) || targetYear < minYear || targetYear > maxYear) { console.error(`${logPrefix} ERROR - Invalid year.`); await client.query('ROLLBACK'); return res.status(400).json({ message: `Ungültiges oder fehlendes Jahr. Bitte ein Jahr zwischen ${minYear} und ${maxYear} angeben.` }); } console.log(`${logPrefix} Starting holiday generation for NRW, year ${targetYear}...`); let generatedCount = 0; let skippedCount = 0; let processedEmployees = 0; console.log(`${logPrefix} Fetching employees...`); const empResult = await client.query('SELECT id, name, mo_hours, di_hours, mi_hours, do_hours, fr_hours FROM employees ORDER BY name'); const employees = empResult.rows; processedEmployees = employees.length; if (processedEmployees === 0) { await client.query('ROLLBACK'); console.warn(`${logPrefix} No employees found. Aborting generation.`); return res.status(404).json({ message: "Keine Mitarbeiter gefunden, für die Feiertage generiert werden könnten." }); } console.log(`${logPrefix} -> ${processedEmployees} employees found.`); console.log(`${logPrefix} Fetching public holidays for ${targetYear}...`); const holidaysOfYear = hd.getHolidays(targetYear); const publicHolidays = holidaysOfYear.filter(h => h.type === 'public'); console.log(`${logPrefix} -> ${publicHolidays.length} public holidays found.`); const insertQuery = ` INSERT INTO absences (employee_id, date, absence_type, credited_hours, comment) VALUES ($1, $2, 'PUBLIC_HOLIDAY', $3, $4) ON CONFLICT (employee_id, date) DO NOTHING; `; for (const holiday of publicHolidays) { const holidayDateString = holiday.date.split(' ')[0]; const holidayDate = new Date(holidayDateString + 'T00:00:00Z'); const dayOfWeek = holidayDate.getUTCDay(); if (dayOfWeek !== 0 && dayOfWeek !== 6) { for (const employee of employees) { const expectedHours = getExpectedHours(employee, holidayDateString); if (expectedHours > 0) { const result = await client.query(insertQuery, [ employee.id, holidayDateString, expectedHours, holiday.name ]); if (result.rowCount > 0) { generatedCount++; } else { skippedCount++; } } } } } await client.query('COMMIT'); console.log(`${logPrefix} Transaction committed. Generated: ${generatedCount}, Skipped: ${skippedCount}.`); res.status(200).json({ message: `Feiertage für ${targetYear} erfolgreich generiert/geprüft.`, generated: generatedCount, skipped: skippedCount, employees: processedEmployees }); } catch (err) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} !!! CRITICAL ERROR during holiday generation. Rolled back. Error: ${err.message}`, err.stack); next(err); } finally { if (client) client.release(); } });
app.delete('/admin/delete-public-holidays', isAdmin, async (req, res, next) => { /* ... unverändert ... */ try { const logPrefix = `[ROUTE:/admin/delete-public-holidays DELETE] Session: ${req.sessionID} -`; console.warn(`${logPrefix} !!! DELETE ALL PUBLIC HOLIDAY ENTRIES REQUEST RECEIVED !!!`); console.log(`${logPrefix} Deleting all entries with absence_type = 'PUBLIC_HOLIDAY' from DB...`); const result = await db.query(`DELETE FROM absences WHERE absence_type = 'PUBLIC_HOLIDAY'`); console.warn(`${logPrefix} Delete successful. ${result.rowCount} 'PUBLIC_HOLIDAY' entries deleted.`); res.status(200).json({ message: `Erfolgreich ${result.rowCount} Abwesenheitseinträge vom Typ 'Feiertag' gelöscht.` }); } catch (err) { const logPrefix = `[ROUTE:/admin/delete-public-holidays DELETE] Session: ${req.sessionID} -`; console.error(`${logPrefix} !!! CRITICAL ERROR during public holiday delete. Error: ${err.message}`, err.stack); next(err); } });


// --- PDF Router ---
try {
    if (typeof monthlyPdfRouter === 'function') {
        app.use('/api/pdf', monthlyPdfRouter(db));
    } else {
        console.error("!!! Fehler: monthlyPdfRouter ist keine Funktion.");
    }
} catch(routerError) {
    console.error("!!! Fehler beim Einbinden des PDF-Routers:", routerError);
}

// --- Global Error Handler ---
app.use((err, req, res, next) => { /* ... unverändert ... */ console.error("!!! UNHANDLED ERROR Caught by Global Handler !!!"); console.error(`Route: ${req.method} ${req.originalUrl}`); if (err instanceof Error) { console.error("Error Stack:", err.stack); } else { console.error("Error:", err); } if (!res.headersSent) { res.status(500).send('Ein unerwarteter interner Serverfehler ist aufgetreten.'); } else { next(err); } });

// --- Datenbank-Setup ausführen (parallel zum Server-Start) ---
setupTables()
  .then(() => { console.log('>>> Datenbank Setup erfolgreich abgeschlossen (nach Serverstart).'); })
  .catch((err) => { console.error('!!! FEHLER beim Ausführen von setupTables (nach Serverstart):', err); });

// --- Server Start (Sofort) ---
app.listen(port, () => { /* ... unverändert (wie in der letzten korrekten Version) ... */ console.log(`=======================================================`); console.log(` Server läuft auf Port ${port}`); console.log(` Node Environment: ${process.env.NODE_ENV || 'development'}`); console.log(` Admin-Login: ${process.env.ADMIN_PASSWORD ? 'AKTIVIERT' : 'DEAKTIVIERT (Passwort fehlt!)'}`); if(db && typeof db.options === 'object') { const host = process.env.PGHOST || db.options.host || '??'; const portNum = process.env.PGPORT || db.options.port || '??'; const database = process.env.PGDATABASE || db.options.database || '??'; console.log(` Datenbank verbunden (Pool erstellt): Host=${host}, Port=${portNum}, DB=${database}`); } else if (db) { console.warn("!!! DB Pool Objekt 'db' existiert, aber Status unklar."); } else { console.error("!!! KRITISCH: DB Pool ('db') konnte nicht initialisiert werden!"); } console.log(` Feiertagsmodul: DE / NW`); console.log(` CORS Origin: ${process.env.CORS_ORIGIN || '*'}`); console.log(` Frontend aus: '${path.join(__dirname, 'public')}'`); console.log(` Trust Proxy Setting: ${app.get('trust proxy')}`); let sessionCookieSecure = process.env.NODE_ENV === 'production'; let sessionCookieSameSite = 'lax'; try { if (app.settings && app.settings.session && typeof app.settings.session.cookie === 'object' && app.settings.session.cookie !== null) { if (app.settings.session.cookie.hasOwnProperty('secure')) { sessionCookieSecure = app.settings.session.cookie.secure; } if (app.settings.session.cookie.hasOwnProperty('sameSite')) { sessionCookieSameSite = app.settings.session.cookie.sameSite; } } } catch (e) { console.warn("Warnung: Konnte Session-Cookie-Details nicht vollständig lesen.", e.message); } console.log(` Session Cookie Settings: secure=${sessionCookieSecure}, sameSite='${sessionCookieSameSite}'`); console.log(`=======================================================`); });
