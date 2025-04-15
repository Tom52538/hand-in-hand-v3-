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

      // Monatsdaten berechnen
      const monthlyData = await calculateMonthlyData(db, name, year, month);
      const {
        employeeName,
        previousCarryOver,
        totalExpected,
        totalActual,
        newCarryOver,
        workEntries
      } = monthlyData;
      const parsedYear = parseInt(year, 10);
      const parsedMonth = parseInt(month, 10);

      // PDF-Dokument erstellen
      const doc = new PDFDocument({
        margin: 40,
        size: 'A4'
       });
      const safeName = (employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      // --- Layout Konstanten ---
      const pageTopMargin = doc.page.margins.top;
      const pageLeftMargin = doc.page.margins.left;
      const pageRightMargin = doc.page.margins.right;
      const pageBottomMargin = doc.page.margins.bottom;
      const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;

      const fontNormal = 'Helvetica';
      const fontBold = 'Helvetica-Bold';

      const fontSizeHeader = 16;
      const fontSizeSubHeader = 11;
      const fontSizeTableHeader = 9;
      const fontSizeTableContent = 9;
      const fontSizeSummary = 10;
      const fontSizeFooter = 9;

      const vSpaceSmall = 5;
      const vSpaceMedium = 15; // *** NEU: Größerer Abstand nach Kopfzeilenlinie ***
      const vSpaceLarge = 25;
      const vSpaceXLarge = 40;
      const tableRowHeight = 14;

      //-------------------------------
      // Kopfzeile
      //-------------------------------
      let currentY = pageTopMargin;

      // Logo (rechts oben) - *** GRÖßE ANGEPASST ***
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
      const logoWidth = 80; // *** Vergrößert ***
      const logoHeight = 80; // *** Vergrößert ***
      const logoX = doc.page.width - pageRightMargin - logoWidth;
      const logoY = currentY;
      try {
        doc.image(logoPath, logoX, logoY, { width: logoWidth, height: logoHeight });
      } catch (errLogo) {
        console.warn("Logo konnte nicht geladen werden:", errLogo);
      }

      // Titel
      doc.font(fontBold).fontSize(fontSizeHeader);
      doc.text("Überstundennachweis", pageLeftMargin, currentY + vSpaceSmall, {
        align: 'center',
        width: usableWidth
      });
      // Höhe anpassen basierend auf dem größeren Element (Titel oder Logo)
      currentY = Math.max(currentY + fontSizeHeader + vSpaceSmall, logoY + logoHeight);
      currentY += vSpaceMedium;

      // Name und Zeitraum
      doc.font(fontNormal).fontSize(fontSizeSubHeader);
      doc.text(`Name: ${employeeName}`, pageLeftMargin, currentY);
      currentY += fontSizeSubHeader + vSpaceSmall;

      const firstDay = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDay = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayStr = firstDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayStr = lastDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      doc.text(`Zeitraum: ${firstDayStr} - ${lastDayStr}`, pageLeftMargin, currentY);
      currentY += fontSizeSubHeader + vSpaceLarge;

      //-------------------------------
      // Tabelle
      //-------------------------------
      const tableStartY = currentY;

      const colWidths = {
          date: 115,
          start: 75,
          end: 75,
          expected: 85,
          actual: 85,
          diff: usableWidth - 115 - 75 - 75 - 85 - 85
      };

      const colPositions = {
          date: pageLeftMargin,
          start: pageLeftMargin + colWidths.date,
          end: pageLeftMargin + colWidths.date + colWidths.start,
          expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
          actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
          diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
      };

      // --- Tabellenkopf ---
      const drawTableHeader = (yPos) => {
          doc.font(fontBold).fontSize(fontSizeTableHeader);
          const headerTextY = yPos + vSpaceSmall / 2;
          doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
          doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
          doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
          doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
          doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
          doc.text("Mehr/Minder\nStd. (HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });
          const headerBottomY = yPos + (fontSizeTableHeader * 2) + vSpaceSmall;
          doc.moveTo(pageLeftMargin, headerBottomY)
             .lineTo(pageLeftMargin + usableWidth, headerBottomY)
             .lineWidth(0.5)
             .stroke();
          return headerBottomY + vSpaceMedium; // *** ABSTAND HIER ANGEPASST ***
      };

      currentY = drawTableHeader(currentY); // Kopf zeichnen und neue Y-Position erhalten

      // --- Tabelleninhalt ---
      doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(1);
      let contentStartY = currentY; // Start Y für den Inhalt nach dem Kopf
      doc.y = contentStartY; // Setze die Startposition für den Inhalt

      if (!workEntries || workEntries.length === 0) {
        doc.text('Keine Arbeitszeitbuchungen in diesem Monat gefunden.', pageLeftMargin, currentY, {width: usableWidth});
        currentY += tableRowHeight;
      } else {
        for (let i = 0; i < workEntries.length; i++) {
          const entry = workEntries[i];

           // Seitenumbruch prüfen VOR dem Zeichnen der Zeile
           // Prüfe, ob die *aktuelle* Zeile noch auf die Seite passt
           if (doc.y + tableRowHeight > doc.page.height - pageBottomMargin) {
             doc.addPage();
             currentY = pageTopMargin; // Y-Position für die neue Seite zurücksetzen
             currentY = drawTableHeader(currentY); // Kopf auf neuer Seite wiederholen
             doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(1); // Font wiederherstellen
             doc.y = currentY; // Startposition für Inhalt auf neuer Seite setzen
           }

          // --- Daten für die Zeile ---
          let dateFormatted = "Ungült. Datum";
          if (entry.date) {
              try {
                  const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date).split('T')[0];
                  const dateObj = new Date(dateStr + "T00:00:00Z");
                  if (!isNaN(dateObj.getTime())) {
                      dateFormatted = dateObj.toLocaleDateString('de-DE', {
                          weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
                      });
                      if (dateFormatted.includes(',') && !dateFormatted.includes('.,')) {
                          dateFormatted = dateFormatted.replace(',', '.,');
                      }
                  }
              } catch (e) {
                  console.error("Fehler beim Formatieren des Datums für PDF:", entry.date, e);
                  dateFormatted = String(entry.date);
              }
          }

          const startDisplay = entry.startTime || "--:--";
          const endDisplay = entry.endTime || "--:--";
          const expected = parseFloat(entry.expectedHours) || 0;
          const worked = parseFloat(entry.hours) || 0;
          const diff = worked - expected;

          const expectedStr = decimalHoursToHHMM(expected);
          const workedStr = decimalHoursToHHMM(worked);
          const diffStr = decimalHoursToHHMM(diff);

          // --- Zeile zeichnen (verwende doc.y) ---
          const currentRowY = doc.y;
          doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
          doc.text(startDisplay, colPositions.start, currentRowY, { width: colWidths.start, align: 'center', lineBreak: false });
          doc.text(endDisplay, colPositions.end, currentRowY, { width: colWidths.end, align: 'center', lineBreak: false });
          doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'center', lineBreak: false });
          doc.text(workedStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'center', lineBreak: false });
          doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'center', lineBreak: false });

          // Y-Position für die nächste Zeile erhöhen
          doc.y += tableRowHeight;
        }
      }
      // Finale Y-Position nach der Tabelle merken
      currentY = doc.y;
      currentY += vSpaceLarge;

      //-------------------------------
      // Zusammenfassung
      //-------------------------------
       if (currentY + (5 * (fontSizeSummary + vSpaceSmall)) > doc.page.height - pageBottomMargin - (fontSizeFooter + vSpaceXLarge)) { // Höhe angepasst (5 Zeilen)
           doc.addPage();
           currentY = pageTopMargin;
       }
       doc.y = currentY;

       doc.font(fontBold).fontSize(fontSizeSummary);
       const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - vSpaceSmall;
       const summaryValueWidth = colWidths.actual + colWidths.diff;
       const summaryLabelX = pageLeftMargin;
       const summaryValueX = colPositions.actual;

       doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       doc.text("Gesamt Soll-Zeit:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       doc.text("Gesamt Ist-Zeit:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       const totalDiff = (totalActual || 0) - (totalExpected || 0);
       doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
       doc.moveDown(0.5);

       doc.font(fontBold);
       doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
       doc.text(decimalHoursToHHMM(newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

       currentY = doc.y + vSpaceLarge; // Abstand verwenden

      //-------------------------------
      // Fußzeile
      //-------------------------------
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
      doc.y += vSpaceXLarge;

      doc.text("Datum, Unterschrift", pageLeftMargin, doc.y, { align: 'left' });

      // PDF abschließen
      doc.end();

    } catch (err) {
      console.error("Fehler beim Erstellen des PDFs:", err);
      if (!res.headersSent) {
        res.status(500).send("Fehler beim Erstellen des PDFs.");
      } else {
          console.error("PDF Header bereits gesendet, Fehler konnte nicht an Client gesendet werden.");
          if (doc && !doc.writableEnded) {
            doc.end();
          }
      }
    }
  });

  return router;
};
