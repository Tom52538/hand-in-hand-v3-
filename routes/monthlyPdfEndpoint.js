const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere die Berechnungsfunktion aus calculationUtils.js
const { calculateMonthlyData } = require('../utils/calculationUtils');

/**
 * Hilfsfunktion: Wandelt Dezimalstunden in ein HH:MM-Format um.
 */
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
        workEntries
      } = monthlyData;
      const parsedYear = parseInt(year, 10);
      const parsedMonth = parseInt(month, 10);

      // PDF-Dokument erstellen und vorbereiten
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const safeName = (employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      // Seitenbreiten-Berechnungen
      const leftMargin = doc.page.margins.left;
      const rightMargin = doc.page.margins.right;
      const usableWidth = doc.page.width - leftMargin - rightMargin;

      //-------------------------------
      // Zeile 1: Logo und Titel
      //-------------------------------
      const topY = doc.page.margins.top;
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
      const logoWidth = 80;
      const logoX = doc.page.width - rightMargin - logoWidth;
      try {
        doc.image(logoPath, logoX, topY, { width: logoWidth });
      } catch (errLogo) {
        console.warn("Logo konnte nicht geladen werden:", errLogo);
      }
      const titleY = topY + 5;
      doc.fontSize(16).font('Helvetica-Bold');
      doc.text("Überstundennachweis", leftMargin, titleY, {
        align: 'center',
        width: usableWidth
      });

      //-------------------------------
      // Zeile 2: Name
      //-------------------------------
      const nameY = titleY + 30;
      doc.fontSize(11).font('Helvetica');
      doc.text(`Name: ${employeeName}`, leftMargin, nameY, { align: 'left' });

      //-------------------------------
      // Zeile 3: Zeitraum
      //-------------------------------
      const firstDay = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDay = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayStr = firstDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayStr = lastDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const zeitraumY = nameY + 20;
      doc.text(`Zeitraum: ${firstDayStr} - ${lastDayStr}`, leftMargin, zeitraumY, { align: 'left' });

      //-------------------------------
      // Zeile 4: Tabellenkopf
      //-------------------------------
      const tableHeaderY = zeitraumY + 30;
      // Spaltenbreiten definieren
      const col1Width = 70;  // Datum
      const col2Width = 85;  // Arbeitsbeginn
      const col3Width = 85;  // Arbeitsende
      const col4Width = 100; // Soll-Zeit (HH:MM)
      const col5Width = 100; // Ist-Zeit (HH:MM)
      const col6Width = usableWidth - (col1Width + col2Width + col3Width + col4Width + col5Width);
      // X-Koordinaten
      const col1X = leftMargin;
      const col2X = col1X + col1Width;
      const col3X = col2X + col2Width;
      const col4X = col3X + col3Width;
      const col5X = col4X + col4Width;
      const col6X = col5X + col5Width;
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text("Datum", col1X, tableHeaderY, { width: col1Width, align: 'left' });
      doc.text("Arbeitsbeginn", col2X, tableHeaderY, { width: col2Width, align: 'center' });
      doc.text("Arbeitsende", col3X, tableHeaderY, { width: col3Width, align: 'center' });
      doc.text("Soll-Zeit (HH:MM)", col4X, tableHeaderY, { width: col4Width, align: 'center' });
      doc.text("Ist-Zeit (HH:MM)", col5X, tableHeaderY, { width: col5Width, align: 'center' });
      doc.text("Mehr/Minder Std. (HH:MM)", col6X, tableHeaderY, { width: col6Width, align: 'center' });
      const headerLineY = tableHeaderY + 15;
      doc.moveTo(col1X, headerLineY).lineTo(col6X + col6Width, headerLineY).lineWidth(0.5).stroke();

      //-------------------------------
      // Tabelleninhalt (Arbeitstage)
      //-------------------------------
      let currentY = headerLineY + 10;
      // Wichtiger Schritt: Synchronisieren Sie doc.y mit currentY, um den Flow korrekt fortzusetzen.
      doc.y = currentY;
      doc.font('Helvetica').fontSize(9).lineGap(-1);
      if (!workEntries || workEntries.length === 0) {
        doc.text('Keine Buchungen in diesem Monat gefunden.', col1X, doc.y);
        currentY = doc.y + 20;
      } else {
        for (let i = 0; i < workEntries.length; i++) {
          const entry = workEntries[i];
          let dateFormatted = "n.a.";
          if (entry.date) {
            try {
              const dateObj = new Date(entry.date.toString().split('T')[0] + "T00:00:00Z");
              dateFormatted = dateObj.toLocaleDateString('de-DE', {
                weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
              });
            } catch (e) {
              dateFormatted = String(entry.date);
            }
          }
          const startDisplay = entry.startTime || "";
          const endDisplay = entry.endTime || "";
          const expected = parseFloat(entry.expectedHours) || 0;
          const worked = parseFloat(entry.hours) || 0;
          const expectedStr = decimalHoursToHHMM(expected);
          const workedStr = decimalHoursToHHMM(worked);
          const diffStr = decimalHoursToHHMM(worked - expected);
          doc.text(dateFormatted, col1X, doc.y, { width: col1Width, align: 'left' });
          doc.text(startDisplay, col2X, doc.y, { width: col2Width, align: 'center' });
          doc.text(endDisplay, col3X, doc.y, { width: col3Width, align: 'center' });
          doc.text(expectedStr, col4X, doc.y, { width: col4Width, align: 'center' });
          doc.text(workedStr, col5X, doc.y, { width: col5Width, align: 'center' });
          doc.text(diffStr, col6X, doc.y, { width: col6Width, align: 'center' });
          // Aktuelle Y-Position um 15 Punkte erhöhen
          currentY = doc.y + 15;
          doc.y = currentY;
          // Seitenumbruch prüfen
          if (currentY > doc.page.height - doc.page.margins.bottom - 50) {
            doc.addPage();
            currentY = doc.page.margins.top;
            // Wiederhole Tabellenkopf auf neuer Seite
            doc.font('Helvetica-Bold').fontSize(10);
            doc.text("Datum", col1X, currentY, { width: col1Width, align: 'left' });
            doc.text("Arbeitsbeginn", col2X, currentY, { width: col2Width, align: 'center' });
            doc.text("Arbeitsende", col3X, currentY, { width: col3Width, align: 'center' });
            doc.text("Soll-Zeit (HH:MM)", col4X, currentY, { width: col4Width, align: 'center' });
            doc.text("Ist-Zeit (HH:MM)", col5X, currentY, { width: col5Width, align: 'center' });
            doc.text("Mehr/Minder Std. (HH:MM)", col6X, currentY, { width: col6Width, align: 'center' });
            currentY += 15;
            doc.moveTo(col1X, currentY).lineTo(col6X + col6Width, currentY).lineWidth(0.5).stroke();
            currentY += 10;
            doc.y = currentY;
            doc.font('Helvetica').fontSize(9).lineGap(-1);
          }
        }
      }

      //-------------------------------
      // Zusammenfassung (unterhalb der Tabelle)
      //-------------------------------
      // Wichtiger Schritt: Setzen Sie doc.y gleich currentY, um in der richtigen Position fortzufahren.
      doc.y = currentY + 20;
      doc.font('Helvetica-Bold').fontSize(10);
      const summaryLabelX = leftMargin;
      const summaryValueX = col5X;
      doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: col4Width, align: 'left' });
      doc.text(decimalHoursToHHMM(previousCarryOver || 0), summaryValueX, doc.y, { width: col5Width, align: 'right' });
      doc.y += 15;
      doc.text("Gesamt Soll-Zeit:", summaryLabelX, doc.y, { width: col4Width, align: 'left' });
      doc.text(decimalHoursToHHMM(totalExpected || 0), summaryValueX, doc.y, { width: col5Width, align: 'right' });
      doc.y += 15;
      doc.text("Gesamt Ist-Zeit:", summaryLabelX, doc.y, { width: col4Width, align: 'left' });
      doc.text(decimalHoursToHHMM(totalActual || 0), summaryValueX, doc.y, { width: col5Width, align: 'right' });
      doc.y += 15;
      const totalDiff = (totalActual || 0) - (totalExpected || 0);
      doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: col4Width, align: 'left' });
      doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: col5Width, align: 'right' });

      //-------------------------------
      // Bestätigungstext und Unterschrift
      //-------------------------------
      doc.y += 30;
      doc.font('Helvetica').fontSize(9);
      doc.text("Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.", leftMargin, doc.y, { align: 'left', width: usableWidth });
      doc.y += 40;
      doc.text("Datum, Unterschrift", leftMargin, doc.y, { align: 'left' });

      // PDF-Dokument abschließen
      doc.end();
    } catch (err) {
      console.error("Fehler beim Erstellen des PDFs:", err);
      res.status(500).send("Fehler beim Erstellen des PDFs.");
    }
  });

  return router;
};
