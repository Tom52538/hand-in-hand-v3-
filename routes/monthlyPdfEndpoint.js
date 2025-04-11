// routes/monthlyPdfEndpoint.js

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path'); // Node.js 'path' Modul für Dateipfade benötigt
const router = express.Router();

// Importiere die Berechnungsfunktion aus der Utility-Datei
const { calculateMonthlyData } = require('../utils/calculationUtils'); // Pfad prüfen!

// ==== Hilfsfunktion: Dezimalstunden in HH:MM Format ====
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
// ======================================================

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
      // Daten für den Monat berechnen
      const monthlyData = await calculateMonthlyData(db, name, year, month);
      const parsedYear = parseInt(year);
      const parsedMonth = parseInt(month);

      // --- PDF-Erstellung beginnt ---
      const doc = new PDFDocument({ margin: 50, size: 'A4' });

      // Dateinamen sicher erstellen
      const safeName = (monthlyData.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2,'0')}_${parsedYear}.pdf`;

      // HTTP-Header setzen
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // PDF an Response streamen
      doc.pipe(res);

      // --- PDF Inhalt ---

      // Konstanten für Positionierung etc.
      const leftMargin = doc.page.margins.left;
      const rightMargin = doc.page.margins.right;
      const topMargin = doc.page.margins.top;
      const bottomMarginPos = doc.page.height - doc.page.margins.bottom;
      const usableWidth = doc.page.width - leftMargin - rightMargin;

      // Logo Pfad definieren
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png'); // Kleinere Version für Skalierung

      // *** NEU: Logo oben rechts platzieren ***
      const logoWidth = 100; // Breite des Logos im PDF
      const logoX = doc.page.width - rightMargin - logoWidth;
      const logoY = topMargin; // Am oberen Rand ausrichten
      let initialY = topMargin; // Start Y-Position für Text

      try {
          doc.image(logoPath, logoX, logoY, {
              width: logoWidth // Feste Breite verwenden
          });
          // Berechne die Höhe des Logos nach dem Skalieren (optional, falls genaue Platzierung nötig)
          // const logoHeight = logoWidth * (originalLogoHeight / originalLogoWidth); // Benötigt Originalmaße
          // Setze die Startposition für den Text unter das Logo, falls es höher ist als der Standard-Margin
          initialY = Math.max(topMargin, logoY + 50); // Start 50pt unter Logo-Oberkante (anpassen!)
      } catch (imgErr) {
          console.error("Fehler beim Laden des PDF-Logos:", imgErr);
          initialY = topMargin; // Normal starten, wenn Logo fehlt
      }

      // Setze die Start Y-Position für den folgenden Text
      doc.y = initialY;

      // Header
      // Positioniere Elemente unterhalb des Logos, falls nötig
      doc.fontSize(18).font('Helvetica-Bold').text('Überstundennachweis', leftMargin, doc.y, { align: 'center', width: usableWidth });
      doc.moveDown(1.5);

      doc.fontSize(12).font('Helvetica');
      // *** GEÄNDERT: Label für Name ***
      doc.text(`Name: ${monthlyData.employeeName}`);
      doc.moveDown(0.5); // Weniger Abstand

      // Zeitraum berechnen
      const firstDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayFormatted = firstDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayFormatted = lastDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

      // *** GEÄNDERT: Zeitraum in einer Zeile ***
      doc.text(`Zeitraum: ${firstDayFormatted} - ${lastDayFormatted}`);
      doc.moveDown(2); // Abstand vor Tabelle

      // Tabelle: Definitionen für Spaltenpositionen und -breiten
      const tableTop = doc.y;
      const dateX = leftMargin;
      const startX = dateX + 110;
      const endX = startX + 60;
      const sollX = endX + 85;
      const istX = sollX + 70;
      const diffX = istX + 70;
      const tableRightEdge = doc.page.width - rightMargin;

      // Tabelle: Kopfzeile zeichnen
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 105, align: 'left' });
      doc.text('Arbeits-', startX, tableTop, { width: 55, align: 'center' }); // Zentriert für Lesbarkeit
      doc.text('beginn', startX, tableTop + 10, { width: 55, align: 'center' });
      doc.text('Arbeits-', endX, tableTop, { width: 80, align: 'center' }); // Zentriert
      doc.text('ende', endX, tableTop + 10, { width: 80, align: 'center' });
      doc.text('Soll-Zeit', sollX, tableTop, { width: 65, align: 'center' });
      doc.text('(HH:MM)', sollX, tableTop + 10, { width: 65, align: 'center' });
      doc.text('Ist-Zeit', istX, tableTop, { width: 65, align: 'center' });
      doc.text('(HH:MM)', istX, tableTop + 10, { width: 65, align: 'center' });
      doc.text('Mehr/-Minder', diffX, tableTop, { width: tableRightEdge - diffX, align: 'center' });
      doc.text('Std. (HH:MM)', diffX, tableTop + 10, { width: tableRightEdge - diffX, align: 'center' });
      doc.font('Helvetica');
      doc.moveDown(1.5);

      // Tabelle: Linie unter Kopfzeile
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY).lineTo(tableRightEdge, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Tabelle: Zeilen iterieren und zeichnen
      let totalIstHoursMonth = 0;
      let totalExpectedHoursMonth = 0;
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y;

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

            // Zeileninhalt zeichnen
            doc.fontSize(10).text(dateFormatted, dateX, y, { width: 105, align: 'left' });
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 55, align: 'center' });
            doc.text(endTimeDisplay, endX, y, { width: 80, align: 'center' }); // Breite angepasst
            doc.text(expectedHoursFormatted, sollX, y, { width: 65, align: 'center'});
            doc.text(istHoursFormatted, istX, y, { width: 65, align: 'center'});
            doc.text(dailyDifferenceFormatted, diffX, y, { width: tableRightEdge - diffX, align: 'center'});

            // Seitenumbruch-Logik
            if (doc.y > bottomMarginPos - 60) { // Etwas mehr Platz für Footer lassen
                doc.addPage();
                 // Optional: Logo auf neuer Seite wiederholen
                 try {
                      doc.image(logoPath, logoX, logoY, { width: logoWidth });
                 } catch(imgErr){ console.error("Logo auf Folgeseite fehlgeschlagen:", imgErr); }
                 // Optional: Kopfzeile der Tabelle wiederholen
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
      doc.moveTo(dateX, finalLineY).lineTo(tableRightEdge, finalLineY).lineWidth(0.5).stroke();
      doc.moveDown(1.5);

      // Zusammenfassung unter der Tabelle
      const summaryY = doc.y;
      const labelWidth = 150;
      const valueX = istX; // Werte unter Ist-Spalte ausrichten

      doc.font('Helvetica-Bold').text('Gesamt Soll-Zeit:', dateX, summaryY, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(totalExpectedHoursMonth), valueX, summaryY, { width: 65, align: 'center' });

      doc.moveDown(0.5);
      const summaryY2 = doc.y;
      doc.font('Helvetica-Bold').text('Gesamt Ist-Zeit:', dateX, summaryY2, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(totalIstHoursMonth), valueX, summaryY2, { width: 65, align: 'center' });

      doc.moveDown(0.5);
      const summaryY3 = doc.y;
      doc.font('Helvetica-Bold').text('Gesamt Mehr-/Minderstunden:', dateX, summaryY3, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(monthlyData.monthlyDifference), valueX, summaryY3, { width: 65, align: 'center' });
      doc.moveDown(3);

      // Bestätigungstext
      doc.fontSize(10).text('Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.', leftMargin, doc.y, { align: 'left', width: usableWidth });
      doc.moveDown(4);

      // Unterschriftslinie
      const signatureY = doc.y;
       // Linie nur unter dem Textbereich, nicht bis ganz rechts
      doc.moveTo(leftMargin + usableWidth / 2, signatureY)
         .lineTo(leftMargin + usableWidth, signatureY) // Ende am rechten Rand des Textbereichs
         .lineWidth(0.5)
         .stroke();
      doc.moveDown(0.5);
      doc.fontSize(10).text('Datum, Unterschrift', leftMargin + usableWidth / 2, doc.y, { width: usableWidth / 2, align: 'center'});

      // *** Logo wurde nach oben verschoben ***
      // *** Fußzeile wird hier nicht mehr explizit hinzugefügt ***
      // (Das Logo ist jetzt im Header-Bereich)


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
