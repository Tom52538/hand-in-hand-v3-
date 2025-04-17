// monthlyPdfEndpoint.js - V18: Ein-Zeilen-Datensätze via Monospace-Padding
const express     = require('express');
const PDFDocument = require('pdfkit');
const path        = require('path');
const router      = express.Router();

// Berechnungsfunktionen importieren
const { calculateMonthlyData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Times-Roman';
const FONT_MONO   = 'Courier';
const FONT_BOLD   = 'Times-Bold';
const PAGE_OPTIONS = { size:'A4', autoFirstPage:false, margins:{ top:25,bottom:35,left:40,right:40 } };
const V_SPACE = { TINY:1, SMALL:4, MEDIUM:10, LARGE:18, SIGNATURE_GAP:45 };
const FONT_SIZE = { HEADER:16, SUB_HEADER:11, TABLE_CONTENT:7, SUMMARY:8, FOOTER:8, PAGE_NUMBER:8 };
const TABLE_ROW_HEIGHT     = 10;
const FOOTER_TOTAL_HEIGHT  = FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.MEDIUM;
const SUMMARY_TOTAL_HEIGHT = (7 * (FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5)) + V_SPACE.LARGE;

function padRight(str,len){ return str + ' '.repeat(Math.max(0,len-str.length)); }
function padLeft(str,len){ return ' '.repeat(Math.max(0,len-str.length)) + str; }

function formatDateGermanWithWeekday(dateInput) {
  if(!dateInput) return 'N/A';
  const d = new Date(((dateInput instanceof Date)?dateInput.toISOString().split('T')[0]:String(dateInput).split('T')[0])+'T00:00:00Z');
  return isNaN(d)?String(dateInput):d.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'});
}

function decimalHoursToHHMM(hours){
  if(isNaN(hours)||hours===null) return '00:00';
  const sign = hours<0?'-':'';
  const absH = Math.abs(hours);
  const m = Math.round(absH*60)%60;
  const h = Math.floor(Math.round(absH*60)/60);
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function isAdmin(req,res,next){ if(req.session?.isAdmin) next(); else res.status(403).send('Zugriff verweigert'); }

module.exports = function(db){
  // Monats-PDF
  router.get('/create-monthly-pdf', isAdmin, async (req,res)=>{
    try {
      const { name, year, month } = req.query;
      if(!name||!year||!month||isNaN(+year)||isNaN(+month)||month<1||month>12)
        return res.status(400).send('Parameter ungültig');
      const y=+year,m=+month;
      const data = await calculateMonthlyData(db,name,y,m);
      if(!data) throw new Error('Keine Daten');

      const doc = new PDFDocument(PAGE_OPTIONS);
      doc.pipe(res);
      const safe = (data.employeeName||'Unbekannt').replace(/[^a-z0-9_\-]/gi,'_');
      const file = `Monatsnachweis_${safe}_${String(m).padStart(2,'0')}_${y}.pdf`;
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${file}"`);

      // Header
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).text(`Monatsnachweis ${String(m).padStart(2,'0')}/${y}`, { align:'center' });
      doc.moveDown(0.5);
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER)
         .text(`Name: ${data.employeeName}`,{ align:'left' });
      doc.text(`Zeitraum: 01.${String(m).padStart(2,'0')}.${y} - 30.${String(m).padStart(2,'0')}.${y}`,{ align:'left' });
      doc.moveDown(1);

      // Tabellen-Überschrift (Monospace)
      doc.font(FONT_MONO).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
      const headerLine = padRight('Datum',17)
                       +padLeft('Start',6)
                       +padLeft('Ende',6)
                       +padLeft('Soll',6)
                       +padLeft('Ist',6)
                       +padLeft('Diff',6);
      doc.text(headerLine, doc.page.margins.left);
      doc.moveDown(0.2);

      // Datenzeilen (Monospace)
      const lm=doc.page.margins.left;
      data.workEntries.concat(data.absenceEntries).map(e=>{
        const date = formatDateGermanWithWeekday(e.date);
        const start = e.startTime||'--:--';
        const end   = e.endTime  ||'--:--';
        const actual=+e.hours||0;
        const expected = getExpectedHours(data.employeeData,e.date);
        const diff = actual-expected;
        return {date,start,end,actual,expected,diff};
      }).sort((a,b)=>new Date(a.date)-new Date(b.date))
        .forEach(row=>{
          const line = padRight(row.date,17)
                       +padLeft(row.start,6)
                       +padLeft(row.end,6)
                       +padLeft(decimalHoursToHHMM(row.expected),6)
                       +padLeft(decimalHoursToHHMM(row.actual),6)
                       +padLeft(decimalHoursToHHMM(row.diff),6);
          doc.text(line,lm,doc.y);
          doc.moveDown(0.3);
        });

      // Summary & Footer
      doc.moveDown(1);
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY);
      doc.text(`Übertrag Vormonat: ${decimalHoursToHHMM(data.previousCarryOver)}`);
      doc.text(`Gesamt Soll:        ${decimalHoursToHHMM(data.totalExpected)}`);
      doc.text(`Gesamt Ist:         ${decimalHoursToHHMM(data.totalActual)}`);
      doc.text(`Differenz:          ${decimalHoursToHHMM(data.totalActual-data.totalExpected)}`);
      doc.moveDown(2);
      doc.text('Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden.');
      doc.moveDown(1);
      doc.text('Datum, Unterschrift: _____________________________');

      doc.end();
    } catch(err) {
      console.error(err);
      res.status(500).send('PDF-Fehler');
    }
  });
  return router;
};
