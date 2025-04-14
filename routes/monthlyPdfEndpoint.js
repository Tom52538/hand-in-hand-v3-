const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere die Berechnungsfunktion aus calculationUtils.js
const { calculateMonthlyData } = require('../utils/calculationUtils');

// Hilfsfunktion: Wandelt Dezimalstunden in ein HH:MM-Format um
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

  // Middleware für den Admin-Check
  function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
      next();
    } else {
      console.warn(`PDF Route: isAdmin Check fehlgeschlagen: Session ID: ${req.sessionID}, isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`);
      res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
    }
  }

  // GET-Endpunkt zum Erzeugen des Monats-PDFs
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    const { name, year, month } = req.query;

    try {
      const monthlyData = await calculateMonthlyData(db, name, year, month);
      const parsedYear = parseInt(year);
      const parsedMonth = parseInt(month);

      // PDF-Dokument erstellen mit angepasstem Margin und A4-Größe
      const doc = new PDFDocument({ margin: 40, size: 'A4' });

      const safeName = (monthlyData.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      doc.pipe(res);

      // Layout-Konstanten
      const leftMargin = doc.page.margins.left;
      const rightMargin = doc.page.margins.right;
      const topMargin = doc.page.margins.top;
      const bottomMarginPos = doc.page.height - doc.page.margins.bottom;
      const usableWidth = doc.page.width - leftMargin - rightMargin;

      // Definition der Spaltenbreiten (die Summe entspricht etwa der nutzbaren Breite)
      const colCombinedWidth = 150;  // Spalte 1: Datum + Arbeitsbeginn
      const colEndWidth = 70;        // Spalte 2: Arbeitsende
      const colSollWidth = 70;       // Spalte 3: Soll-Zeit (HH:MM)
      const colIstWidth = 70;        // Spalte 4: Ist-Zeit (HH:MM)
      const colDiffWidth = usableWidth - (colCombinedWidth + colEndWidth + colSollWidth + colIstWidth);
      // Bestimmen der X-Positionen der Spalten
      const colCombinedX = leftMargin;
      const colEndX = colCombinedX + colCombinedWidth;
      const colSollX = colEndX + colEndWidth;
      const colIstX = colSollX + colSollWidth;
      const colDiffX = colIstX + colIstWidth;
      const tableRightEdge = doc.page.width - rightMargin;

      // Logo in der oberen rechten Ecke platzieren
      const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
      const logoWidth = 90; // Angepasste Logo-Breite
      const logoX = doc.page.width - rightMargin - logoWidth;
      const logoY = topMargin - 10;
      let initialY = topMargin;

      try {
          doc.image(logoPath, logoX, logoY, { width: logoWidth });
          // Initiale Y-Position anpassen, damit der Text nicht zu weit unten beginnt
          initialY = Math.max(topMargin, logoY + logoWidth * 0.3 + 15);
      } catch (imgErr) {
          console.error("Fehler beim Laden des PDF-Logos:", imgErr);
          initialY = topMargin;
      }
      doc.y = initialY;

      // Header-Bereich: Überschrift und Mitarbeiterinfos
      doc.fontSize(16).font('Helvetica-Bold').text('Überstundennachweis', leftMargin, doc.y, { align: 'center', width: usableWidth - logoWidth - 10 });
      doc.moveDown(1.2);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Name: ${monthlyData.employeeName}`);
      doc.moveDown(0.4);

      // Darstellung des Zeitraums im Format TT.MM.JJJJ – TT.MM.JJJJ
      const firstDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
      const lastDayOfMonth = new Date(Date.UTC(parsedYear, parsedMonth, 0));
      const firstDayFormatted = firstDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      const lastDayFormatted = lastDayOfMonth.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      doc.text(`Zeitraum: ${firstDayFormatted} - ${lastDayFormatted}`);
      doc.moveDown(1.5);

      // --------------------------------------------------
      // Tabellenkopf anpassen (mittels eingebautem Zeilenumbruch)
      // --------------------------------------------------
      const tableTop = doc.y;
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text("Datum\nArbeits-beginn", colCombinedX, tableTop, { width: colCombinedWidth, align: 'left' });
      doc.text("Arbeits-ende", colEndX, tableTop, { width: colEndWidth, align: 'center' });
      doc.text("Soll-Zeit\n(HH:MM)", colSollX, tableTop, { width: colSollWidth, align: 'center' });
      doc.text("Ist-Zeit\n(HH:MM)", colIstX, tableTop, { width: colIstWidth, align: 'center' });
      doc.text("Mehr/-Minder\nStd. (HH:MM)", colDiffX, tableTop, { width: colDiffWidth, align: 'center' });
      doc.font('Helvetica');
      doc.moveDown(1.2);

      // Linie unter dem Tabellenkopf zeichnen
      const headerLineY = doc.y;
      doc.moveTo(leftMargin, headerLineY).lineTo(tableRightEdge, headerLineY).lineWidth(0.5).stroke();
      doc.moveDown(0.4);

      // --------------------------------------------------
      // Tabellenzeilen: Iteration über monthlyData.workEntries
      // In der ersten Spalte werden Datum und Arbeitsbeginn kombiniert.
      // --------------------------------------------------
      let totalIstHoursMonth = 0;
      let totalExpectedHoursMonth = 0;
      if (monthlyData.workEntries && monthlyData.workEntries.length > 0) {
        doc.fontSize(9).lineGap(-1);

        monthlyData.workEntries.forEach((entry) => {
          const y = doc.y;
          let dateFormatted = 'n.a.';
          if (entry.date) {
            try {
              const dateObj = new Date(entry.date.toString().split('T')[0] + 'T00:00:00Z');
              dateFormatted = dateObj.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
            } catch (e) {
              dateFormatted = entry.date;
            }
          }
          const startTimeDisplay = entry.startTime || 'n.a.';
          // Kombination von Datum und Arbeitsbeginn im gewünschten Format (z. B. "Mo., 03.03.2025 08:00")
          const combinedStart = `${dateFormatted} ${startTimeDisplay}`;
          const endTimeDisplay = entry.endTime || 'Buchung fehlt';

          const worked = parseFloat(entry.hours) || 0;
          totalIstHoursMonth += worked;
          const expected = parseFloat(entry.expectedHours) || 0;
          totalExpectedHoursMonth += expected;
          const expectedFormatted = decimalHoursToHHMM(expected);
          const istFormatted = decimalHoursToHHMM(worked);
          const diffFormatted = decimalHoursToHHMM(worked - expected);

          // Zeichnen der Zeile in den definierten Spalten
          doc.text(combinedStart, colCombinedX, y, { width: colCombinedWidth, align: 'left' });
          doc.text(endTimeDisplay, colEndX, y, { width: colEndWidth, align: 'center' });
          doc.text(expectedFormatted, colSollX, y, { width: colSollWidth, align: 'center' });
          doc.text(istFormatted, colIstX, y, { width: colIstWidth, align: 'center' });
          doc.text(diffFormatted, colDiffX, y, { width: colDiffWidth, align: 'center' });

          // Seitenumbruch, falls das untere Seitenende erreicht ist
          if (doc.y > bottomMarginPos - 50) {
            doc.addPage({ margins: { top: 40, bottom: 40, left: 40, right: 40 } });
            try {
              doc.image(logoPath, logoX, logoY, { width: logoWidth });
            } catch (imgErr) {
              console.error("Logo auf Folgeseite fehlgeschlagen:", imgErr);
            }
            doc.y = topMargin + 20;
            doc.fontSize(10).font('Helvetica-Bold');
            doc.text("Datum\nArbeits-beginn", colCombinedX, doc.y, { width: colCombinedWidth, align: 'left' });
            doc.text("Arbeits-ende", colEndX, doc.y, { width: colEndWidth, align: 'center' });
            doc.text("Soll-Zeit\n(HH:MM)", colSollX, doc.y, { width: colSollWidth, align: 'center' });
            doc.text("Ist-Zeit\n(HH:MM)", colIstX, doc.y, { width: colIstWidth, align: 'center' });
            doc.text("Mehr/-Minder\nStd. (HH:MM)", colDiffX, doc.y, { width: colDiffWidth, align: 'center' });
            doc.font('Helvetica');
            doc.moveDown(1.2);
          } else {
            doc.moveDown(0.5);
          }
        });
        doc.fontSize(10).lineGap(0);
      } else {
        doc.fontSize(10).text('Keine Buchungen in diesem Monat gefunden.', colCombinedX, doc.y);
        doc.moveDown();
      }

      // --------------------------------------------------
      // Zusammenfassungsbereich (Gesamtwerte) und Unterschriftsfeld
      // --------------------------------------------------
      const summaryY = doc.y + 20;
      doc.moveTo(leftMargin, summaryY).lineTo(tableRightEdge, summaryY).lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      const totalSollFormatted = decimalHoursToHHMM(totalExpectedHoursMonth);
      const totalIstFormatted = decimalHoursToHHMM(totalIstHoursMonth);
      const totalDiffFormatted = decimalHoursToHHMM(totalIstHoursMonth - totalExpectedHoursMonth);

      doc.font('Helvetica-Bold');
      doc.text(`Gesamt Soll-Zeit: ${totalSollFormatted}`, leftMargin, doc.y);
      doc.text(`Gesamt Ist-Zeit: ${totalIstFormatted}`, leftMargin, doc.y + 15);
      doc.text(`Gesamt Mehr-/Minderstunden: ${totalDiffFormatted}`, leftMargin, doc.y + 30);
      doc.moveDown(2);

      // Bestätigungstext und Unterschriftsbereich
      doc.font('Helvetica').fontSize(9);
      doc.text('Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.', { align: 'left' });
      doc.moveDown(3);
      doc.text('Datum, Unterschrift', { align: 'left' });

      doc.end();
    } catch (err) {
      console.error("Fehler beim Erstellen des PDFs:", err);
      res.status(500).send('Fehler beim Erstellen des PDFs.');
    }
  });

  return router;
};
