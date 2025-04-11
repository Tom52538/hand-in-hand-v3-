// routes/monthlyPdfEndpoint.js

const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();

// Importiere die Berechnungsfunktion aus der neuen Utility-Datei
// Der Pfad '../utils/calculationUtils' geht davon aus, dass diese Datei
// im Ordner 'routes' liegt und der Ordner 'utils' eine Ebene höher daneben ist.
const { calculateMonthlyData } = require('../utils/calculationUtils');

// Ändere den Export zu einer Factory-Funktion, die 'db' akzeptiert
module.exports = function(db) {

  // Admin-Check Middleware für diesen spezifischen Router (optional aber empfohlen)
  function isAdmin(req, res, next) {
    // Stelle sicher, dass die Session existiert und isAdmin gesetzt ist
    if (req.session && req.session.isAdmin === true) {
      next(); // Zugriff erlaubt
    } else {
      // Logge den fehlgeschlagenen Versuch für Debugging-Zwecke
      console.warn(`PDF Route: isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`);
      // Sende eine klare Fehlermeldung an den Client
      res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
    }
  }

  // Wende die isAdmin Middleware auf die PDF-Route an
  // Alle Anfragen an '/create-monthly-pdf' müssen jetzt zuerst die isAdmin Prüfung bestehen
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    const { name, year, month } = req.query;

    try {
      // Rufe die importierte Funktion auf und übergebe 'db'
      // Diese Funktion wirft Fehler, wenn etwas schiefgeht (z.B. Mitarbeiter nicht gefunden)
      const monthlyData = await calculateMonthlyData(db, name, year, month);

      // --- PDF-Erstellung beginnt ---
      const doc = new PDFDocument({
        margin: 50, // Seitenränder (oben, rechts, unten, links)
        size: 'A4' // Papierformat
      });

      // Dateinamen sicher erstellen (ersetzt ungültige Zeichen mit Unterstrich)
      const safeName = (monthlyData.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Monatsabschluss_${safeName}_${String(monthlyData.month).padStart(2,'0')}_${monthlyData.year}.pdf`;

      // Setze die HTTP-Header für den PDF-Download
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); // Dateiname in Anführungszeichen

      // Leite den PDF-Stream direkt in die HTTP-Antwort
      doc.pipe(res);

      // --- PDF Inhalt ---

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text(`Monatsabschluss für ${monthlyData.employeeName}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica').text(`Monat: ${String(monthlyData.month).padStart(2,'0')} / Jahr: ${monthlyData.year}`, { align: 'center' });
      doc.moveDown(2); // Mehr Abstand nach dem Header

      // Übertrag aus Vormonat
      doc.fontSize(12).text(`Übertrag aus Vormonat: ${monthlyData.previousCarryOver.toFixed(2)} Stunden`);
      doc.moveDown(1.5); // Abstand vor der Tabelle

      // Tabelle mit Tagesbuchungen
      doc.fontSize(14).font('Helvetica-Bold').text('Gebuchte Zeiten im Monat:', { underline: true });
      doc.moveDown(); // Abstand nach der Überschrift
      doc.font('Helvetica'); // Normale Schriftart für Tabelleninhalt

      // Definitionen für die Tabellenspalten
      const tableTop = doc.y;    // Start Y-Position für den Kopf
      const dateX = 50;          // Start X-Position der Tabelle
      const startX = 130;
      const endX = 190;
      const hoursX = 250;
      const commentX = 320;
      const tableWidth = 500;    // Gesamtbreite der relevanten Spalten

      // Tabellenkopf zeichnen
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 70 });
      doc.text('Beginn', startX, tableTop, { width: 50 });
      doc.text('Ende', endX, tableTop, { width: 50 });
      doc.text('Ist-Std.', hoursX, tableTop, { width: 60, align: 'right'}); // Rechtsbündig für Zahlen
      doc.text('Bemerkung', commentX, tableTop, { width: tableWidth - commentX + dateX }); // Restliche Breite
      doc.font('Helvetica'); // Normale Schriftart
      doc.moveDown(0.5); // Kleiner Abstand unter Kopftext

      // Linie unter Kopfzeile zeichnen
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY)
         .lineTo(dateX + tableWidth, headerLineY)
         .lineWidth(0.5) // Dicke der Linie
         .stroke(); // Linie zeichnen
      doc.moveDown(0.5); // Abstand zur ersten Datenzeile

      // Tabellenzeilen iterieren und zeichnen
      let totalHoursMonth = 0;
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y; // Aktuelle Y-Position für diese Zeile

            // Datum sicher formatieren (UTC-Datum aus DB als UTC interpretieren)
            const dateFormatted = buchung.date
                ? new Date(buchung.date.toISOString().split('T')[0] + 'T00:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC' })
                : 'n.a.';
            const hoursEntry = parseFloat(buchung.hours) || 0;
            totalHoursMonth += hoursEntry;

            // Zeileninhalt zeichnen (mit definierten Breiten)
            doc.fontSize(10).text(dateFormatted, dateX, y, { width: 70 });
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 50 });
            doc.text(buchung.endTime || 'n.a.', endX, y, { width: 50 });
            doc.text(hoursEntry.toFixed(2), hoursX, y, { width: 60, align: 'right'});
            // Kommentar: Erlaubt Zeilenumbruch, falls nötig
            doc.text(buchung.comment || '', commentX, y, {
                width: tableWidth - commentX + dateX, // Breite nutzen
                // ellipsis: true // Alternative: '...' statt Umbruch bei Überlänge
            });

            // Prüfen, ob ein Seitenumbruch nötig ist, bevor die nächste Zeile beginnt
            // (doc.y gibt die Position *nach* dem letzten Text an)
            if (doc.y > 720) { // Schwellenwert anpassen (ca. 720 für A4 mit Rändern)
                doc.addPage();
                // Optional: Kopfzeile auf neuer Seite wiederholen
                // (Hier nicht implementiert für Einfachheit)
            } else {
                 doc.moveDown(0.7); // Normaler Abstand zur nächsten Zeile
            }
        });
      } else {
         // Meldung, wenn keine Buchungen vorhanden sind
         doc.fontSize(10).text('Keine Buchungen in diesem Monat gefunden.', dateX, doc.y);
         doc.moveDown();
      }

      // Linie nach der letzten Tabellenzeile zeichnen
      const finalLineY = doc.y + 5; // Etwas Abstand
      doc.moveTo(dateX, finalLineY)
         .lineTo(dateX + tableWidth, finalLineY)
         .lineWidth(0.5)
         .stroke();
      doc.moveDown(); // Abstand nach der Linie

      // Gesamtsummen am Ende (rechtsbündig)
      const summaryAlignOptions = { width: tableWidth, align: 'right' };
      doc.fontSize(12).text(`Gesamtstunden im Monat: ${totalHoursMonth.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.moveDown(0.5);
      doc.text(`Monatliche Differenz (Ist - Soll): ${monthlyData.monthlyDifference.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.moveDown(1); // Mehr Abstand
      doc.fontSize(14).font('Helvetica-Bold'); // Wichtige Zahl hervorheben
      doc.text(`Neuer Übertrag für Folgemonat: ${monthlyData.newCarryOver.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.font('Helvetica'); // Schriftart zurücksetzen


      // --- Ende PDF Inhalt ---

      // PDF-Generierung abschließen und den Stream beenden.
      // Wichtig, damit die Datei vollständig gesendet wird.
      doc.end();

    } catch (error) {
      // Fehlerbehandlung, falls calculateMonthlyData oder PDF-Erstellung fehlschlägt
      console.error("Fehler beim Erstellen des PDFs:", error);
      // Sende spezifischere Fehlermeldung zum Client
      if (error.message === "Mitarbeiter nicht gefunden." || error.message.startsWith("Ungültiger Name")) {
         // 400 Bad Request für Client-Fehler (falsche Eingabe)
         res.status(400).send('Fehler beim Erstellen des PDFs: ' + error.message);
      } else {
         // 500 Internal Server Error für andere Fehler
         res.status(500).send('Serverfehler beim Erstellen des PDFs.');
      }
    }
  });

  // Geben Sie den konfigurierten Router zurück, damit er in server.js verwendet werden kann
  return router;
}; // Ende der Export-Factory-Funktion
