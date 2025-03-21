// Migration von SQLite nach PostgreSQL

const fs = require('fs');
const { Pool } = require('pg');

let sqlite3, sqliteDb;
if (fs.existsSync('./work_hours.db')) {
    sqlite3 = require('sqlite3').verbose();
    sqliteDb = new sqlite3.Database('./work_hours.db');
    console.log("✅ SQLite-Datenbank gefunden, Migration wird gestartet...");
} else {
    console.log("⚠️ Keine SQLite-Datenbank gefunden. Migration überspringen.");
}

// Verbinde mit PostgreSQL
const pgDb = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Funktion zur Migration der work_hours-Tabelle
async function migrateWorkHours() {
    if (!sqliteDb) return;  // Falls SQLite nicht existiert, nichts tun
    console.log("🔄 Migration der Arbeitszeiten läuft...");

    const workHoursQuery = `SELECT * FROM work_hours`;

    sqliteDb.all(workHoursQuery, async (err, rows) => {
        if (err) {
            console.error("❌ Fehler beim Lesen von SQLite:", err);
            return;
        }

        for (const row of rows) {
            try {
                await pgDb.query(
                    `INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [row.name, row.date, row.hours, row.break_time, row.comment, row.startTime, row.endTime]
                );
            } catch (error) {
                console.error("⚠️ Fehler beim Einfügen in PostgreSQL:", error);
            }
        }

        console.log("✅ Migration der Arbeitszeiten abgeschlossen!");
    });
}

// Funktion zur Migration der employees-Tabelle
async function migrateEmployees() {
    if (!sqliteDb) return;  // Falls SQLite nicht existiert, nichts tun
    console.log("🔄 Migration der Mitarbeiter läuft...");

    const employeesQuery = `SELECT * FROM employees`;

    sqliteDb.all(employeesQuery, async (err, rows) => {
        if (err) {
            console.error("❌ Fehler beim Lesen von SQLite:", err);
            return;
        }

        for (const row of rows) {
            try {
                await pgDb.query(
                    `INSERT INTO employees (name, contract_hours, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [row.name, row.contract_hours, row.mo_hours, row.di_hours, row.mi_hours, row.do_hours, row.fr_hours]
                );
            } catch (error) {
                console.error("⚠️ Fehler beim Einfügen in PostgreSQL:", error);
            }
        }

        console.log("✅ Migration der Mitarbeiter abgeschlossen!");
    });
}

// Starte die Migration
async function startMigration() {
    console.log("🚀 Starte Migration...");
    await migrateWorkHours();
    await migrateEmployees();
    if (sqliteDb) sqliteDb.close();  // SQLite sauber schließen, falls verwendet
    console.log("🎉 Migration abgeschlossen!");
}

startMigration();
