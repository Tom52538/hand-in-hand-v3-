// monthlyPdfEndpoint.js - V19: Komplett, Monospace-Tabellenlayout, Deploy-ready
const express     = require('express');
const PDFDocument = require('pdfkit');
const path        = require('path');
const router      = express.Router();
const { calculateMonthlyData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten ---
const FONT_NORMAL            = 'Times-Roman';
const FONT_MONO              = 'Courier';
const FONT_BOLD              = 'Times-Bold';
const PAGE_OPTIONS           = { size:'A4', autoFirstPage:false, margins:{ top:25,bottom:35,left:40,right:40 } };
const V_SPACE                = { TINY:1, SMALL:4, MEDIUM:10, LARGE:18, SIGNATURE_GAP:45 };
const FONT_SIZE              = { HEADER:16, SUB_HEADER:11, TABLE_CONTENT:7, SUMMARY:8, FOOTER:8, PAGE_NUMBER:8 };
const TABLE_ROW_HEIGHT       = 10;
const FOOTER_TOTAL_HEIGHT    = FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.MEDIUM;
const SUMMARY_TOTAL_HEIGHT   = (7 * (FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5)) + V_SPACE.LARGE;

// --- Hilfsfunktionen ---
function padRight(str, len) {
  return str + ' '.repeat(Math.max(0, len - str.length));
}
function padLeft(str, len) {
  return ' '.repeat(Math.max(0, len - str.length)) + str;
}
function formatDateGermanWithWeekday(dateInput) {
  if (!dateInput) return 'N/A';
  const iso = (dateInput instanceof Date)
    ? dateInput.toISOString().split('T')[0]
    : String(dateInput).split('T')[0];
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return String(dateInput);
  return d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}
function decimalHoursToHHMM(hours) {
  if (isNaN(hours) || hours === null) return '00:00';
  const sign = hours < 0 ? '-' : '';
  const absH = Math.abs(hours);
  const totalMin = Math.round(absH * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function isAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(403).send('Zugriff verweigert');
}

module.exports = function(db) {
  // Test-Route
  router.get('/test', (req, res) => res.send('PDF Route Test OK'));

  // Monats-PDF erzeugen
  router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
    try {
      const { name, year, month } = req.query;
      if (!name || !year || !month || isNaN(+year) || isNaN(+month) || month < 1 || month > 12) {
        return res.status(400).send('Parameter fehlen oder ungültig');
      }
      const y = +year;
      const m = +month;
      const data = await calculateMonthlyData(db, name, y, m);
      if (!data) throw new Error('Daten nicht abrufbar');

      // PDF vorbereiten
      const doc = new PDFDocument(PAGE_OPTIONS);
      doc.pipe(res);
      const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
      const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2,'0')}_${y}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // Dokumenten-Header
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).text(`Monatsnachweis ${String(m).padStart(2,'0')}/${y}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER)
         .text(`Name: ${data.employeeName || 'Unbekannt'}`, { align: 'left' })
         .text(`Zeitraum: 01.${String(m).padStart(2,'0')}.${y} - 30.${String(m).padStart(2,'0')}.${y}`, { align: 'left' });
      doc.moveDown(1);

      // Tabellen-Header (Monospace)
      doc.font(FONT_MONO).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
      const header = padRight('Datum', 17)
                   + padLeft('Start', 6)
                   + padLeft('Ende', 6)
                   + padLeft('Soll', 6)
                   + padLeft('Ist', 6)
                   + padLeft('Diff', 6);
      doc.text(header, doc.page.margins.left);
      doc.moveDown(0.2);

      // Datensätze einzeilig ausgeben
      const entries = [];
      data.workEntries.forEach(e => entries.push({
        date: formatDateGermanWithWeekday(e.date),
        start: e.startTime || '--:--',
        end: e.endTime || '--:--',
        expected: decimalHoursToHHMM(getExpectedHours(data.employeeData, e.date)),
        actual: decimalHoursToHHMM(parseFloat(e.hours) || 0),
        diff: decimalHoursToHHMM((parseFloat(e.hours) || 0) - getExpectedHours(data.employeeData, e.date))
      }));
      data.absenceEntries.forEach(a => {
        if (!entries.find(r => r.date === formatDateGermanWithWeekday(a.date))) {
          entries.push({
            date: formatDateGermanWithWeekday(a.date),
            start: '--:--',
            end: '--:--',
            expected: decimalHoursToHHMM(getExpectedHours(data.employeeData, a.date)),
            actual: decimalHoursToHHMM(parseFloat(a.hours) || 0),
            diff: decimalHoursToHHMM((parseFloat(a.hours) || 0) - getExpectedHours(data.employeeData, a.date))
          });
        }
      });
      entries.sort((a, b) => new Date(a.date.split('.')[2].split(' ')[0], a.date.split('.')[1]-1, a.date.split('.')[0])
                     - new Date(b.date.split('.')[2].split(' ')[0], b.date.split('.')[1]-1, b.date.split('.')[0]));

      entries.forEach(row => {
        const line = padRight(row.date, 17)
                     + padLeft(row.start, 6)
                     + padLeft(row.end, 6)
                     + padLeft(row.expected, 6)
                     + padLeft(row.actual, 6)
                     + padLeft(row.diff, 6);
        doc.text(line, doc.page.margins.left);
        doc.moveDown(0.3);
      });

      // Zusammenfassung
      doc.moveDown(1);
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
      doc.text(`Übertrag Vormonat: ${decimalHoursToHHMM(data.previousCarryOver)}`);
      doc.text(`Gesamt Soll (Monat): ${decimalHoursToHHMM(data.totalExpected)}`);
      doc.text(`Gesamt Ist (Monat):  ${decimalHoursToHHMM(data.totalActual)}`);
      doc.text(`Differenz:           ${decimalHoursToHHMM(data.totalActual - data.totalExpected)}`);

      // Footer
      doc.moveDown(2);
      doc.text('Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden.');
      doc.moveDown(1);
      doc.text('Datum, Unterschrift: _____________________________');

      doc.end();
    } catch (err) {
      console.error('PDF-Fehler:', err);
      res.status(500).send('Fehler bei PDF-Erstellung');
    }
  });

  return router;
};
