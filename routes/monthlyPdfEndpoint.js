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
        return "00:00"; // Oder "N/A"
    }
    const sign = decimalHours < 0 ? "-" : "";
    const absHours = Math.abs(decimalHours);
    const totalMinutes = Math.round(absHours * 60); // Auf ganze Minuten runden
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
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2,'0')}_${parsedYear}.pdf`; // Angepasster Name

      // HTTP-Header setzen
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // PDF an Response streamen
      doc.pipe(res);

      // --- PDF Inhalt ---

      // Konstanten für Positionierung etc.
      const leftMargin = doc.page.margins.left;
      const rightMargin = doc.page.margins.right;
      const usableWidth = doc.page.width - leftMargin - rightMargin;
      const bottomMarginPos = doc.page.height - doc.page.margins.bottom;

      // Logo Pfad definieren (angenommen, Server läuft im Projekt-Root)
      // Wähle eine Logo-Größe aus
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');


      // Header
      doc.fontSize(18).font('Helvetica-Bold').text('Überstundennachweis', { align: 'center' });
      doc.moveDown(1.5);

      doc.fontSize(12).font('Helvetica');
      doc.text(`Name des Mitarbeiters: ${monthlyData.employeeName}`);
      doc.moveDown();

      // Zeitraum berechnen (Erster und Letzter des Monats)
      const firstDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth, 0)); // Tag 0 des Folgemonats = letzter Tag des aktuellen Monats
      const firstDayFormatted = firstDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayFormatted = lastDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

      doc.text('Zeitraum von bis'); // Überschrift für Zeitraum
      doc.text(firstDayFormatted);  // Startdatum
      doc.text(lastDayFormatted);   // Enddatum
      doc.moveDown(2);

      // Tabelle: Definitionen für Spaltenpositionen und -breiten
      const tableTop = doc.y;
      const dateX = leftMargin;        // Start linksbündig
      const startX = dateX + 110;      // Breite für Datum+Wochentag ca. 110
      const endX = startX + 60;        // Breite für Beginn ca. 60
      const sollX = endX + 85;         // Breite für Ende ca. 85 (für "Buchung fehlt")
      const istX = sollX + 70;         // Breite für Soll-Zeit ca. 70
      const diffX = istX + 70;         // Breite für Ist-Zeit ca. 70
      // Die letzte Spalte (Differenz) braucht den Rest bis zum rechten Rand
      const tableRightEdge = doc.page.width - rightMargin;

      // Tabelle: Kopfzeile zeichnen
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Datum', dateX, tableTop, { width: 105, align: 'left' }); // Mehr Breite
      doc.text('Arbeits-', startX, tableTop, { width: 55, align: 'left' });
      doc.text('beginn', startX, tableTop + 10, { width: 55, align: 'left' }); // Zweizeilig
      doc.text('Arbeits-', endX, tableTop, { width: 80, align: 'left' });
      doc.text('ende', endX, tableTop + 10, { width: 80, align: 'left' }); // Zweizeilig
      doc.text('Soll-Zeit', sollX, tableTop, { width: 65, align: 'center' }); // Zentriert
      doc.text('(HH:MM)', sollX, tableTop + 10, { width: 65, align: 'center' });
      doc.text('Ist-Zeit', istX, tableTop, { width: 65, align: 'center' }); // Zentriert
      doc.text('(HH:MM)', istX, tableTop + 10, { width: 65, align: 'center' });
      doc.text('Mehr/-Minder', diffX, tableTop, { width: tableRightEdge - diffX, align: 'center' }); // Restbreite, Zentriert
      doc.text('Std. (HH:MM)', diffX, tableTop + 10, { width: tableRightEdge - diffX, align: 'center' });
      doc.font('Helvetica');
      doc.moveDown(1.5); // Mehr Abstand nach zweizeiligem Kopf

      // Tabelle: Linie unter Kopfzeile
      const headerLineY = doc.y;
      doc.moveTo(dateX, headerLineY).lineTo(tableRightEdge, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Tabelle: Zeilen iterieren und zeichnen
      let totalIstHoursMonth = 0;
      let totalExpectedHoursMonth = 0; // Auch Soll-Summe berechnen
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        monthlyData.workEntries.forEach((buchung) => {
            const y = doc.y;

            // Datum mit Wochentag formatieren
            const dateFormatted = buchung.date
                ? new Date(buchung.date.toISOString().split('T')[0] + 'T00:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
                : 'n.a.';

            // Ist-Stunden holen und Summe bilden
            const hoursEntry = parseFloat(buchung.hours) || 0;
            totalIstHoursMonth += hoursEntry;
            // Soll-Stunden holen und Summe bilden
            const expectedHours = parseFloat(buchung.expectedHours) || 0;
            totalExpectedHoursMonth += expectedHours;

            // Endzeit-Anzeige anpassen
            const endTimeDisplay = buchung.endTime ? buchung.endTime : 'Buchung fehlt';
            // Soll-Stunden formatieren
            const expectedHoursFormatted = decimalHoursToHHMM(expectedHours);
            // Ist-Stunden formatieren
            const istHoursFormatted = decimalHoursToHHMM(hoursEntry);
            // Tägliche Differenz berechnen und formatieren
            const dailyDifference = hoursEntry - expectedHours;
            const dailyDifferenceFormatted = decimalHoursToHHMM(dailyDifference);

            // Zeileninhalt zeichnen (mit angepassten Positionen/Breiten)
            doc.fontSize(10).text(dateFormatted, dateX, y, { width: 105, align: 'left' });
            doc.text(buchung.startTime || 'n.a.', startX, y, { width: 55, align: 'center' });
            doc.text(endTimeDisplay, endX, y, { width: 80, align: 'center' });
            doc.text(expectedHoursFormatted, sollX, y, { width: 65, align: 'center'});
            doc.text(istHoursFormatted, istX, y, { width: 65, align: 'center'});
            doc.text(dailyDifferenceFormatted, diffX, y, { width: tableRightEdge - diffX, align: 'center'}); // Tägliche Differenz

            // Seitenumbruch-Logik
            if (doc.y > bottomMarginPos - 80) { // Mehr Platz für Fußzeile lassen
                doc.addPage();
                // Hier könnte man die Kopfzeile wiederholen
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
      doc.moveDown(1.5); // Mehr Abstand

      // Zusammenfassung unter der Tabelle (angepasst an Zieldayout)
      const summaryY = doc.y;
      const labelWidth = 150; // Breite für die Beschriftungen
      const valueX = istX; // Werte unter Ist-Spalte ausrichten

      doc.font('Helvetica-Bold').text('Gesamt Soll-Zeit:', dateX, summaryY, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(totalExpectedHoursMonth), valueX, summaryY, { width: 65, align: 'center' });

      doc.moveDown(0.5);
      const summaryY2 = doc.y;
      doc.font('Helvetica-Bold').text('Gesamt Ist-Zeit:', dateX, summaryY2, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(totalIstHoursMonth), valueX, summaryY2, { width: 65, align: 'center' });

      doc.moveDown(0.5);
      const summaryY3 = doc.y;
      // Gesamtdifferenz aus monthlyData nehmen (ist bereits Ist-Soll)
      doc.font('Helvetica-Bold').text('Gesamt Mehr-/Minderstunden:', dateX, summaryY3, { width: labelWidth, align: 'left' });
      doc.font('Helvetica').text(decimalHoursToHHMM(monthlyData.monthlyDifference), valueX, summaryY3, { width: 65, align: 'center' });
      doc.moveDown(3); // Viel Abstand vor Bestätigungstext

      // Bestätigungstext
      doc.fontSize(10).text('Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.', leftMargin, doc.y, { align: 'left', width: usableWidth });
      doc.moveDown(4); // Platz für Unterschrift

      // Unterschriftslinie
      const signatureY = doc.y;
      doc.moveTo(leftMargin + usableWidth / 2, signatureY) // Startet in der Mitte
         .lineTo(tableRightEdge, signatureY) // Bis zum rechten Rand
         .lineWidth(0.5)
         .stroke();
      doc.moveDown(0.5);
      doc.fontSize(10).text('Datum, Unterschrift', leftMargin + usableWidth / 2, doc.y, { width: usableWidth / 2, align: 'center'});

      // Logo und Fußzeile (Positionieren relativ zum Seitenende)
      const footerY = bottomMarginPos - 30; // Etwas über dem unteren Rand
      // Prüfen, ob die Unterschrift schon zu weit unten ist
      if (doc.y > footerY - 20) { // Wenn nicht mehr genug Platz ist
          doc.addPage(); // Neue Seite für Footer/Logo
          // Optional Kopfzeile wiederholen
      }

      // Logo einfügen (Fehler abfangen, falls Datei nicht da)
      try {
          doc.image(logoPath, {
              fit: [80, 30], // Maximale Breite/Höhe des Logos
              align: 'right' // Rechtsbündig relativ zur verfügbaren Breite
              // x: tableRightEdge - 80, // Alternative: Absolute Positionierung
              // y: footerY
          });
      } catch (imgErr) {
          console.error("Fehler beim Laden des PDF-Logos:", imgErr);
          // Fallback: Nur Text anzeigen, wenn Logo nicht geladen werden kann
          doc.fontSize(8).fillColor('grey').text('Physiotherapie Hand in Hand', leftMargin, footerY + 10, { align: 'right' });
      }


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
