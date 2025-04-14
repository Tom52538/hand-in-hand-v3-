const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Aus Ihren utils:
const { calculateMonthlyData } = require('../utils/calculationUtils');

/**
 * Hilfsfunktion: Dezimalstunden in HH:MM umwandeln.
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
 * Middleware: Prüft, ob Admin-Session vorliegt.
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
   * Erzeugt basierend auf calculateMonthlyData eine PDF-Datei mit
   * dem gewünschten Layout.
   */
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    try {
      const { name, year, month } = req.query;
      if (!name || !year || !month) {
        return res.status(400).send("Name, Jahr und Monat erforderlich.");
      }

      // Monatsdaten berechnen (Ihre ursprüngliche Logik)
      const monthlyData = await calculateMonthlyData(db, name, year, month);
      const {
        employeeName,
        previousCarryOver,
        totalExpected,
        totalActual,
        newCarryOver,
        workEntries
      } = monthlyData;

      // Aus year und month Zahlwerte holen
      const parsedYear = parseInt(year, 10);
      const parsedMonth = parseInt(month, 10);

      // PDF-Dokument einrichten
      const doc = new PDFDocument({ margin: 40, size: 'A4' });

      // Dateiname, z. B. "Ueberstundennachweis_Anna_04_2025.pdf"
      const safeName = (employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // PDF-Daten in die Response pipen
      doc.pipe(res);

      // Layout-Konstanten
      const leftMargin = doc.page.margins.left;
      const rightMargin = doc.page.margins.right;
      const topMargin = doc.page.margins.top;
      const bottomMarginPos = doc.page.height - doc.page.margins.bottom;
      const usableWidth = doc.page.width - leftMargin - rightMargin;

      // Logo rechts oben
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
      const logoWidth = 80;  
      const logoX = doc.page.width - rightMargin - logoWidth;
      const logoY = topMargin;

      // Logo einbinden (Fehler abfangen, falls nicht vorhanden)
      try {
        doc.image(logoPath, logoX, logoY, { width: logoWidth });
      } catch (errLogo) {
        console.warn("Logo konnte nicht geladen werden:", errLogo);
      }

      // Zeile 1: Zentrierter Titel "Überstundennachweis"
      doc.fontSize(16).font('Helvetica-Bold');
      doc.text("Überstundennachweis", leftMargin, logoY, {
        align: 'center',
        width: usableWidth
      });

      doc.moveDown(2);

      // Zeile 2: linksbündig "Name: ..."
      doc.fontSize(11).font('Helvetica');
      doc.text(`Name: ${employeeName}`, leftMargin, doc.y, { align: 'left' });
      doc.moveDown(1);

      // Zeile 3: linksbündig "Zeitraum: ..."
      const firstDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayFormatted = firstDayOfMonth.toLocaleDateString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
      });
      const lastDayFormatted = lastDayOfMonth.toLocaleDateString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
      });
      doc.text(`Zeitraum: ${firstDayFormatted} - ${lastDayFormatted}`, leftMargin, doc.y, { align: 'left' });
      doc.moveDown(2);

      // --------------------------------------------------
      // Zeile 4: Tabellenkopf mit 6 Spalten
      // "Datum", "Arbeitsbeginn", "Arbeitsende", "Soll-Zeit (HH:MM)", "Ist-Zeit (HH:MM)", "Mehr/Minder Std. (HH:MM)"
      // --------------------------------------------------

      // Spaltenbreiten definieren (gerundete Beispielwerte – bitte bei Bedarf anpassen)
      const col1Width = 70;  // Datum
      const col2Width = 85;  // Arbeitsbeginn
      const col3Width = 85;  // Arbeitsende
      const col4Width = 100; // Soll-Zeit
      const col5Width = 100; // Ist-Zeit
      const col6Width = usableWidth - (col1Width + col2Width + col3Width + col4Width + col5Width);

      // X-Positionen
      const col1X = leftMargin;
      const col2X = col1X + col1Width;
      const col3X = col2X + col2Width;
      const col4X = col3X + col3Width;
      const col5X = col4X + col4Width;
      const col6X = col5X + col5Width;

      // Tabellenkopf (Zeile 4)
      doc.font('Helvetica-Bold').fontSize(10);
      const tableHeaderY = doc.y;

      doc.text("Datum",                  col1X, tableHeaderY, { width: col1Width, align: 'left'   });
      doc.text("Arbeitsbeginn",         col2X, tableHeaderY, { width: col2Width, align: 'center' });
      doc.text("Arbeitsende",           col3X, tableHeaderY, { width: col3Width, align: 'center' });
      doc.text("Soll-Zeit (HH:MM)",     col4X, tableHeaderY, { width: col4Width, align: 'center' });
      doc.text("Ist-Zeit (HH:MM)",      col5X, tableHeaderY, { width: col5Width, align: 'center' });
      doc.text("Mehr/Minder Std. (HH:MM)", col6X, tableHeaderY, { width: col6Width, align: 'center' });

      doc.moveDown(1);

      // Linie unter Kopf
      const headLineY = doc.y;
      doc.moveTo(col1X, headLineY).lineTo(col6X + col6Width, headLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Tabellen-Einträge (Zeilen ab 5 aufwärts)
      doc.fontSize(9).font('Helvetica').lineGap(-1);

      if (!workEntries || workEntries.length === 0) {
        doc.text('Keine Buchungen in diesem Monat gefunden.', col1X, doc.y);
        doc.moveDown(2);
      } else {
        for (let i = 0; i < workEntries.length; i++) {
          const entry = workEntries[i];
          const rowY = doc.y;

          // Datum (z.B. "Mo., 07.04.2025")
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

          // Beginn, Ende, Soll, Ist, Differenz
          const startDisplay = entry.startTime || "";
          const endDisplay   = entry.endTime || "";
          const expected     = parseFloat(entry.expectedHours) || 0;
          const worked       = parseFloat(entry.hours) || 0;
          const expectedStr  = decimalHoursToHHMM(expected);
          const workedStr    = decimalHoursToHHMM(worked);
          const diffStr      = decimalHoursToHHMM(worked - expected);

          // Zeile ausgeben
          doc.text(dateFormatted,      col1X, rowY, { width: col1Width, align: 'left'   });
          doc.text(startDisplay,       col2X, rowY, { width: col2Width, align: 'center' });
          doc.text(endDisplay,         col3X, rowY, { width: col3Width, align: 'center' });
          doc.text(expectedStr,        col4X, rowY, { width: col4Width, align: 'center' });
          doc.text(workedStr,          col5X, rowY, { width: col5Width, align: 'center' });
          doc.text(diffStr,            col6X, rowY, { width: col6Width, align: 'center' });

          doc.moveDown(1);

          // Seitenumbruch, falls nötig
          if (doc.y > bottomMarginPos - 50) {
            doc.addPage();
            // Kopfzeile wiederholen
            doc.font('Helvetica-Bold').fontSize(10);
            doc.text("Datum",                  col1X, doc.y, { width: col1Width, align: 'left'   });
            doc.text("Arbeitsbeginn",         col2X, doc.y, { width: col2Width, align: 'center' });
            doc.text("Arbeitsende",           col3X, doc.y, { width: col3Width, align: 'center' });
            doc.text("Soll-Zeit (HH:MM)",     col4X, doc.y, { width: col4Width, align: 'center' });
            doc.text("Ist-Zeit (HH:MM)",      col5X, doc.y, { width: col5Width, align: 'center' });
            doc.text("Mehr/Minder Std. (HH:MM)", col6X, doc.y, { width: col6Width, align: 'center' });

            doc.moveDown(1);
            doc.moveTo(col1X, doc.y).lineTo(col6X + col6Width, doc.y).lineWidth(0.5).stroke();
            doc.moveDown(0.5);

            doc.font('Helvetica').fontSize(9).lineGap(-1);
          }
        }
      }

      // Abstand vor Zusammenfassung
      doc.moveDown(1.5);

      // ------------------------------
      // Vier Zeilen (links: Label, Spalte 5: Wert):
      //   Übertrag Vormonat (+/-)
      //   Gesamt Soll-Zeit
      //   Gesamt Ist-Zeit
      //   Gesamt Mehr/Minderstunden
      // ------------------------------
      doc.font('Helvetica-Bold').fontSize(10);

      // Y-Start
      const summaryStartY = doc.y;

      // Labels links in Spalte 1, Werte in Spalte 5 (laut Anforderung)
      const summaryLabelX = col1X; 
      const summaryLabelWidth = col4X - col1X; 
      const summaryValueX = col5X;  

      // Konvertierung in HH:MM
      const previousCarryStr   = decimalHoursToHHMM(previousCarryOver || 0);
      const totalExpectedStr   = decimalHoursToHHMM(totalExpected || 0);
      const totalActualStr     = decimalHoursToHHMM(totalActual || 0);
      const totalDiff          = (totalActual || 0) - (totalExpected || 0);
      const totalDiffStr       = decimalHoursToHHMM(totalDiff);

      // Zeile 1: Übertrag Vormonat
      doc.text("Übertrag Vormonat (+/-):", summaryLabelX, summaryStartY, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(previousCarryStr, summaryValueX, summaryStartY, {
        width: col5Width, align: 'right'
      });

      // Zeile 2: Gesamt Soll-Zeit
      doc.moveDown(1);
      doc.text("Gesamt Soll-Zeit:", summaryLabelX, doc.y, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(totalExpectedStr, summaryValueX, doc.y, {
        width: col5Width, align: 'right'
      });

      // Zeile 3: Gesamt Ist-Zeit
      doc.moveDown(1);
      doc.text("Gesamt Ist-Zeit:", summaryLabelX, doc.y, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(totalActualStr, summaryValueX, doc.y, {
        width: col5Width, align: 'right'
      });

      // Zeile 4: Gesamt Mehr/Minderstunden
      doc.moveDown(1);
      doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(totalDiffStr, summaryValueX, doc.y, {
        width: col5Width, align: 'right'
      });

      // Platz für den Bestätigungstext
      doc.moveDown(3);

      doc.fontSize(9).font('Helvetica');
      doc.text(
        "Ich bestätige hiermit, dass die oben genannten Arbeitsstunden " +
        "erbracht wurden und rechtmäßig in Rechnung gestellt werden.",
        { align: 'left' }
      );

      doc.moveDown(2);
      doc.text("Datum, Unterschrift", { align: 'left' });

      // PDF beenden
      doc.end();

    } catch (err) {
      console.error("Fehler beim Erstellen des PDFs:", err);
      res.status(500).send("Fehler beim Erstellen des PDFs.");
    }
  });

  return router;
};
