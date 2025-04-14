// Laden der Umgebungsvariablen aus der .env-Datei
require('dotenv').config();

// Benötigte Module importieren
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const app = express();
const cors = require("cors");

// Importiere NUR die ausgelagerten Berechnungsfunktionen (falls vorhanden)
// Stelle sicher, dass die Datei utils/calculationUtils.js existiert!
const { calculateMonthlyData, getExpectedHours } = require('./utils/calculationUtils');

// --- HILFSFUNKTIONEN (wieder hier integriert) ---
function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  // Einfache Differenz, ignoriert Mitternacht aktuell
  const diffInMin = endMinutes - startMinutes;
  if (diffInMin < 0) {
      console.warn(`Negative Arbeitszeit berechnet (${startTime} - ${endTime}). Eventuell über Mitternacht?`);
  }
  return diffInMin / 60;
}

function convertToCSV(data) {
    if (!data || data.length === 0) return '';
    const csvRows = [];
    // Kopfzeile anpassen (Soll-Std. werden jetzt korrekt aus getExpectedHours geholt)
    const headers = ["Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Soll-Std", "Ist-Std", "Differenz", "Bemerkung"];
    csvRows.push(headers.join(','));

    for (const row of data) {
        let dateFormatted = "";
        if (row.date) {
            try {
                const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
                const year = dateObj.getUTCFullYear();
                const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getUTCDate()).padStart(2, '0');
                dateFormatted = `${day}.${month}.${year}`;
            } catch (e) { dateFormatted = String(row.date); console.error("CSV Datumsformat Fehler:", e)}
        }

        // Annahme: row.starttime und row.endtime sind bereits HH:MI Strings oder null
        const startTimeFormatted = row.starttime || "";
        const endTimeFormatted = row.endtime || "";
        const istHours = row.hours || 0;
        let expected = 0;

        // Soll-Stunden holen (benötigt getExpectedHours und employee Daten in 'row')
        if (typeof getExpectedHours === 'function' && row.date) {
             try {
                 // Stelle sicher, dass das Datum im Format YYYY-MM-DD übergeben wird
                 const dateString = (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date).split('T')[0];
                 // row muss die Felder mo_hours, di_hours etc. enthalten (kommen aus dem JOIN in /admin-download-csv)
                 expected = getExpectedHours(row, dateString);
             } catch (e) { console.error("Fehler beim Holen der Soll-Stunden für CSV:", e); }
        }

        const diff = istHours - expected;
        const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`; // Maskiert Anführungszeichen im Kommentar

        const values = [
            row.name, dateFormatted, startTimeFormatted, endTimeFormatted,
            expected.toFixed(2), istHours.toFixed(2), diff.toFixed(2), commentFormatted
        ];
        csvRows.push(values.join(','));
    }
    return csvRows.join('\n');
}
// --- ENDE HILFSFUNKTIONEN ---


app.use(cors({
  origin: "*", // Für Entwicklung, in Produktion spezifischer!
  credentials: true
}));

app.set('trust proxy', 1);
const port = process.env.PORT || 8080;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// PostgreSQL-Datenbank
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Session Store
const sessionStore = new pgSession({
  pool: db, tableName: 'user_sessions', createTableIfMissing: true,
});
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'fallback-geheimnis',
  resave: false, saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true, maxAge: 24 * 60 * 60 * 1000
  },
}));

// --- Datenbank Tabellen Setup ---
const setupTables = async () => {
  try {
    // work_hours Tabelle
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_hours (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, date DATE NOT NULL,
        hours DOUBLE PRECISION, comment TEXT, starttime TIME, endtime TIME
      );`);
    console.log("Tabelle work_hours geprüft/erstellt.");
    // employees Tabelle
    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        mo_hours DOUBLE PRECISION, di_hours DOUBLE PRECISION, mi_hours DOUBLE PRECISION,
        do_hours DOUBLE PRECISION, fr_hours DOUBLE PRECISION
      );`);
    console.log("Tabelle employees geprüft/erstellt.");
    // monthly_balance Tabelle
    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_balance (
        id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        year_month DATE NOT NULL, difference DOUBLE PRECISION, carry_over DOUBLE PRECISION,
        UNIQUE (employee_id, year_month)
      );`);
    console.log("Tabelle monthly_balance geprüft/erstellt.");
  } catch (err) {
    console.error("!!! DB Setup Fehler:", err); process.exit(1);
  }
};

// --- Middleware für Admin-Check ---
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) next();
  else res.status(403).send('Zugriff verweigert.');
}

// ==========================================
// Health Check Endpunkt
// ==========================================
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ==========================================
// API Endpunkte für Zeiterfassung
// ==========================================

// Liefert Status für nächsten Button-Klick + Details für offenen Eintrag
app.get('/next-booking-details', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).send('Name ist erforderlich.');
    try {
        const query = `SELECT id, date, TO_CHAR(starttime, 'HH24:MI') AS starttime_formatted, endtime
                       FROM work_hours WHERE LOWER(name) = LOWER($1)
                       ORDER BY date DESC, starttime DESC NULLS LAST LIMIT 1;`;
        const result = await db.query(query, [name]);
        let nextBooking = 'arbeitsbeginn', entryId = null, startDate = null, startTime = null;
        if (result.rows.length > 0) {
            const last = result.rows[0];
            if (!last.endtime && last.starttime_formatted) { // Offener Eintrag
                nextBooking = 'arbeitsende'; entryId = last.id;
                startDate = last.date.toISOString().split('T')[0]; // YYYY-MM-DD
                startTime = last.starttime_formatted; // HH:MI
            }
        }
        res.json({ nextBooking, id: entryId, startDate, startTime });
    } catch (err) {
        console.error("Fehler /next-booking-details:", err);
        res.status(500).json({ message: 'Serverfehler beim Prüfen des Status.' });
    }
});

// Buchung Arbeitsbeginn
app.post('/log-start', async (req, res) => {
    const { name, date, startTime } = req.body;
    if (!name || !date || !startTime) return res.status(400).json({ message: 'Fehlende Daten.' });
    try {
        // Prüfen auf offenen Eintrag am selben Tag
        const check = await db.query(`SELECT id FROM work_hours WHERE LOWER(name)=LOWER($1) AND date=$2 AND endtime IS NULL`, [name, date]);
        if (check.rows.length > 0) return res.status(409).json({ message: `Es existiert bereits ein offener Eintrag (ID: ${check.rows[0].id}).` });
        // Einfügen
        const insert = await db.query(`INSERT INTO work_hours (name, date, starttime) VALUES ($1, $2, $3) RETURNING id;`, [name, date, startTime]);
        console.log(`Start gebucht: ${name}, ${date}, ${startTime} (ID: ${insert.rows[0].id})`);
        res.status(201).json({ id: insert.rows[0].id }); // Wichtig: ID zurückgeben
    } catch (err) {
        console.error("Fehler /log-start:", err);
        res.status(500).json({ message: 'Serverfehler beim Buchen des Starts.' });
    }
});

// Buchung Arbeitsende
app.put('/log-end/:id', async (req, res) => {
    const { id } = req.params;
    const { endTime, comment } = req.body;
    if (!endTime || !id || isNaN(parseInt(id))) return res.status(400).json({ message: 'Fehlende oder ungültige Daten.' });
    const entryId = parseInt(id);
    try {
        // Startzeit holen für Stundenberechnung
        const startResult = await db.query('SELECT starttime, endtime FROM work_hours WHERE id = $1', [entryId]);
        if (startResult.rows.length === 0) return res.status(404).json({ message: `Eintrag ID ${entryId} nicht gefunden.` });
        if (startResult.rows[0].endtime) console.warn(`Überschreibe vorhandene Endzeit für ID ${entryId}.`);
        const startTime = startResult.rows[0].starttime;
        if (!startTime) return res.status(400).json({ message: 'Keine Startzeit für Berechnung gefunden.' });

        // Stunden berechnen (jetzt lokale Funktion)
        const netHours = calculateWorkHours(startTime, endTime); // Keine Pausen aktuell
        if (netHours < 0) console.warn(`Negative Arbeitszeit (${netHours}h) für ID ${entryId} berechnet (${startTime}-${endTime}).`);

        // Update
        await db.query(`UPDATE work_hours SET endtime = $1, comment = $2, hours = $3 WHERE id = $4;`,
                       [endTime, comment || '', netHours, entryId]);
        console.log(`Ende gebucht: ID ${entryId}, ${endTime} (Stunden: ${netHours.toFixed(2)})`);
        res.status(200).send('Arbeitsende erfolgreich gespeichert.');
    } catch (err) {
        console.error(`Fehler /log-end/${entryId}:`, err);
        res.status(500).json({ message: 'Serverfehler beim Buchen des Endes.' });
    }
});

// Endpunkt für Tages-/Monatszusammenfassung
app.get('/summary-hours', async (req, res) => {
    const { name, date } = req.query; // date im Format YYYY-MM-DD
    if (!name || !date) return res.status(400).json({ message: 'Name und Datum erforderlich.' });
    try {
        // Tagesstunden
        const dailyResult = await db.query(
            `SELECT hours FROM work_hours WHERE LOWER(name) = LOWER($1) AND date = $2 AND hours IS NOT NULL ORDER BY endtime DESC LIMIT 1`,
            [name, date]
        );
        const dailyHours = dailyResult.rows.length > 0 ? dailyResult.rows[0].hours : 0;
        // Monatsstunden
        const yearMonth = date.substring(0, 7); // 'YYYY-MM'
        const firstDayOfMonth = `${yearMonth}-01`;
        const nextMonthDate = new Date(date); nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1, 1); nextMonthDate.setUTCDate(nextMonthDate.getUTCDate() - 1);
        const lastDayOfMonth = nextMonthDate.toISOString().split('T')[0];
        const monthlyResult = await db.query(
             `SELECT SUM(hours) AS total_hours FROM work_hours
              WHERE LOWER(name) = LOWER($1) AND date >= $2 AND date <= $3 AND hours IS NOT NULL`,
              [name, firstDayOfMonth, lastDayOfMonth]
        );
        const monthlyHours = monthlyResult.rows.length > 0 && monthlyResult.rows[0].total_hours ? monthlyResult.rows[0].total_hours : 0;
        console.log(`Zusammenfassung ${name}: Tag ${date}=${dailyHours.toFixed(2)}h, Monat ${yearMonth}=${monthlyHours.toFixed(2)}h`);
        res.json({ dailyHours, monthlyHours });
    } catch (err) {
        console.error(`Fehler /summary-hours (${name}, ${date}):`, err);
        res.status(500).json({ message: 'Serverfehler bei Zusammenfassung.' });
    }
});

// Mitarbeiterliste für Dropdown (öffentlich)
app.get('/employees', (req, res) => {
  db.query('SELECT id, name FROM employees ORDER BY name ASC')
    .then(result => res.json(result.rows))
    .catch(err => { console.error("DB Fehler GET /employees:", err); res.status(500).send('Fehler.'); });
});

// --------------------------
// Admin-Login und geschützte Endpunkte
// --------------------------
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "admin";
  if (!password) return res.status(400).send("Passwort fehlt.");
  if (password === adminPassword) {
    req.session.regenerate((err) => {
        if(err) { console.error("Session Regenerate Fehler:", err); return res.status(500).send("Session Fehler."); }
        req.session.isAdmin = true;
        req.session.save((saveErr) => {
          if (saveErr) { console.error("Session Save Fehler:", saveErr); return res.status(500).send("Session Fehler."); }
          console.log("Admin angemeldet."); res.status(200).send("Admin angemeldet.");
        });
    });
  } else { res.status(401).send("Ungültiges Passwort."); }
});

// Admin: Alle Arbeitszeiten holen
app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = `SELECT id, name, date, hours, comment,
                 TO_CHAR(starttime, 'HH24:MI') AS "startTime", TO_CHAR(endtime, 'HH24:MI') AS "endTime"
                 FROM work_hours ORDER BY date DESC, name ASC, starttime ASC;`;
  db.query(query)
    .then(result => res.json(result.rows))
    .catch(err => { console.error("DB Fehler GET /admin-work-hours:", err); res.status(500).send('Fehler.'); });
});

// Admin: CSV Download
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  const query = `SELECT w.*, e.mo_hours, e.di_hours, e.mi_hours, e.do_hours, e.fr_hours
                 FROM work_hours w LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
                 ORDER BY w.date ASC, w.name ASC, w.starttime ASC;`;
  try {
    const result = await db.query(query);
    const csv = convertToCSV(result.rows); // Lokale Funktion nutzen
    const filename = `arbeitszeiten_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(csv, 'utf-8')])); // BOM für Excel
  } catch (err) { console.error("DB Fehler GET /admin-download-csv:", err); res.status(500).send('Fehler.'); }
});

// Admin: Arbeitszeit aktualisieren
app.put('/api/admin/update-hours', isAdmin, (req, res) => {
    const { id, name, date, startTime, endTime, comment } = req.body;
    if (isNaN(parseInt(id)) || !name || !date || !startTime || !endTime) return res.status(400).send('Ungültige/fehlende Daten.');
    // Stunden neu berechnen (lokale Funktion)
    const netHours = calculateWorkHours(startTime, endTime);
    const query = `UPDATE work_hours SET name = $1, date = $2, hours = $3, comment = $4, starttime = $5, endtime = $6
                   WHERE id = $7;`;
    db.query(query, [name, date, netHours, comment, startTime, endTime, parseInt(id)])
        .then(result => {
            if (result.rowCount > 0) { console.log(`Admin Update ID ${id}.`); res.send('Aktualisiert.'); }
            else res.status(404).send(`ID ${id} nicht gefunden.`);
        })
        .catch(err => { console.error("DB Fehler PUT /api/admin/update-hours:", err); res.status(500).send('Fehler.'); });
});

// Admin: Arbeitszeit löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
    const { id } = req.params; if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
    db.query('DELETE FROM work_hours WHERE id = $1', [parseInt(id)])
        .then(result => {
            if (result.rowCount > 0) { console.log(`Admin Delete ID ${id}.`); res.send('Gelöscht.'); }
            else res.status(404).send(`ID ${id} nicht gefunden.`);
        })
        .catch(err => { console.error("DB Fehler DELETE /api/admin/delete-hours:", err); res.status(500).send('Fehler.'); });
});

// Admin: ALLE Arbeitszeiten löschen
app.delete('/adminDeleteData', isAdmin, async (req, res) => {
    try { await db.query('DELETE FROM work_hours'); console.log("!!! Admin hat ALLE Arbeitszeiten gelöscht !!!"); res.send('Alle Zeiten gelöscht.'); }
    catch (err) { console.error("DB Fehler /adminDeleteData:", err); res.status(500).send('Fehler.'); }
});

// Admin: Mitarbeiter holen
app.get('/admin/employees', isAdmin, (req, res) => {
    db.query('SELECT * FROM employees ORDER BY name ASC')
        .then(result => res.json(result.rows))
        .catch(err => { console.error("DB Fehler GET /admin/employees:", err); res.status(500).send('Fehler.'); });
});

// Admin: Mitarbeiter hinzufügen
app.post('/admin/employees', isAdmin, (req, res) => {
    const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
    if (!name || name.trim() === '') return res.status(400).send('Name fehlt.');
    const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || null);
    const query = `INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                   VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING RETURNING *;`;
    db.query(query, [name.trim(), ...hours])
        .then(result => {
            if (result.rows.length > 0) { console.log(`Admin Add MA: ${name.trim()}`); res.status(201).json(result.rows[0]); }
            else res.status(409).send(`Name '${name.trim()}' existiert bereits.`);
        })
        .catch(err => { console.error("DB Fehler POST /admin/employees:", err); res.status(500).send('Fehler.'); });
});

// Admin: Mitarbeiter aktualisieren
app.put('/admin/employees/:id', isAdmin, (req, res) => {
    const { id } = req.params; const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
    if (isNaN(parseInt(id)) || !name || name.trim() === '') return res.status(400).send('Ungültige/fehlende Daten.');
    const hours = [mo_hours, di_hours, mi_hours, do_hours, fr_hours].map(h => parseFloat(h) || null);
    const query = `UPDATE employees SET name = $1, mo_hours = $2, di_hours = $3, mi_hours = $4, do_hours = $5, fr_hours = $6 WHERE id = $7;`;
    db.query(query, [name.trim(), ...hours, parseInt(id)])
        .then(result => {
            if (result.rowCount > 0) { console.log(`Admin Update MA ID ${id}.`); res.send('Aktualisiert.'); }
            else res.status(404).send(`ID ${id} nicht gefunden.`);
        })
        .catch(err => {
            if (err.code === '23505') res.status(409).send(`Name '${name.trim()}' existiert bereits.`);
            else { console.error("DB Fehler PUT /admin/employees:", err); res.status(500).send('Fehler.'); }
        });
});

// Admin: Mitarbeiter löschen
app.delete('/admin/employees/:id', isAdmin, async (req, res) => {
    const { id } = req.params; if (isNaN(parseInt(id))) return res.status(400).send('Ungültige ID.');
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query('DELETE FROM employees WHERE id = $1', [parseInt(id)]);
        await client.query('COMMIT');
        if (result.rowCount > 0) { console.log(`Admin Delete MA ID ${id}.`); res.send('Gelöscht.'); }
        else res.status(404).send(`ID ${id} nicht gefunden.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DB Fehler DELETE /admin/employees:", err); res.status(500).send('Fehler.');
    } finally { client.release(); }
});

// Admin: Monatsauswertung berechnen/holen (nutzt ausgelagerte Logik)
app.get('/calculate-monthly-balance', isAdmin, async (req, res) => {
    const { name, year, month } = req.query;
    try {
        const result = await calculateMonthlyData(db, name, year, month); // calculateMonthlyData muss existieren!
        console.log(`Admin Monatsauswertung: ${result.employeeName || name} (${month}/${year}).`);
        res.json({ message: `Saldo berechnet/gespeichert.`, ...result });
    } catch (error) {
        console.error(`Fehler /calculate-monthly-balance (${name}, ${month}/${year}):`, error);
        if (error.message.includes("gefunden")) res.status(404).send(error.message);
        else if (error.message.startsWith("Ungültige")) res.status(400).send(error.message);
        else res.status(500).send("Serverfehler.");
    }
});

// PDF Endpunkt (benötigt monthlyPdfEndpoint.js und pdfkit etc.)
try {
    const monthlyPdfEndpointFactory = require('./routes/monthlyPdfEndpoint');
    app.use('/', monthlyPdfEndpointFactory(db));
} catch (e) {
    console.warn("PDF Endpunkt konnte nicht geladen werden.", e.message);
}

// --- Server starten und Graceful Shutdown ---
async function startServer() {
  try {
    await setupTables(); console.log("DB Setup ok.");
    if (!process.env.DATABASE_URL) console.warn("WARNUNG: DATABASE_URL fehlt.");
    if (!process.env.SESSION_SECRET) console.warn("WARNUNG: SESSION_SECRET fehlt.");
    if (!process.env.ADMIN_PASSWORD) console.warn("WARNUNG: ADMIN_PASSWORD fehlt.");
    if (process.env.NODE_ENV !== 'production') console.warn("WARNUNG: Läuft nicht im Produktionsmodus.");

    const server = app.listen(port, '0.0.0.0', () => console.log(`Server läuft auf Port ${port}`));
    const gracefulShutdown = async (signal) => {
      console.log(`Shutdown (${signal})...`); server.close(async (err) => {
        if (err) console.error("Server schließen Fehler:", err); else console.log("Server geschlossen.");
        try { await db.end(); console.log("DB Pool geschlossen."); process.exit(0); }
        catch (dbErr) { console.error("DB Pool schließen Fehler:", dbErr); process.exit(1); }
      });
      setTimeout(() => { console.error("Shutdown Timeout!"); process.exit(1); }, 10000);
    };
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) { console.error("!!! Server Start Fehler:", error); process.exit(1); }
}
startServer();
