// monthlyPdfEndpoint.js - V13: Robuste, vollständige Version
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere Berechnungsfunktionen
const { calculateMonthlyData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Times-Roman';
const FONT_BOLD   = 'Times-Bold';
const PAGE_OPTIONS = { size: 'A4', autoFirstPage: false, margins: { top: 25, bottom: 35, left: 40, right: 40 } };
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { HEADER: 16, SUB_HEADER: 11, TABLE_HEADER: 9, TABLE_CONTENT: 9, SUMMARY: 8, FOOTER: 8, PAGE_NUMBER: 8 };
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
  const d = new Date((dateInput instanceof Date ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0]) + 'T00:00:00Z');
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

function formatDateGermanWithWeekday(dateInput) {
  if (!dateInput) return 'N/A';
  const d = new Date((dateInput instanceof Date ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0]) + 'T00:00:00Z');
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE',{ weekday:'short', day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

function drawDocumentHeader(doc, title, name, startDate, endDate) {
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const width = doc.page.width - left - right;
  let y = doc.page.margins.top;
  try {
    const logo = path.join(process.cwd(),'public','icons','Hand-in-Hand-Logo-192x192.png');
    doc.image(logo, doc.page.width - right - 70, y, { width:70, height:70 });
  } catch {}
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
  doc.text(title, left, y + V_SPACE.SMALL, { align:'center', width });
  y += V_SPACE.SMALL + doc.heightOfString(title,{ width, align:'center' }) + V_SPACE.LARGE;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
  doc.text(`Name: ${name||'Unbekannt'}`, left, y);
  y += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
  doc.text(`Zeitraum: ${formatDateGerman(startDate)} - ${formatDateGerman(endDate)}`, left, y);
  return y + FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
}

function drawTableHeader(doc, startY, usableWidth) {
  if (!usableWidth || usableWidth <=0) throw new Error('Invalid usableWidth');
  const left = doc.page.margins.left;
  const cols = { date:105, start:65, end:85, expected:75, actual:75 };
  cols.diff = Math.max(30, usableWidth - Object.values(cols).reduce((a,b)=>a+b,0));
  const pos = { date:left };
  pos.start = pos.date + cols.date;
  pos.end = pos.start + cols.start;
  pos.expected = pos.end + cols.end;
  pos.actual = pos.expected + cols.expected;
  pos.diff = pos.actual + cols.actual;
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);
  const y = startY + V_SPACE.TINY;
  doc.text('Datum', pos.date, y, { width:cols.date });
  doc.text('Arbeits-\nbeginn', pos.start, y, { width:cols.start, align:'center' });
  doc.text('Arbeits-\nande', pos.end, y, { width:cols.end, align:'center' });
  doc.text('Soll-Zeit', pos.expected, y, { width:cols.expected, align:'center' });
  doc.text('Ist-Zeit', pos.actual, y, { width:cols.actual, align:'center' });
  doc.text('Diff', pos.diff, y, { width:cols.diff, align:'center' });
  const bottom = startY + (FONT_SIZE.TABLE_HEADER*2) + V_SPACE.TINY + V_SPACE.SMALL;
  doc.moveTo(left, bottom).lineTo(left+usableWidth, bottom).lineWidth(0.5).stroke();
  return { headerBottomY: bottom+V_SPACE.SMALL, colWidths:cols, colPositions:pos };
}

function drawPageNumber(doc, pageNum) {
  const left = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).
    text(`Seite ${pageNum}`, left, bottom, { width, align:'center' });
}

function drawSignatureFooter(doc, startY) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER);
  const text = 'Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden.';
  doc.text(text, left, startY, { width });
  let y = startY + doc.heightOfString(text,{ width }) + V_SPACE.SIGNATURE_GAP;
  doc.moveTo(left, y).lineTo(left+200,y).stroke();
  doc.text('Datum, Unterschrift', left, y+V_SPACE.SMALL);
}

function isAdmin(req,res,next){ if(req.session?.isAdmin) return next(); res.status(403).send('Zugriff verweigert'); }

module.exports = function(db){
  router.get('/test',(req,res)=>res.send('PDF Route Test OK'));
  router.get('/create-monthly-pdf',isAdmin,async(req,res)=>{
    try{
      const { name, year, month } = req.query;
      if(!name||!year||!month||isNaN(+year)||isNaN(+month)||month<1||month>12)
        return res.status(400).send('Parameter fehlen oder ungültig');
      const y=+year, m=+month;
      const data = await calculateMonthlyData(db,name,y,m);
      if(!data) throw new Error('Daten nicht abrufbar');
      const doc=new PDFDocument(PAGE_OPTIONS);
      doc.pipe(res);
      const fileName=`Monatsnachweis_${(data.employeeName||'Unbekannt').replace(/[^a-z0-9_\-]/gi,'_')}_${String(m).padStart(2,'0')}_${y}.pdf`;
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);
      let page=0;
      page++; doc.addPage();
      const uW=doc.page.width-doc.page.margins.left-doc.page.margins.right;
      let yPos=drawDocumentHeader(doc,`Monatsnachweis ${String(m).padStart(2,'0')}/${y}`,data.employeeName,new Date(Date.UTC(y,m-1,1)),new Date(Date.UTC(y,m,0)));
      drawPageNumber(doc,page);
      let tbl=drawTableHeader(doc,yPos,uW);
      yPos=tbl.headerBottomY;
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); doc.y=yPos;
      const days=[];
      data.workEntries.forEach(e=>days.push({ date:e.date, type:'WORK', startTime:e.startTime, endTime:e.endTime, actual:+e.hours||0 }));
      data.absenceEntries.forEach(a=>{ if(!days.find(d=>d.date===a.date)) days.push({ date:a.date, type:a.type, actual:+a.hours||0, comment:a.comment }); });
      days.sort((a,b)=>new Date(a.date)-new Date(b.date));
      if(days.length===0) doc.text('Keine Buchungen/Abwesenheiten',{ width:uW });
      else for(let i=0;i<days.length;i++){
        if(doc.y+TABLE_ROW_HEIGHT>doc.page.height-doc.page.margins.bottom-FOOTER_TOTAL_HEIGHT-SUMMARY_TOTAL_HEIGHT){ page++; doc.addPage(); drawPageNumber(doc,page); tbl=drawTableHeader(doc,doc.page.margins.top,uW); doc.y=tbl.headerBottomY; }
        const d=days[i];
        const expH=getExpectedHours(data.employeeData,d.date);
        const actH=d.actual;
        const diffH=actH-expH;
        const dateTxt=formatDateGermanWithWeekday(d.date);
        const startTxt=d.type==='WORK'?d.startTime:'--:--';
        const endTxt=d.type==='WORK'?d.endTime:'--:--';
        const expTxt=decimalHoursToHHMM(expH);
        const actTxt=decimalHoursToHHMM(actH);
        const diffTxt=decimalHoursToHHMM(diffH);
        const pos=tbl.colPositions, w=tbl.colWidths;
        doc.text(dateTxt,pos.date,doc.y,{ width:w.date });
        doc.text(startTxt,pos.start,doc.y,{ width:w.start });
        doc.text(endTxt,pos.end,doc.y,{ width:w.end });
        doc.text(expTxt,pos.expected,doc.y,{ width:w.expected, align:'right' });
        doc.text(actTxt,pos.actual,doc.y,{ width:w.actual, align:'right' });
        doc.text(diffTxt,pos.diff,doc.y,{ width:w.diff, align:'right' });
        doc.y+=TABLE_ROW_HEIGHT;
      }
      // Zusammenfassung
      if(doc.y+SUMMARY_TOTAL_HEIGHT+FOOTER_TOTAL_HEIGHT>doc.page.height-doc.page.margins.bottom){ page++; doc.addPage(); drawPageNumber(doc,page); doc.y=doc.page.margins.top; }
      else doc.y+=V_SPACE.LARGE;
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
      const lblW=tbl.colWidths.date+tbl.colWidths.start+tbl.colWidths.end+tbl.colWidths.expected-V_SPACE.SMALL;
      const valX=tbl.colPositions.actual;
      doc.text('Übertrag Vormonat:',tbl.colPositions.date,doc.y,{ width:lblW }); doc.text(decimalHoursToHHMM(data.previousCarryOver),valX,doc.y,{ width:tbl.colWidths.actual+tbl.colWidths.diff, align:'right' }); doc.moveDown(0.5);
      doc.text('Gesamt Soll:',tbl.colPositions.date,doc.y,{ width:lblW }); doc.text(decimalHoursToHHMM(data.totalExpected),valX,doc.y,{ width:tbl.colWidths.actual+tbl.colWidths.diff, align:'right' }); doc.moveDown(0.5);
      doc.text('Gesamt Ist:',tbl.colPositions.date,doc.y,{ width:lblW }); doc.text(decimalHoursToHHMM(data.totalActual),valX,doc.y,{ width:tbl.colWidths.actual+tbl.colWidths.diff, align:'right' }); doc.moveDown(0.5);
      doc.text('Differenz:',tbl.colPositions.date,doc.y,{ width:lblW }); doc.text(decimalHoursToHHMM(data.totalActual-data.totalExpected),valX,doc.y,{ width:tbl.colWidths.actual+tbl.colWidths.diff, align:'right' });
      drawSignatureFooter(doc,doc.y+V_SPACE.LARGE);
      doc.end();
    }catch(err){ console.error(err); res.status(500).send('Fehler bei PDF-Erzeugung'); }
  });
  return router;
};
