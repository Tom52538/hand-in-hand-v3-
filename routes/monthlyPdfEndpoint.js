const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();

// Importieren Sie die Berechnungsfunktion aus server.js
// Der Pfad '../server' geht davon aus, dass diese Datei in einem 'routes' Ordner liegt
// und server.js eine Ebene höher ist. Passen Sie den Pfad ggf. an.
const { calculateMonthlyData } = require('../server');

// Ändern Sie den Export zu einer Factory-Funktion, die 'db' akzeptiert
module.exports = function(db) {

  // Admin-Check Middleware für diesen spezifischen Router (optional aber empfohlen)
  function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
      next();
    } else {
      console.warn(`PDF Route: isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`);
      res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
    }
  }

  // Wenden Sie die isAdmin Middleware auf die PDF-Route an
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    const { name, year, month } = req.query;

    try {
      // Rufen Sie die importierte Funktion auf und übergeben Sie 'db'
      // Diese Funktion wirft Fehler, wenn etwas schiefgeht (z.B. Mitarbeiter nicht gefunden)
      const monthlyData = await calculateMonthlyData(db, name, year, month);

      // PDF-Dokument erstellen
      const doc = new PDFDocument({ margin: 50 }); // Ränder definieren

      // Dateinamen sicher erstellen (ersetzt ungültige Zeichen)
      const safeName = (monthlyData.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Monatsabschluss_${safeName}_${String(monthlyData.month).padStart(2,'0')}_${monthlyData.year}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); // In Anführungszeichen setzen
      doc.pipe(res); // PDF an den Response streamen

      // --- PDF Inhalt ---

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text(`Monatsabschluss für ${monthlyData.employeeName}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica').text(`Monat: ${String(monthlyData.month).padStart(2,'0')} / Jahr: ${monthlyData.year}`, { align: 'center' });
      doc.moveDown(2);

      // Übertrag aus Vormonat
      doc.fontSize(12).text(`Übertrag aus Vormonat: ${monthlyData.previousCarryOver.toFixed(2)} Stunden`);
      doc.moveDown(1.5);

      // Tabelle mit Tagesbuchungen
      doc.fontSize(14).font('Helvetica-Bold').text('Gebuchte Zeiten im Monat:', { underline: true });
      doc.moveDown();
      doc.font('Helvetica'); // Zurück zur normalen Schriftart

      // Tabellenkopf zeichnen
      const tableTop = doc.y;
      const dateX = 50;       // Start X-Position
      const startX = 130;
      const endX = 190;
      const hoursX = 250;
      const commentX = 320;
      const tableWidth = 500; // Gesamtbreite von links nach rechts bis Kommentar-Ende

      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 70 });
      doc.text('Beginn', startX, tableTop, { width: 50 });
      doc.text('Ende', endX, tableTop, { width: 50 });
      doc.text('Ist-Std.', hoursX, tableTop, { width: 60, align: 'right'}); // Rechtsbündig für Zahlen
      doc.text('Bemerkung', commentX, tableTop, { width: tableWidth - commentX + dateX }); // Restliche Breite
      doc.font('Helvetica'); // Zurück zur normalen Schriftart
      doc.moveDown(0.5); // Kleiner Abstand

      // Linie unter Kopfzeile
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY).lineTo(dateX + tableWidth, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Tabellenzeilen iterieren
      let totalHoursMonth = 0;
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y;
            // Datum sicher formatieren (UTC-Datum aus DB interpretieren)
            const dateFormatted = buchung.date ? new Date(buchung.date.toISOString().split('T')[0] + 'T00:00:00Z').toLocaleDateString('de-DE') : 'n.a.';
            const hoursEntry = parseFloat(buchung.hours) || 0;
            totalHoursMonth += hoursEntry;

            // Zeileninhalt zeichnen
            doc.fontSize(10).text(dateFormatted, dateX, y, { width: 70 });
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 50 });
            doc.text(buchung.endTime || 'n.a.', endX, y, { width: 50 });
            doc.text(hoursEntry.toFixed(2), hoursX, y, { width: 60, align: 'right'});
            // Kommentar mit Zeilenumbruch, falls nötig
            doc.text(buchung.comment || '', commentX, y, {
                width: tableWidth - commentX + dateX,
                // ellipsis: true // Optional: '...' wenn zu lang, statt Umbruch
            });

            // Linie unter jeder Zeile (optional)
            // const lineY = doc.y + 2; // Etwas unterhalb des Textes
            // doc.moveTo(dateX, lineY).lineTo(dateX + tableWidth, lineY).lineWidth(0.2).strokeColor('grey').stroke();
            // doc.strokeColor('black'); // Farbe zurücksetzen

             // Sicherstellen, dass genug Platz für die nächste Zeile ist, ggf. neue Seite
            if (doc.y > 700) { // Beispiel: Wenn unterhalb von Position 700
                doc.addPage();
                // Kopfzeile auf neuer Seite wiederholen (optional)
            } else {
                 doc.moveDown(0.7); // Abstand zwischen Zeilen
            }
        });
      } else {
         doc.fontSize(10).text('Keine Buchungen in diesem Monat gefunden.', dateX, doc.y);
         doc.moveDown();
      }


      // Linie nach der Tabelle
      const finalLineY = doc.y + 5;
      doc.moveTo(dateX, finalLineY).lineTo(dateX + tableWidth, finalLineY).lineWidth(0.5).stroke();
      doc.moveDown();

      // Gesamtsummen (rechtsbündig)
      const summaryX = dateX + tableWidth; // Rechte Kante der Tabelle
      doc.fontSize(12).text(`Gesamtstunden im Monat: ${totalHoursMonth.toFixed(2)} Std.`, dateX, doc.y, { width: tableWidth, align: 'right'});
      doc.moveDown(0.5);
      doc.text(`Monatliche Differenz (Ist - Soll): ${monthlyData.monthlyDifference.toFixed(2)} Std.`, dateX, doc.y, { width: tableWidth, align: 'right'});
      doc.moveDown(1);
      doc.fontSize(14).font('Helvetica-Bold');
      doc.text(`Neuer Übertrag für Folgemonat: ${monthlyData.newCarryOver.toFixed(2)} Std.`, dateX, doc.y, { width: tableWidth, align: 'right'});
      doc.font('Helvetica'); // Schriftart zurücksetzen


      // --- Ende PDF Inhalt ---

      doc.end(); // PDF-Generierung abschließen und Stream beenden

    } catch (error) {
      console.error("Fehler beim Erstellen des PDFs:", error);
      // Sende spezifischere Fehlermeldung zum Client
      if (error.message === "Mitarbeiter nicht gefunden." || error.message.startsWith("Ungültiger Name")) {
         res.status(400).send('Fehler beim Erstellen des PDFs: ' + error.message);
      } else {
         res.status(500).send('Serverfehler beim Erstellen des PDFs.');
      }
    }
  });

  // Geben Sie den konfigurierten Router zurück
  return router;
}; // Ende der Export-Factory-Funktion
