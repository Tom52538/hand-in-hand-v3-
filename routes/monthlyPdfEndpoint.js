// monthlyPdfEndpoint.js - V15: Alle Datensätze in einer Zeile
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Berechnungsfunktionen importieren
const { calculateMonthlyData, getExpectedHours } = require('../utils/calculationUtils');

// Konstante Werte
const FONT_NORMAL = 'Times-Roman';
const FONT_BOLD   = 'Times-Bold';
const PAGE_OPTIONS = { size: 'A4', autoFirstPage: false, margins: { top:25, bottom:35, left:40, right:40 } };
const V_SPACE = { TINY:1, SMALL:4, MEDIUM:10, LARGE:18, SIGNATURE_GAP:45 };
const FONT_SIZE = { HEADER:16, SUB_HEADER:11, TABLE_HEADER:9, TABLE_CONTENT:9, SUMMARY:8, FOOTER:8, PAGE_NUMBER:8 };
const TABLE_ROW_HEIGHT = 12;
const FOOTER_TOTAL_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.MEDIUM;
const SUMMARY_TOTAL_HEIGHT = (7 * (FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5)) + V_SPACE.LARGE;

function decimalHoursToHHMM(hours) {
  if (isNaN(hours) || hours === null) return '00:00';
  const sign = hours < 0 ? '-' : '';
  const absH = Math.abs(hours);
  const mins = Math.round(absH * 60);
  const h = Math.floor(mins/60);
  const m = mins % 60;
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function formatDateGerman(date) {
  if (!date) return 'N/A';
  const str = (date instanceof Date ? date.toISOString().split('T')[0] : String(date).split('T')[0]) + 'T00:00:00Z';
  const d = new Date(str);
  return isNaN(d) ? String(date) : d.toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'});
}

function formatDateGermanWithWeekday(date) {
  if (!date) return 'N/A';
  const str = (date instanceof Date ? date.toISOString().split('T')[0] : String(date).split('T')[0]) + 'T00:00:00Z';
  const d = new Date(str);
  return isNaN(d) ? String(date) : d.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'});
}

function drawDocumentHeader(doc,title,name,start,end) {
  const lm = doc.page.margins.left, rm = doc.page.margins.right;
  const w = doc.page.width - lm - rm;
  const y0 = doc.page.margins.top;
  try { doc.image(path.join(process.cwd(),'public','icons','Hand-in-Hand-Logo-192x192.png'), doc.page.width-rm-70, y0, {width:70,height:70}); } catch {}
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).fillColor('black')
     .text(title, lm, y0+V_SPACE.SMALL, {align:'center',width:w});
  const y1 = y0 + V_SPACE.SMALL + doc.heightOfString(title,{width:w,align:'center'}) + V_SPACE.LARGE;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER)
     .text(`Name: ${name||'Unbekannt'}`, lm, y1)
     .text(`Zeitraum: ${formatDateGerman(start)} - ${formatDateGerman(end)}`, lm, y1 + FONT_SIZE.SUB_HEADER + V_SPACE.SMALL);
  return y1 + 2*(FONT_SIZE.SUB_HEADER+V_SPACE.SMALL);
}

function drawTableHeader(doc,yStart,usableWidth) {
  const left=doc.page.margins.left;
  const col = {date:100,start:70,end:70,expected:80,actual:80};
  col.diff = Math.max(30, usableWidth - (col.date+col.start+col.end+col.expected+col.actual));
  const pos = {date:left, start:left+col.date, end:left+col.date+col.start, expected:left+col.date+col.start+col.end, actual:left+col.date+col.start+col.end+col.expected};
  pos.diff = pos.actual + col.actual;
  const hH = FONT_SIZE.TABLE_HEADER*2 + V_SPACE.TINY + V_SPACE.SMALL;
  // Hintergrund & Linien
  doc.save().fillColor('#f0f0f0').rect(left,yStart,usableWidth,hH).fill().restore();
  doc.save().lineWidth(0.5).strokeColor('#999999')
     .moveTo(left,yStart).lineTo(left+usableWidth,yStart).stroke()
     .moveTo(left,yStart+hH).lineTo(left+usableWidth,yStart+hH).stroke();
  [pos.start,pos.end,pos.expected,pos.actual,pos.diff].forEach(x=>doc.moveTo(x,yStart).lineTo(x,yStart+hH).stroke());
  doc.restore().font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER).fillColor('black');
  const yT = yStart + V_SPACE.TINY;
  doc.text('Datum',pos.date,yT,{width:col.date})
     .text('Arbeitsbeginn',pos.start,yT,{width:col.start,align:'center'})
     .text('Arbeitsende',pos.end,yT,{width:col.end,align:'center'})
     .text('Soll (HH:MM)',pos.expected,yT,{width:col.expected,align:'center'})
     .text('Ist (HH:MM)',pos.actual,yT,{width:col.actual,align:'center'})
     .text('Diff',pos.diff,yT,{width:col.diff,align:'center'});
  return {headerBottomY:yStart+hH+V_SPACE.SMALL,colWidths:col,colPositions:pos,headerHeight:hH};
}

function drawPageNumber(doc,num) {
  const lm=doc.page.margins.left;
  const y=doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
  const w=doc.page.width-lm-doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
     .text(`Seite ${num}`,lm,y,{width:w,align:'center'});
}

function drawSignatureFooter(doc,startY) {
  const lm=doc.page.margins.left;
  const w=doc.page.width-lm-doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).fillColor('black')
     .text('Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden.',lm,startY,{width:w});
  const y1=startY+doc.heightOfString('',{width:w})+V_SPACE.SIGNATURE_GAP;
  doc.moveTo(lm,y1).lineTo(lm+200,y1).stroke()
     .text('Datum, Unterschrift',lm,y1+V_SPACE.SMALL);
}

function isAdmin(req,res,next){if(req.session?.isAdmin) next(); else res.status(403).send('Zugriff verweigert');}

// Export des Routers
module.exports = function(db){
  router.get('/test',(req,res)=>res.send('PDF Route Test OK'));
  router.get('/create-monthly-pdf',isAdmin,async(req,res)=>{
    try{
      const {name,year,month}=req.query;
      if(!name||!year||!month||isNaN(+year)||isNaN(+month)||month<1||month>12)
        return res.status(400).send('Parameter fehlen oder ungültig');
      const y=+year,m=+month;
      const data=await calculateMonthlyData(db,name,y,m);
      if(!data) throw new Error('Daten nicht abrufbar');
      const doc=new PDFDocument(PAGE_OPTIONS);
      doc.pipe(res);
      const fn=`Monatsnachweis_${(data.employeeName||'Unbekannt').replace(/[^a-z0-9_\-]/gi,'_')}_${String(m).padStart(2,'0')}_${y}.pdf`;
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${fn}"`);
      let page=0;
      page++; doc.addPage();
      const uW=doc.page.width-doc.page.margins.left-doc.page.margins.right;
      let yPos=drawDocumentHeader(doc,`Monatsnachweis ${String(m).padStart(2,'0')}/${y}`,data.employeeName,new Date(Date.UTC(y,m-1,1)),new Date(Date.UTC(y,m,0)));
      drawPageNumber(doc,page);
      const tbl=drawTableHeader(doc,yPos,uW);
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black').lineGap(1.5);
      doc.y=tbl.headerBottomY;
      const days=[];
      data.workEntries.forEach(e=>days.push({date:e.date,type:'WORK',start:e.startTime,end:e.endTime,actual:+e.hours||0}));
      data.absenceEntries.forEach(a=>{if(!days.find(d=>d.date===a.date))days.push({date:a.date,type:a.type,actual:+a.hours||0,comment:a.comment});});
      days.sort((a,b)=>new Date(a.date)-new Date(b.date));
      const lm=doc.page.margins.left;
      days.forEach(d=>{
        if(doc.y+TABLE_ROW_HEIGHT>doc.page.height-doc.page.margins.bottom-FOOTER_TOTAL_HEIGHT-SUMMARY_TOTAL_HEIGHT){page++;doc.addPage();drawPageNumber(doc,page);const next=drawTableHeader(doc,doc.page.margins.top,uW);doc.y=next.headerBottomY;}
        const expH=getExpectedHours(data.employeeData,d.date),actH=d.actual,diffH=actH-expH;
        const dt=formatDateGermanWithWeekday(d.date),st=d.type==='WORK'?d.start:'--:--',et=d.type==='WORK'?d.end:'--:--';
        const sExp=decimalHoursToHHMM(expH),sAct=decimalHoursToHHMM(actH),sDiff=decimalHoursToHHMM(diffH);
        const p=tbl.colPositions,c=tbl.colWidths;
        doc.text(dt,p.date,doc.y,{width:c.date})
           .text(st,p.start,doc.y,{width:c.start,align:'right'})
           .text(et,p.end,doc.y,{width:c.end,align:'right'})
           .text(sExp,p.expected,doc.y,{width:c.expected,align:'right'})
           .text(sAct,p.actual,doc.y,{width:c.actual,align:'right'})
           .text(sDiff,p.diff,doc.y,{width:c.diff,align:'right'});
        doc.y+=TABLE_ROW_HEIGHT;
        doc.save().lineWidth(0.25).strokeColor('#dddddd').moveTo(lm,doc.y-1).lineTo(lm+uW,doc.y-1).stroke().restore();
      });
      const topY=tbl.headerBottomY-tbl.headerHeight-V_SPACE.SMALL,botY=doc.y;
      doc.save().lineWidth(0.5).strokeColor('#999999').rect(lm,topY,uW,botY-topY).stroke().restore();
      if(doc.y+SUMMARY_TOTAL_HEIGHT+FOOTER_TOTAL_HEIGHT>doc.page.height-doc.page.margins.bottom){page++;doc.addPage();drawPageNumber(doc,page);doc.y=doc.page.margins.top;}else doc.y+=V_SPACE.LARGE;
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
      const lblW=tbl.colWidths.date+tbl.colWidths.start+tbl.colWidths.end+tbl.colWidths.expected-V_SPACE.SMALL;
      const valX=tbl.colPositions.actual;
      doc.text('Übertrag Vormonat:',lm,doc.y,{width:lblW}).text(decimalHoursToHHMM(data.previousCarryOver),valX,doc.y,{width:tbl.colWidths.actual+tbl.colWidths.diff,align:'right'});
      doc.moveDown(0.5)
         .text('Gesamt Soll (Monat):',lm,doc.y,{width:lblW}).text(decimalHoursToHHMM(data.totalExpected),valX,doc.y,{width:tbl.colWidths.actual+tbl.colWidths.diff,align:'right'});
      doc.moveDown(0.5)
         .text('Gesamt Ist (Monat):',lm,doc.y,{width:lblW}).text(decimalHoursToHHMM(data.totalActual),valX,doc.y,{width:tbl.colWidths.actual+tbl.colWidths.diff,align:'right'});
      doc.moveDown(0.5)
         .text('Differenz:',lm,doc.y,{width:lblW}).text(decimalHoursToHHMM(data.totalActual-data.totalExpected),valX,doc.y,{width:tbl.colWidths.actual+tbl.colWidths.diff,align:'right'});
      drawSignatureFooter(doc,doc.y+V_SPACE.LARGE);
      doc.end();
    } catch(err) {
      console.error('PDF-Fehler:',err);
      res.status(500).send('Fehler bei PDF-Erstellung');
    }
  });
  return router;
};
