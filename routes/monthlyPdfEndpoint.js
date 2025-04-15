const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere die Berechnungsfunktion aus calculationUtils.js
const { calculateMonthlyData } = require('../utils/calculationUtils');

/**
 * Hilfsfunktion: Wandelt Dezimalstunden in ein HH:MM-Format um.
 * Behandelt auch negative Werte korrekt.
 */
function decimalHoursToHHMM(decimalHours) {
  if (isNaN(decimalHours) || decimalHours === null) {
    return "00:00"; // Fallback für ungültige Werte
  }
  const sign = decimalHours < 0 ? "-" : "";
  const absHours = Math.abs(decimalHours);
  // Runde auf die nächste Minute, um Rundungsfehler bei der Summierung zu minimieren
  const totalMinutes = Math.round(absHours * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Middleware: Prüft, ob eine Admin-Session vorliegt.
 */
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    next();
  } else {
    console.warn(
      `PDF Route: isAdmin-Check fehlgeschlagen: Session ID: ${req.sessionID}, ` +
      `isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`
    );
    res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
  }
}

module.exports = function(db) {
  /**
   * GET-Endpunkt /create-monthly-pdf:
   * Erzeugt eine PDF-Datei mit dem gewünschten Layout.
   */
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    try {
      const { name, year, month } = req.query;
      if (!name || !year || !month) {
        return res.status(400).send("Name, Jahr und Monat erforderlich.");
      }

      // Monatsdaten berechnen (Ihre Logik)
      const monthlyData = await calculateMonthlyData(db, name, year, month);
      const {
        employeeName,
        previousCarryOver,
        totalExpected,
        totalActual,
        newCarryOver,
        workEntries // Enthält jetzt { date, startTime, endTime, hours, expectedHours }
      } = monthlyData;
      const parsedYear = parseInt(year, 10);
      const parsedMonth = parseInt(month, 10);

      // PDF-Dokument erstellen und vorbereiten
      const doc = new PDFDocument({
        margin: 40, // Standard-Rand
        size: 'A4'
       });
      const safeName = (employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      // --- Layout Konstanten ---
      const pageTopMargin = doc.page.margins.top; // ca. 40
      const pageLeftMargin = doc.page.margins.left; // ca. 40
      const pageRightMargin = doc.page.margins.right; // ca. 40
      const pageBottomMargin = doc.page.margins.bottom; // ca. 40
      const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin; // ca. 515

      // Schriftarten
      const fontNormal = 'Helvetica';
      const fontBold = 'Helvetica-Bold';

      // Schriftgrößen
      const fontSizeHeader = 16;
      const fontSizeSubHeader = 11;
      const fontSizeTableHeader = 9;
      const fontSizeTableContent = 9; // Gleiche Größe für Konsistenz
      const fontSizeSummary = 10;
      const fontSizeFooter = 9;

      // Vertikale Abstände
      const vSpaceSmall = 5;
      const vSpaceMedium = 15;
      const vSpaceLarge = 25;
      const vSpaceXLarge = 40;
      const tableRowHeight = 14; // Höhe einer Tabellenzeile

      //-------------------------------
      // Kopfzeile
      //-------------------------------
      let currentY = pageTopMargin;

      // Logo (rechts oben)
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png'); // Pfad anpassen falls nötig
      const logoWidth = 60; // Etwas kleiner für mehr Platz
      const logoHeight = 60;
      const logoX = doc.page.width - pageRightMargin - logoWidth;
      const logoY = currentY; // Am oberen Rand ausrichten
      try {
        doc.image(logoPath, logoX, logoY, { width: logoWidth, height: logoHeight });
      } catch (errLogo) {
        console.warn("Logo konnte nicht geladen werden:", errLogo);
      }

      // Titel (zentriert, etwas unterhalb des oberen Rands)
      doc.font(fontBold).fontSize(fontSizeHeader);
      doc.text("Überstundennachweis", pageLeftMargin, currentY + vSpaceSmall, { // Etwas Platz nach oben
        align: 'center',
        width: usableWidth
      });
      currentY = Math.max(currentY + fontSizeHeader + vSpaceSmall, logoY + logoHeight); // Höhe an Logo oder Titel anpassen
      currentY += vSpaceMedium; // Abstand nach dem Titel

      // Name und Zeitraum (linksbündig)
      doc.font(fontNormal).fontSize(fontSizeSubHeader);
      doc.text(`Name: ${employeeName}`, pageLeftMargin, currentY);
      currentY += fontSizeSubHeader + vSpaceSmall; // Zeilenhöhe + kleiner Abstand

      const firstDay = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDay = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayStr = firstDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayStr = lastDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      doc.text(`Zeitraum: ${firstDayStr} - ${lastDayStr}`, pageLeftMargin, currentY);
      currentY += fontSizeSubHeader + vSpaceLarge; // Größerer Abstand zur Tabelle

      //-------------------------------
      // Tabelle
      //-------------------------------
      const tableStartY = currentY;

      // Spaltenbreiten neu definieren, um Überlappung zu vermeiden (Summe <= usableWidth)
      // Beispielhafte Verteilung - muss ggf. noch feinjustiert werden
      const colWidths = {
          date: 115,       // Mehr Platz für Wochentag + Datum
          start: 75,      // Arbeitsbeginn
          end: 75,        // Arbeitsende
          expected: 85,   // Soll-Zeit (HH:MM)
          actual: 85,     // Ist-Zeit (HH:MM)
          diff: usableWidth - 115 - 75 - 75 - 85 - 85 // Rest für Mehr/Minder Std. (ca. 80)
      };

      // X-Koordinaten der Spalten berechnen
      const colPositions = {
          date: pageLeftMargin,
          start: pageLeftMargin + colWidths.date,
          end: pageLeftMargin + colWidths.date + colWidths.start,
          expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
          actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
          diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
      };

      // --- Tabellenkopf ---
      doc.font(fontBold).fontSize(fontSizeTableHeader);
      const headerY = currentY;
      const headerTextY = headerY + vSpaceSmall / 2; // Text leicht nach unten verschieben für Zentrierung in der gedachten Zeile
      doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
      doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' }); // \n für Zeilenumbruch im Header
      doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
      doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
      doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
      doc.text("Mehr/Minder\nStd. (HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });

      // Höhe des Kopfes berücksichtigen (ca. 2 Zeilen + Abstand)
      currentY += (fontSizeTableHeader * 2) + vSpaceSmall;
      const headerLineY = currentY;
      doc.moveTo(pageLeftMargin, headerLineY)
         .lineTo(pageLeftMargin + usableWidth, headerLineY)
         .lineWidth(0.5)
         .stroke();
      currentY += vSpaceSmall; // Kleiner Abstand nach der Linie

      // --- Tabelleninhalt ---
      doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(1); // Etwas Zeilenabstand
      const contentStartY = currentY;

      if (!workEntries || workEntries.length === 0) {
        doc.text('Keine Arbeitszeitbuchungen in diesem Monat gefunden.', pageLeftMargin, currentY, {width: usableWidth});
        currentY += tableRowHeight;
      } else {
        for (let i = 0; i < workEntries.length; i++) {
          const entry = workEntries[i];
          const rowY = contentStartY + (i * tableRowHeight); // Berechne Y für jede Zeile

           // Seitenumbruch prüfen VOR dem Zeichnen der Zeile
           if (rowY + tableRowHeight > doc.page.height - pageBottomMargin) {
             doc.addPage();
             currentY = pageTopMargin; // Y-Position zurücksetzen

             // Tabellenkopf auf neuer Seite wiederholen
             doc.font(fontBold).fontSize(fontSizeTableHeader);
             const newHeaderY = currentY;
             const newHeaderTextY = newHeaderY + vSpaceSmall / 2;
             doc.text("Datum", colPositions.date, newHeaderTextY, { width: colWidths.date, align: 'left' });
             doc.text("Arbeits-\nbeginn", colPositions.start, newHeaderTextY, { width: colWidths.start, align: 'center' });
             doc.text("Arbeits-\nende", colPositions.end, newHeaderTextY, { width: colWidths.end, align: 'center' });
             doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, newHeaderTextY, { width: colWidths.expected, align: 'center' });
             doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, newHeaderTextY, { width: colWidths.actual, align: 'center' });
             doc.text("Mehr/Minder\nStd. (HH:MM)", colPositions.diff, newHeaderTextY, { width: colWidths.diff, align: 'center' });
             currentY += (fontSizeTableHeader * 2) + vSpaceSmall;
             const newHeaderLineY = currentY;
             doc.moveTo(pageLeftMargin, newHeaderLineY)
                .lineTo(pageLeftMargin + usableWidth, newHeaderLineY)
                .lineWidth(0.5)
                .stroke();
             currentY += vSpaceSmall;

             // Wichtig: contentStartY für die neue Seite anpassen und Index zurücksetzen/anpassen
             // Da wir 'i' weiterlaufen lassen, müssen wir die Start-Y-Position für die Zeilen neu setzen
             // und die aktuelle 'currentY' als neue Basis nehmen.
             // Effektiv setzen wir doc.y auf die neue Startposition für den Inhalt.
             doc.y = currentY;
             doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(1); // Font/Größe wiederherstellen
             // Wir verwenden jetzt doc.y für die Zeilenpositionierung auf der neuen Seite
           }

          // --- Daten für die Zeile ---
          let dateFormatted = "Ungült. Datum";
          if (entry.date) {
              try {
                  // Stelle sicher, dass das Datum als UTC behandelt wird, um Zeitzonenprobleme zu vermeiden
                  const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date).split('T')[0];
                  const dateObj = new Date(dateStr + "T00:00:00Z");
                  if (!isNaN(dateObj.getTime())) { // Prüfen ob das Datum gültig ist
                      dateFormatted = dateObj.toLocaleDateString('de-DE', {
                          weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
                      });
                      // Füge den Punkt nach dem Wochentag hinzu, falls nicht vorhanden (Browser-abhängig)
                      if (dateFormatted.includes(',') && !dateFormatted.includes('.,')) {
                          dateFormatted = dateFormatted.replace(',', '.,');
                      }
                  }
              } catch (e) {
                  console.error("Fehler beim Formatieren des Datums für PDF:", entry.date, e);
                  dateFormatted = String(entry.date); // Fallback auf rohen String
              }
          }

          const startDisplay = entry.startTime || "--:--";
          const endDisplay = entry.endTime || "--:--";
          // Verwende die bereits berechneten Werte aus monthlyData
          const expected = parseFloat(entry.expectedHours) || 0;
          const worked = parseFloat(entry.hours) || 0;
          const diff = worked - expected;

          const expectedStr = decimalHoursToHHMM(expected);
          const workedStr = decimalHoursToHHMM(worked);
          const diffStr = decimalHoursToHHMM(diff);

          // --- Zeile zeichnen (verwende doc.y) ---
          const currentRowY = doc.y; // Aktuelle Y-Position merken
          doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
          doc.text(startDisplay, colPositions.start, currentRowY, { width: colWidths.start, align: 'center', lineBreak: false });
          doc.text(endDisplay, colPositions.end, currentRowY, { width: colWidths.end, align: 'center', lineBreak: false });
          doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'center', lineBreak: false });
          doc.text(workedStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'center', lineBreak: false });
          doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'center', lineBreak: false });

          // Y-Position für die nächste Zeile erhöhen
          doc.y += tableRowHeight;
          currentY = doc.y; // Synchronisiere currentY mit doc.y
        }
      }
      // Finale Y-Position nach der Tabelle
      currentY = doc.y;
      currentY += vSpaceLarge; // Abstand nach der Tabelle

      //-------------------------------
      // Zusammenfassung
      //-------------------------------
      // Sicherstellen, dass genug Platz für die Zusammenfassung ist, ggf. neue Seite
       if (currentY + (4 * (fontSizeSummary + vSpaceSmall)) > doc.page.height - pageBottomMargin - (fontSizeFooter + vSpaceXLarge)) {
           doc.addPage();
           currentY = pageTopMargin;
       }
       doc.y = currentY; // Setze doc.y auf die Startposition der Zusammenfassung

       doc.font(fontBold).fontSize(fontSizeSummary);
       // Verwende einen Teil der Tabellenbreite für Labels und Werte
       const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - vSpaceSmall; // Breite für Labels
       const summaryValueWidth = colWidths.actual + colWidths.diff; // Breite für Werte
       const summaryLabelX = pageLeftMargin;
       const summaryValueX = colPositions.actual; // Werte rechtsbündig in den letzten Spalten

       doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5); // Kleinerer Abstand zwischen den Zeilen

       doc.text("Gesamt Soll-Zeit:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       doc.text("Gesamt Ist-Zeit:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       const totalDiff = (totalActual || 0) - (totalExpected || 0); // Diff für den Monat
       doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       // Ggf. noch den neuen Gesamtübertrag anzeigen
       doc.font(fontBold); // Wichtige Zahl hervorheben
       doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

       currentY = doc.y + vSpaceLarge; // Abstand nach der Zusammenfassung

      //-------------------------------
      // Fußzeile (Bestätigung, Unterschrift)
      //-------------------------------
       // Sicherstellen, dass genug Platz für den Footer ist, ggf. neue Seite
       if (currentY + fontSizeFooter + vSpaceSmall + vSpaceXLarge > doc.page.height - pageBottomMargin) {
           doc.addPage();
           currentY = pageTopMargin;
       }
       doc.y = currentY;

      doc.font(fontNormal).fontSize(fontSizeFooter);
      doc.text(
        "Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.",
        pageLeftMargin,
        doc.y,
        { align: 'left', width: usableWidth }
      );
      doc.y += vSpaceXLarge; // Größerer Abstand für Unterschrift

      doc.text("Datum, Unterschrift", pageLeftMargin, doc.y, { align: 'left' });

      // PDF-Dokument abschließen
      doc.end();

    } catch (err) {
      console.error("Fehler beim Erstellen des PDFs:", err);
      // Sende einen Fehler zurück, falls noch nicht gesendet wurde
      if (!res.headersSent) {
        res.status(500).send("Fehler beim Erstellen des PDFs.");
      } else {
          // Wenn Header gesendet wurden, versuche das PDF zu schließen und einen Fehler zu loggen
          console.error("PDF Header bereits gesendet, Fehler konnte nicht an Client gesendet werden.");
          if (doc && !doc.writableEnded) {
            doc.end();
          }
      }
    }
  });

  return router;
};
