// routes/monthlyPdfEndpoint.js

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere die Berechnungsfunktion
const { calculateMonthlyData } = require('../utils/calculationUtils');

// Hilfsfunktion: Dezimalstunden in HH:MM Format
function decimalHoursToHHMM(decimalHours) {
    if (isNaN(decimalHours)) {
        return "00:00";
    }
    const sign = decimalHours < 0 ? "-" : "";
    const absHours = Math.abs(decimalHours);
    const totalMinutes = Math.round(absHours * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

module.exports = function(db) {

  function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
      next();
    } else {
      console.warn(`PDF Route: isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`);
      res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
    }
  }

  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    const { name, year, month } = req.query;

    try {
      const monthlyData = await calculateMonthlyData(db, name, year, month);
      const parsedYear = parseInt(year);
      const parsedMonth = parseInt(month);

      const doc = new PDFDocument({ margin: 40, size: 'A4' }); // *** Margin leicht reduziert (war 50) ***

      const safeName = (monthlyData.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2,'0')}_${parsedYear}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      doc.pipe(res);

      // Konstanten für Positionierung
      const leftMargin = doc.page.margins.left;
      const rightMargin = doc.page.margins.right;
      const topMargin = doc.page.margins.top;
      const bottomMarginPos = doc.page.height - doc.page.margins.bottom;
      const usableWidth = doc.page.width - leftMargin - rightMargin;

      // Logo Pfad
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');

      // Logo oben rechts platzieren
      const logoWidth = 90; // Etwas kleiner für weniger Dominanz
      const logoX = doc.page.width - rightMargin - logoWidth;
      const logoY = topMargin - 10; // *** ETWAS HÖHER starten, ragt in den oberen Rand ***
      let initialY = topMargin; // Start Y für Text

      try {
          doc.image(logoPath, logoX, logoY, {
              width: logoWidth
          });
          // *** Start des Textes näher am oberen Rand, kleinerer Abstand zum Logo ***
          initialY = Math.max(topMargin, logoY + logoWidth * 0.3 + 15); // Geschätzte Höhe + kleiner Puffer
      } catch (imgErr) {
          console.error("Fehler beim Laden des PDF-Logos:", imgErr);
          initialY = topMargin;
      }

      doc.y = initialY; // Setze Startposition

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text('Überstundennachweis', leftMargin, doc.y, { align: 'center', width: usableWidth - logoWidth - 10 }); // Breite anpassen, um Logo nicht zu überlappen
      doc.moveDown(1.2); // Weniger Abstand

      doc.fontSize(11).font('Helvetica'); // Kleinere Schrift für Header-Infos
      doc.text(`Name: ${monthlyData.employeeName}`);
      doc.moveDown(0.4);

      // Zeitraum
      const firstDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayFormatted = firstDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayFormatted = lastDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      doc.text(`Zeitraum: ${firstDayFormatted} - ${lastDayFormatted}`);
      doc.moveDown(1.5); // Abstand vor Tabelle

      // Tabelle: Definitionen für Spaltenpositionen und -breiten
      const tableTop = doc.y;
      const dateX = leftMargin;
      const startX = dateX + 105; // Weniger Platz für Datum, da Schrift kleiner
      const endX = startX + 55;
      const sollX = endX + 80;
      const istX = sollX + 65;
      const diffX = istX + 65;
      const tableRightEdge = doc.page.width - rightMargin;

      // Tabelle: Kopfzeile zeichnen (Schriftgröße bleibt 10pt fett)
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 100, align: 'left' });
      doc.text('Arbeits-', startX, tableTop, { width: 50, align: 'center' });
      doc.text('beginn', startX, tableTop + 10, { width: 50, align: 'center' });
      doc.text('Arbeits-', endX, tableTop, { width: 75, align: 'center' });
      doc.text('ende', endX, tableTop + 10, { width: 75, align: 'center' });
      doc.text('Soll-Zeit', sollX, tableTop, { width: 60, align: 'center' });
      doc.text('(HH:MM)', sollX, tableTop + 10, { width: 60, align: 'center' });
      doc.text('Ist-Zeit', istX, tableTop, { width: 60, align: 'center' });
      doc.text('(HH:MM)', istX, tableTop + 10, { width: 60, align: 'center' });
      doc.text('Mehr/-Minder', diffX, tableTop, { width: tableRightEdge - diffX, align: 'center' });
      doc.text('Std. (HH:MM)', diffX, tableTop + 10, { width: tableRightEdge - diffX, align: 'center' });
      doc.font('Helvetica');
      doc.moveDown(1.2); // Weniger Abstand

      // Tabelle: Linie unter Kopfzeile
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY).lineTo(tableRightEdge, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.4); // Weniger Abstand

      // Tabelle: Zeilen iterieren und zeichnen
      let totalIstHoursMonth = 0;
      let totalExpectedHoursMonth = 0;
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {

        // *** SCHRIFTGRÖSSE FÜR TABELLENINHALT REDUZIEREN ***
        doc.fontSize(9);
        // *** ZEILENABSTAND REDUZIEREN ***
        doc.lineGap(-1); // Negativer Wert rückt Zeilen näher zusammen

        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y; // Aktuelle Y-Position merken

            // Datum mit Wochentag formatieren
            const dateFormatted = buchung.date
                ? new Date(buchung.date.toISOString().split('T')[0] + 'T00:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
                : 'n.a.';

            // Stunden holen und Summen bilden
            const hoursEntry = parseFloat(buchung.hours) || 0;
            totalIstHoursMonth += hoursEntry;
            const expectedHours = parseFloat(buchung.expectedHours) || 0;
            totalExpectedHoursMonth += expectedHours;

            // Texte formatieren
            const endTimeDisplay = buchung.endTime ? buchung.endTime : 'Buchung fehlt';
            const expectedHoursFormatted = decimalHoursToHHMM(expectedHours);
            const istHoursFormatted = decimalHoursToHHMM(hoursEntry);
            const dailyDifference = hoursEntry - expectedHours;
            const dailyDifferenceFormatted = decimalHoursToHHMM(dailyDifference);

            // Zeileninhalt zeichnen (mit kleinerer Schrift)
            // (Breiten bleiben wie beim Header definiert)
            doc.text(dateFormatted, dateX, y, { width: 100, align: 'left' });
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 50, align: 'center' });
            doc.text(endTimeDisplay, endX, y, { width: 75, align: 'center' });
            doc.text(expectedHoursFormatted, sollX, y, { width: 60, align: 'center'});
            doc.text(istHoursFormatted, istX, y, { width: 60, align: 'center'});
            doc.text(dailyDifferenceFormatted, diffX, y, { width: tableRightEdge - diffX, align: 'center'});

            // Seitenumbruch-Logik
            if (doc.y > bottomMarginPos - 50) { // Genug Platz für Footer lassen
                doc.addPage({margins: { top: 40, bottom: 40, left: 40, right: 40}}); // Neue Seite mit gleichen Rändern
                 // Logo wiederholen
                 try {
                      doc.image(logoPath, logoX, logoY, { width: logoWidth });
                 } catch(imgErr){ console.error("Logo auf Folgeseite fehlgeschlagen:", imgErr); }
                 // Kopfzeile wiederholen (optional, hier nicht implementiert)
                 doc.y = topMargin + 20; // Y-Position auf neuer Seite setzen
                 // Schriftgröße zurücksetzen auf 9pt für Tabelleninhalt
                 doc.fontSize(9).lineGap(-1);
            } else {
                 doc.moveDown(0.5); // *** Kleinerer Abstand zwischen den Zeilen ***
            }
        });

        // *** Schriftgröße und Zeilenabstand nach der Tabelle zurücksetzen ***
        doc.fontSize(10).lineGap(0); // Zurück zu normalem Abstand und Standardgröße für Folgetext

      } else {
         doc.fontSize(10).text('Keine Buchungen in diesem Monat gefunden.', dateX, doc.y);
         doc.moveDown();
      }
    // Tabelle: Linie nach letzter Zeile
      const finalLineY = doc.y + 2; // Näher an die letzte Zeile
      doc.moveTo(dateX, finalLineY).lineTo(tableRightEdge, finalLineY).lineWidth(0.5).stroke();
      doc.moveDown(1.0); // Weniger Abstand

      // Zusammenfassung unter der Tabelle (Schriftgröße 10pt)
      const summaryY = doc.y;
      const labelWidth = 150;
      const valueX = istX;

      doc.fontSize(10).font('Helvetica-Bold').text('Gesamt Soll-Zeit:', dateX, summaryY, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(totalExpectedHoursMonth), valueX, summaryY, { width: 65, align: 'center' });

      doc.moveDown(0.3); // Weniger Abstand
      const summaryY2 = doc.y;
      doc.font('Helvetica-Bold').text('Gesamt Ist-Zeit:', dateX, summaryY2, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(totalIstHoursMonth), valueX, summaryY2, { width: 65, align: 'center' });

      doc.moveDown(0.3); // Weniger Abstand
      const summaryY3 = doc.y;
      doc.font('Helvetica-Bold').text('Gesamt Mehr-/Minderstunden:', dateX, summaryY3, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(monthlyData.monthlyDifference), valueX, summaryY3, { width: 65, align: 'center' });
      doc.moveDown(2); // Weniger Abstand

      // Bestätigungstext (Schriftgröße 9pt)
      doc.fontSize(9).text('Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.', leftMargin, doc.y, { align: 'left', width: usableWidth });
      doc.moveDown(3); // Weniger Platz

      // Unterschriftslinie
      const signatureY = doc.y;
      doc.moveTo(leftMargin + usableWidth / 2, signatureY)
         .lineTo(leftMargin + usableWidth, signatureY)
         .lineWidth(0.5)
         .stroke();
      doc.moveDown(0.4); // Weniger Abstand
      doc.fontSize(9).text('Datum, Unterschrift', leftMargin + usableWidth / 2, doc.y, { width: usableWidth / 2, align: 'center'});


      // --- Ende PDF Inhalt ---
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
};
