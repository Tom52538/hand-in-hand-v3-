// routes/monthlyPdfEndpoint.js

const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();

// Importiere die Berechnungsfunktion aus der Utility-Datei
const { calculateMonthlyData } = require('../utils/calculationUtils'); // Pfad prüfen!

// Exportiert eine Funktion, die 'db' akzeptiert und den Router zurückgibt
module.exports = function(db) {

  // Admin-Check Middleware
  function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
      next();
    } else {
      console.warn(`PDF Route: isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`);
      res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
    }
  }

  // PDF-Route mit Admin-Schutz
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    const { name, year, month } = req.query;

    try {
      // Daten für den Monat berechnen (inkl. 'expectedHours' pro Eintrag)
      const monthlyData = await calculateMonthlyData(db, name, year, month);

      // --- PDF-Erstellung beginnt ---
      const doc = new PDFDocument({ margin: 50, size: 'A4' });

      // Dateinamen sicher erstellen
      const safeName = (monthlyData.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Monatsabschluss_${safeName}_${String(monthlyData.month).padStart(2,'0')}_${monthlyData.year}.pdf`;

      // HTTP-Header setzen
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // PDF an Response streamen
      doc.pipe(res);

      // --- PDF Inhalt ---

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text(`Monatsabschluss für ${monthlyData.employeeName}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica').text(`Monat: ${String(monthlyData.month).padStart(2,'0')} / Jahr: ${monthlyData.year}`, { align: 'center' });
      doc.moveDown(2);

      // Übertrag Vormonat
      doc.fontSize(12).text(`Übertrag aus Vormonat: ${monthlyData.previousCarryOver.toFixed(2)} Stunden`);
      doc.moveDown(1.5);

      // Tabelle: Überschrift
      doc.fontSize(14).font('Helvetica-Bold').text('Gebuchte Zeiten im Monat:', { underline: true });
      doc.moveDown();
      doc.font('Helvetica');

      // Tabelle: Definitionen für Spaltenpositionen und -breiten ANPASSEN
      const tableTop = doc.y;
      const dateX = 50;       // Start X
      const startX = 145;     // Nach rechts für breiteres Datum
      const endX = 190;       // Nach rechts
      const sollX = 275;      // Nach rechts für breitere Endzeit
      const istX = 330;       // Nach rechts
      const commentX = 385;   // Nach rechts
      const tableWidth = 510; // Gesamtbreite von dateX bis Ende Kommentar (ca.)

      // Tabelle: Kopfzeile zeichnen (mit angepassten Breiten)
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 90 }); // Breite erhöht für Wochentag
      doc.text('Beginn', startX, tableTop, { width: 40 }); // Etwas schmaler
      doc.text('Ende', endX, tableTop, { width: 80 }); // Breite erhöht für "Buchung fehlt"
      doc.text('Soll-Std.', sollX, tableTop, { width: 50, align: 'right'});
      doc.text('Ist-Std.', istX, tableTop, { width: 50, align: 'right'});
      doc.text('Bemerkung', commentX, tableTop, { width: tableWidth - commentX + dateX }); // Restbreite
      doc.font('Helvetica');
      doc.moveDown(0.5);

      // Tabelle: Linie unter Kopfzeile
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY).lineTo(dateX + tableWidth, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Tabelle: Zeilen iterieren und zeichnen
      let totalIstHoursMonth = 0;
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y;

            // *** NEU: Datum mit Wochentag formatieren ***
            const dateFormatted = buchung.date
                ? new Date(buchung.date.toISOString().split('T')[0] + 'T00:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
                : 'n.a.';

            // Ist-Stunden holen und Summe bilden
            const hoursEntry = parseFloat(buchung.hours) || 0;
            totalIstHoursMonth += hoursEntry;

            // Endzeit-Anzeige
            const endTimeDisplay = buchung.endTime ? buchung.endTime : 'Buchung fehlt';
            // Soll-Stunden formatieren
            const expectedHoursDisplay = (buchung.expectedHours !== undefined ? buchung.expectedHours.toFixed(2) : 'N/A');

            // Zeileninhalt zeichnen (mit angepassten Positionen/Breiten)
            doc.fontSize(10).text(dateFormatted, dateX, y, { width: 90 }); // Angepasste Breite
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 40 });
            doc.text(endTimeDisplay, endX, y, { width: 80 }); // Angepasste Breite
            doc.text(expectedHoursDisplay, sollX, y, { width: 50, align: 'right'});
            doc.text(hoursEntry.toFixed(2), istX, y, { width: 50, align: 'right'});
            doc.text(buchung.comment || '', commentX, y, { width: tableWidth - commentX + dateX });

            // Seitenumbruch-Logik
            if (doc.y > 720) {
                doc.addPage();
                // Hier könnte man die Kopfzeile wiederholen, falls gewünscht
            } else {
                 doc.moveDown(0.7);
            }
        });
      } else {
         doc.fontSize(10).text('Keine Buchungen in diesem Monat gefunden.', dateX, doc.y);
         doc.moveDown();
      }
      // Tabelle: Linie nach letzter Zeile
      const finalLineY = doc.y + 5;
      doc.moveTo(dateX, finalLineY).lineTo(dateX + tableWidth, finalLineY).lineWidth(0.5).stroke();
      doc.moveDown();

      // Gesamtsummen (rechtsbündig)
      const summaryAlignOptions = { width: tableWidth, align: 'right' };
      doc.fontSize(12).text(`Gesamt Ist-Stunden im Monat: ${totalIstHoursMonth.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.moveDown(0.5);
      doc.text(`Monatliche Differenz (Ist - Soll): ${monthlyData.monthlyDifference.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.moveDown(1);
      doc.fontSize(14).font('Helvetica-Bold');
      doc.text(`Neuer Übertrag für Folgemonat: ${monthlyData.newCarryOver.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.font('Helvetica'); // Schriftart zurücksetzen


      // --- Ende PDF Inhalt ---

      // PDF-Generierung abschließen
      doc.end();

    } catch (error) {
      // Fehlerbehandlung
      console.error("Fehler beim Erstellen des PDFs:", error);
      if (error.message === "Mitarbeiter nicht gefunden." || error.message.startsWith("Ungültiger Name")) {
         res.status(400).send('Fehler beim Erstellen des PDFs: ' + error.message);
      } else {
         res.status(500).send('Serverfehler beim Erstellen des PDFs.');
      }
    }
  });

  // Router zurückgeben
  return router;
}; // Ende der Export-Factory-Funktion
