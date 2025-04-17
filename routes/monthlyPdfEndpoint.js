// monthlyPdfEndpoint.js - V14: Vollständig mit Layout-Optimierung
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Berechnungsfunktionen importieren
const { calculateMonthlyData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Times-Roman';
const FONT_BOLD   = 'Times-Bold';
const PAGE_OPTIONS = {
  size: 'A4',
  autoFirstPage: false,
  margins: { top: 25, bottom: 35, left: 40, right: 40 }
};
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = {
  HEADER: 16, SUB_HEADER: 11,
  TABLE_HEADER: 9, TABLE_CONTENT: 9,
  SUMMARY: 8, FOOTER: 8, PAGE_NUMBER: 8
};
const TABLE_ROW_HEIGHT = 12;
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL;
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL;
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM;
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5;
const SUMMARY_TOTAL_HEIGHT = (7 * SUMMARY_LINE_HEIGHT) + V_SPACE.LARGE;

function decimalHoursToHHMM(decimalHours) {
  if (isNaN(decimalHours) || decimalHours === null) return '00:00';
  const sign = decimalHours < 0 ? '-' : '';
  const absH = Math.abs(decimalHours);
  const totalMin = Math.round(absH * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function formatDateGerman(dateInput) {
  if (!dateInput) return 'N/A';
  const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

function formatDateGermanWithWeekday(dateInput) {
  if (!dateInput) return 'N/A';
  const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

function drawDocumentHeader(doc, title, name, startDate, endDate) {
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const width = doc.page.width - left - right;
  let y = doc.page.margins.top;
  // Logo
  try {
    const logoPath = path.join(process.cwd(),'public','icons','Hand-in-Hand-Logo-192x192.png');
    doc.image(logoPath, doc.page.width - right - 70, y, { width:70, height:70 });
  } catch {}
  // Titel
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).fillColor('black');
  doc.text(title, left, y + V_SPACE.SMALL, { align:'center', width });
  y += V_SPACE.SMALL + doc.heightOfString(title, { width, align:'center' }) + V_SPACE.LARGE;
  // Sub-Header
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
  doc.text(`Name: ${name||'Unbekannt'}`, left, y);
  y += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
  doc.text(`Zeitraum: ${formatDateGerman(startDate)} - ${formatDateGerman(endDate)}`, left, y);
  return y + FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
}

function drawTableHeader(doc, startY, usableWidth) {
  const left = doc.page.margins.left;
  // Spaltenbreiten
  const cols = { date:105, start:65, end:85, expected:75, actual:75 };
  cols.diff = Math.max(30, usableWidth - Object.values(cols).reduce((a,b)=>a+b,0));
  // Positionen berechnen
  const pos = { date:left };
  pos.start    = pos.date + cols.date;
  pos.end      = pos.start + cols.start;
  pos.expected = pos.end + cols.end;
  pos.actual   = pos.expected + cols.expected;
  pos.diff     = pos.actual + cols.actual;
  // Header-Höhe
  const headerHeight = (FONT_SIZE.TABLE_HEADER*2) + V_SPACE.TINY + V_SPACE.SMALL;
  // Hintergrund
  doc.save()
     .fillColor('#eeeeee')
     .rect(left, startY, usableWidth, headerHeight)
     .fill()
     .restore();
  // Linien
  doc.save().lineWidth(0.5).strokeColor('#cccccc');
  // Oben/Unten
  doc.moveTo(left,startY).lineTo(left+usableWidth,startY).stroke();
  doc.moveTo(left,startY+headerHeight).lineTo(left+usableWidth,startY+headerHeight).stroke();
  // Spalten-Trennlinien
  Object.values(pos).forEach(x=> doc.moveTo(x,startY).lineTo(x,startY+headerHeight).stroke());
  doc.restore();
  // Text
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER).fillColor('black');
  const yText = startY + V_SPACE.TINY;
  doc.text('Datum',     pos.date,     yText, { width:cols.date });
  doc.text('Arbeits-\nbeginn', pos.start,    yText, { width:cols.start,align:'center' });
  doc.text('Arbeits-\nende',  pos.end,      yText, { width:cols.end,  align:'center' });
  doc.text('Soll-Zeit', pos.expected, yText, { width:cols.expected,align:'center' });
  doc.text('Ist-Zeit',  pos.actual,   yText, { width:cols.actual, align:'center' });
  doc.text('Diff',      pos.diff,     yText, { width:cols.diff,   align:'center' });
  // Return
  return {
    headerBottomY: startY + headerHeight + V_SPACE.SMALL,
    colWidths: cols,
    colPositions: pos,
    headerHeight
  };
}

function drawPageNumber(doc, pageNum) {
  const left = doc.page.margins.left;
  const bottomY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
     .text(`Seite ${pageNum}`, left, bottomY, { width, align:'center' });
}

function drawSignatureFooter(doc, startY) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).fillColor('black');
  const text = 'Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden.';
  doc.text(text, left, startY, { width });
  let y = startY + doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP;
  doc.moveTo(left,y).lineTo(left+200,y).stroke();
  doc.text('Datum, Unterschrift', left, y + V_SPACE.SMALL);
}

function isAdmin(req,res,next){
  if(req.session?.isAdmin) next();
  else res.status(403).send('Zugriff verweigert');
}

module.exports = function(db) {
  // Test-Route
  router.get('/test', (req,res) => res.send('PDF Route Test OK'));

  // Monats-PDF
  router.get('/create-monthly-pdf', isAdmin, async (req,res) => {
    try {
      const { name, year, month } = req.query;
      if (!name || !year || !month || isNaN(+year)||isNaN(+month)||month<1||month>12) {
        return res.status(400).send('Parameter fehlen oder ungültig');
      }
      const y = +year; const m = +month;
      const data = await calculateMonthlyData(db, name, y, m);
      if (!data) throw new Error('Daten nicht abrufbar');

      const doc = new PDFDocument(PAGE_OPTIONS);
      doc.pipe(res);
      const safe = (data.employeeName||'Unbekannt').replace(/[^a-z0-9_\-]/gi,'_');
      const filename = `Monatsnachweis_${safe}_${String(m).padStart(2,'0')}_${y}.pdf`;
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);

      let page = 0;
      // Seite 1 anlegen
      page++; doc.addPage();
      const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // Header & Nummer
      let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2,'0')}/${y}`, data.employeeName,
                                   new Date(Date.UTC(y,m-1,1)), new Date(Date.UTC(y,m,0)) );
      drawPageNumber(doc, page);

      // Tabelle
      const table = drawTableHeader(doc, yPos, uW);
      yPos = table.headerBottomY;
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black').lineGap(1.5);
      doc.y = yPos;

      const allDays = [];
      data.workEntries.forEach(e => allDays.push({date:e.date,type:'WORK',start:e.startTime,end:e.endTime,actual:+e.hours||0}));
      data.absenceEntries.forEach(a => { if(!allDays.find(d=>d.date===a.date)) allDays.push({date:a.date,type:a.type,actual:+a.hours||0,comment:a.comment}); });
      allDays.sort((a,b)=>new Date(a.date)-new Date(b.date));

      const left = doc.page.margins.left;
      allDays.forEach((d,i) => {
        // Seitenumbruch
        if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - FOOTER_TOTAL_HEIGHT - SUMMARY_TOTAL_HEIGHT) {
          page++; doc.addPage(); drawPageNumber(doc,page);
          const next = drawTableHeader(doc, doc.page.margins.top, uW);
          doc.y = next.headerBottomY;
        }
        // Werte
        const expH = getExpectedHours(data.employeeData, d.date);
        const actH = d.actual;
        const diffH= actH-expH;
        const sDate = formatDateGermanWithWeekday(d.date);
        const sStart= d.type==='WORK'?d.start:'--:--';
        const sEnd  = d.type==='WORK'?d.end:'--:--';
        const sExp  = decimalHoursToHHMM(expH);
        const sAct  = decimalHoursToHHMM(actH);
        const sDiff = decimalHoursToHHMM(diffH);
        const p = table.colPositions;
        const w = table.colWidths;
        // Zeichnen
        doc.text(sDate,p.date,doc.y,{width:w.date});
        doc.text(sStart,p.start,doc.y,{width:w.start,align:'right'});
        doc.text(sEnd,p.end,doc.y,{width:w.end,align:d.type==='WORK'?'right':'left'});
        doc.text(sExp,p.expected,doc.y,{width:w.expected,align:'right'});
        doc.text(sAct,p.actual,doc.y,{width:w.actual,align:'right'});
        doc.text(sDiff,p.diff,doc.y,{width:w.diff,align:'right'});
        doc.y += TABLE_ROW_HEIGHT;
        // Zeilentrenner
        doc.save().lineWidth(0.25).strokeColor('#dddddd')
           .moveTo(left, doc.y-1).lineTo(left+uW, doc.y-1).stroke().restore();
      });
      // Tabellenrahmen
      const topY = table.headerBottomY - table.headerHeight - V_SPACE.SMALL;
      const botY = doc.y;
      doc.save().lineWidth(0.5).strokeColor('#999999')
         .rect(left, topY, uW, botY-topY).stroke().restore();

      // Zusammenfassung & Footer
      if (doc.y + SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT > doc.page.height - doc.page.margins.bottom) {
        page++; doc.addPage(); drawPageNumber(doc,page); doc.y = doc.page.margins.top;
      } else {
        doc.y += V_SPACE.LARGE;
      }
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
      const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - V_SPACE.SMALL;
      const valX = table.colPositions.actual;
      doc.text('Übertrag Vormonat:', left, doc.y, {width:lblW});
      doc.text(decimalHoursToHHMM(data.previousCarryOver), valX, doc.y, { width: table.colWidths.actual+table.colWidths.diff, align:'right' });
      doc.moveDown(0.5);
      doc.text('Gesamt Soll (Monat):', left, doc.y, {width:lblW});
      doc.text(decimalHoursToHHMM(data.totalExpected), valX, doc.y, { width: table.colWidths.actual+table.colWidths.diff, align:'right' });
      doc.moveDown(0.5);
      doc.text('Gesamt Ist (Monat):', left, doc.y, {width:lblW});
      doc.text(decimalHoursToHHMM(data.totalActual), valX, doc.y, { width: table.colWidths.actual+table.colWidths.diff, align:'right' });
      doc.moveDown(0.5);
      doc.text('Differenz:', left, doc.y, {width:lblW});
      doc.text(decimalHoursToHHMM(data.totalActual-data.totalExpected), valX, doc.y, { width: table.colWidths.actual+table.colWidths.diff, align:'right' });

      // Signatur-Footer
      drawSignatureFooter(doc, doc.y + V_SPACE.LARGE);
      doc.end();
    } catch (err) {
      console.error('PDF-Fehler:', err);
      res.status(500).send('Fehler bei PDF-Erstellung');
    }
  });

  return router;
};
