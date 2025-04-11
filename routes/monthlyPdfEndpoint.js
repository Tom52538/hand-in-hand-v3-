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

      // Tabelle: Definitionen für Spaltenpositionen und -breiten anpassen
      const tableTop = doc.y;
      const dateX = 50;       // Start X
      const startX = 120;     // Nach rechts verschoben
      const endX = 170;       // Nach rechts verschoben
      const sollX = 230;      // NEUE Spalte Soll-Std.
      const istX = 290;       // Nach rechts verschoben
      const commentX = 360;   // Nach rechts verschoben
      // Gesamtbreite der Tabelle bis zum Ende des Kommentars
      const tableWidth = 510; // Ggf. anpassen, wenn Kommentar mehr Platz braucht

      // Tabelle: Kopfzeile zeichnen
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 60 }); // Weniger Breite für Datum
      doc.text('Beginn', startX, tableTop, { width: 45 }); // Weniger Breite
      doc.text('Ende', endX, tableTop, { width: 55 }); // Mehr Breite für "Buchung fehlt"
      doc.text('Soll-Std.', sollX, tableTop, { width: 50, align: 'right'}); // NEU
      doc.text('Ist-Std.', istX, tableTop, { width: 50, align: 'right'}); // Shifted X
      doc.text('Bemerkung', commentX, tableTop, { width: tableWidth - commentX + dateX }); // Restbreite
      doc.font('Helvetica');
      doc.moveDown(0.5);

      // Tabelle: Linie unter Kopfzeile
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY).lineTo(dateX + tableWidth, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Tabelle: Zeilen iterieren und zeichnen
      let totalIstHoursMonth = 0; // Umbenannt zur Klarheit
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y;

            // Datum formatieren
            const dateFormatted = buchung.date
                ? new Date(buchung.date.toISOString().split('T')[0] + 'T00:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC' })
                : 'n.a.';
            // Ist-Stunden holen und Summe bilden
            const hoursEntry = parseFloat(buchung.hours) || 0;
            totalIstHoursMonth += hoursEntry;

            // *** NEU: Endzeit-Anzeige anpassen ***
            const endTimeDisplay = buchung.endTime ? buchung.endTime : 'Buchung fehlt';
            // *** NEU: Soll-Stunden formatieren ***
            const expectedHoursDisplay = (buchung.expectedHours !== undefined ? buchung.expectedHours.toFixed(2) : 'N/A');

            // Zeileninhalt zeichnen (mit angepassten Positionen/Breiten)
            doc.fontSize(10).text(dateFormatted, dateX, y, { width: 60 });
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 45 });
            doc.text(endTimeDisplay, endX, y, { width: 55 }); // Angepasster Text + Breite
            doc.text(expectedHoursDisplay, sollX, y, { width: 50, align: 'right'}); // NEUE Spalte
            doc.text(hoursEntry.toFixed(2), istX, y, { width: 50, align: 'right'}); // Angepasste Position
            doc.text(buchung.comment || '', commentX, y, { width: tableWidth - commentX + dateX });

            // Seitenumbruch-Logik (optional, aber empfohlen)
            if (doc.y > 720) {
                doc.addPage();
                // Optional: Kopfzeile wiederholen
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
      // Gesamt-Ist-Stunden anzeigen (war vorher schon da)
      doc.fontSize(12).text(`Gesamt Ist-Stunden im Monat: ${totalIstHoursMonth.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.moveDown(0.5);
      // Monatliche Differenz (war vorher schon da)
      doc.text(`Monatliche Differenz (Ist - Soll): ${monthlyData.monthlyDifference.toFixed(2)} Std.`, dateX, doc.y, summaryAlignOptions);
      doc.moveDown(1);
      // Neuer Übertrag (war vorher schon da)
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
