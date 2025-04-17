// monthlyPdfEndpoint.js - V15: Aggregation pro Tag integriert
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
  margins: { top: 25, bottom: 35, left: 40, right: 40 } // Originalwerte beibehalten
};
// Vertikale Abstände - Können bei Bedarf noch optimiert werden
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { // Originalwerte beibehalten
  HEADER: 16, SUB_HEADER: 11,
  TABLE_HEADER: 9, TABLE_CONTENT: 9,
  SUMMARY: 8, FOOTER: 8, PAGE_NUMBER: 8
};
const TABLE_ROW_HEIGHT = 12; // Originalwert beibehalten
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL;
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL;
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM;
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5; // Unverändert
const SUMMARY_TOTAL_HEIGHT = (7 * SUMMARY_LINE_HEIGHT) + V_SPACE.LARGE; // Unverändert - Prüfen ob 7 Zeilen noch korrekt ist

// --- Hilfsfunktionen (unverändert) ---

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
  // Stellt sicher, dass die Eingabe als UTC behandelt wird, um Zeitzonenprobleme zu vermeiden
  const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
  const d = new Date(str + 'T00:00:00Z'); // Explizit UTC
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

function formatDateGermanWithWeekday(dateInput) {
  if (!dateInput) return 'N/A';
  const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
  const d = new Date(str + 'T00:00:00Z'); // Explizit UTC
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

// --- PDF Zeichnungsfunktionen (unverändert) ---

function drawDocumentHeader(doc, title, name, startDate, endDate) {
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const width = doc.page.width - left - right;
  let y = doc.page.margins.top;
  // Logo
  try {
    const logoPath = path.join(process.cwd(),'public','icons','Hand-in-Hand-Logo-192x192.png');
    doc.image(logoPath, doc.page.width - right - 70, y, { width:70, height:70 }); // Originalgröße
  } catch (err) {
      console.error("Fehler beim Laden des Logos:", err);
  }
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

// WICHTIG: table Objekt wird jetzt außerhalb der Schleife mit let deklariert
// Die Funktion selbst bleibt aber wie sie war.
function drawTableHeader(doc, startY, usableWidth) {
  const left = doc.page.margins.left;
  // Spaltenbreiten (Originalwerte beibehalten - ggf. anpassen)
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
  doc.moveTo(left,startY).lineTo(left+usableWidth,startY).stroke();
  doc.moveTo(left,startY+headerHeight).lineTo(left+usableWidth,startY+headerHeight).stroke();
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
    headerHeight // Wird für Tabellenrahmen benötigt
  };
}
// --- Weitere Hilfsfunktionen (unverändert) ---
function drawPageNumber(doc, pageNum) {
  const left = doc.page.margins.left;
  const bottomY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM; // Platzierung unten
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
  let y = startY + doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP; // Nutzt V_SPACE.SIGNATURE_GAP
  doc.moveTo(left,y).lineTo(left+200,y).stroke(); // Linie für Unterschrift
  doc.text('Datum, Unterschrift', left, y + V_SPACE.SMALL);
}

// --- Middleware (unverändert) ---
function isAdmin(req,res,next){
  if(req.session?.isAdmin) {
      next();
  } else {
      // Optional: Bessere Fehlermeldung oder Redirect
      res.status(403).send('Zugriff verweigert. Sie müssen Administrator sein.');
  }
}
// --- Haupt-Export und Route ---
module.exports = function(db) {

  // Test-Route (unverändert)
  router.get('/test', (req,res) => res.send('PDF Route Test OK'));

  // Monats-PDF Erstellung
  router.get('/create-monthly-pdf', isAdmin, async (req,res) => {
    try {
      const { name, year, month } = req.query;
      // Verbesserte Validierung
      if (!name || !year || !month) {
        return res.status(400).send('Parameter name, year und month sind erforderlich.');
      }
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12 || y < 2000 || y > 2100) { // Beispielhafte Jahresprüfung
        return res.status(400).send('Ungültige Werte für Jahr oder Monat.');
      }

      // Daten abrufen (wie zuvor)
      const data = await calculateMonthlyData(db, name, y, m);
      if (!data || !data.employeeName || !data.workEntries || !data.absenceEntries) {
          // Detailliertere Fehlermeldung, falls Daten unvollständig sind
          console.error("Unvollständige Daten von calculateMonthlyData für:", name, y, m);
          return res.status(404).send(`Keine vollständigen Daten für ${name} im Zeitraum ${String(m).padStart(2,'0')}/${y} gefunden.`);
      }

      // --- NEU: Datenaggregation pro Tag ---
      const dailyDataMap = {};

      // 1. Arbeitszeiten verarbeiten und aggregieren
      data.workEntries.forEach(e => {
        if (!e.date || !e.startTime || !e.endTime) {
            console.warn("Unvollständiger Arbeitseintrag übersprungen:", e);
            return; // Unvollständige Einträge überspringen
        }
        const dateStr = new Date(e.date).toISOString().split('T')[0];

        if (!dailyDataMap[dateStr]) {
          dailyDataMap[dateStr] = {
            date: new Date(e.date + 'T00:00:00Z'), // Datumsobjekt (UTC Mitternacht)
            type: 'WORK',
            totalHours: 0,
            firstStart: e.startTime,
            lastEnd: e.endTime,
            // intervals: [] // Optional: nur bei Bedarf einkommentieren
          };
        }

        const hours = parseFloat(e.hours) || 0;
        dailyDataMap[dateStr].totalHours += hours;

        if (e.startTime < dailyDataMap[dateStr].firstStart) {
           dailyDataMap[dateStr].firstStart = e.startTime;
        }
        if (e.endTime > dailyDataMap[dateStr].lastEnd) {
           dailyDataMap[dateStr].lastEnd = e.endTime;
        }
        // if(dailyDataMap[dateStr].intervals) dailyDataMap[dateStr].intervals.push({start: e.startTime, end: e.endTime, hours: hours});
      });

      // 2. Abwesenheiten verarbeiten (nur wenn kein Arbeitseintrag für den Tag existiert)
      data.absenceEntries.forEach(a => {
        if (!a.date || !a.type) {
            console.warn("Unvollständiger Abwesenheitseintrag übersprungen:", a);
            return;
        }
        const dateStr = new Date(a.date).toISOString().split('T')[0];

        if (!dailyDataMap[dateStr]) { // Nur hinzufügen, wenn Tag frei ist
          dailyDataMap[dateStr] = {
            date: new Date(a.date + 'T00:00:00Z'),
            type: a.type,
            totalHours: parseFloat(a.hours) || 0,
            comment: a.comment || null,
            firstStart: '--:--',
            lastEnd: '--:--'
          };
        }
      });

      // 3. Map in Array umwandeln und sortieren
      const aggregatedDays = Object.values(dailyDataMap);
      aggregatedDays.sort((a, b) => a.date - b.date);
      // --- Ende NEU: Datenaggregation ---


      // PDF Dokument initialisieren
      const doc = new PDFDocument(PAGE_OPTIONS);
      const safeName = (data.employeeName||'Unbekannt').replace(/[^a-z0-9_\-]/gi,'_');
      const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2,'0')}_${y}.pdf`;

      // Response Header setzen
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
      doc.pipe(res); // Pipe zum Response Stream

      let page = 0;
      // Erste Seite anlegen
      page++;
      doc.addPage();
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // usableWidth hier definieren
      const left = doc.page.margins.left; // left hier definieren

      // Dokumenten-Header zeichnen
      let yPos = drawDocumentHeader(doc,
                                   `Monatsnachweis ${String(m).padStart(2,'0')}/${y}`,
                                   data.employeeName,
                                   new Date(Date.UTC(y,m-1,1)), // Erster Tag des Monats UTC
                                   new Date(Date.UTC(y,m,0))    // Letzter Tag des Monats UTC
                                  );
      // Seitenzahl zeichnen (unten)
      drawPageNumber(doc, page);

      // Tabellen-Header zeichnen und wichtige Variablen speichern
      // WICHTIG: 'let' verwenden, damit 'table' bei Seitenumbruch neu zugewiesen werden kann
      let table = drawTableHeader(doc, yPos, usableWidth);
      yPos = table.headerBottomY; // Startposition für den ersten Eintrag

      // Schriftart für Tabelleninhalt setzen
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black').lineGap(1.5);
      doc.y = yPos; // Setzt den Startpunkt für den Textcursor
    // --- NEU: Iteration über aggregierte Tage ---
      aggregatedDays.forEach((d, i) => {
        // Prüfen auf Seitenumbruch VOR dem Zeichnen der Zeile
        // Die Logik prüft, ob die nächste Zeile PLUS der garantierte Footerbereich noch passt
        if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - FOOTER_TOTAL_HEIGHT) {
          // Hinweis: SUMMARY_TOTAL_HEIGHT wird hier nicht mehr abgezogen, da die Zusammenfassung
          // erst nach der Tabelle gezeichnet wird. Ggf. anpassen falls Layout anders gewünscht.
          page++;
          doc.addPage();
          drawPageNumber(doc, page); // Seitenzahl für neue Seite

          // Wichtig: Tabellenkopf auf neuer Seite neu zeichnen und 'table' neu zuweisen
          table = drawTableHeader(doc, doc.page.margins.top, usableWidth);
          doc.y = table.headerBottomY; // Y-Position auf neuer Seite setzen

          // Schriftart für neue Seite wieder setzen
          doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black').lineGap(1.5);
        }

        // Werte für die aktuelle Zeile holen (aus aggregierten Daten 'd')
        const expH = getExpectedHours(data.employeeData, d.date); // d.date ist das Datumsobjekt
        const actH = d.totalHours; // Aggregierte Stunden
        const diffH = actH - expH;

        const sDate = formatDateGermanWithWeekday(d.date);
        const sStart = d.type === 'WORK' ? (d.firstStart || '--:--') : '--:--'; // Frühester Start
        const sEnd   = d.type === 'WORK' ? (d.lastEnd || '--:--') : '--:--';   // Spätestes Ende

        const sExp  = decimalHoursToHHMM(expH);
        const sAct  = decimalHoursToHHMM(actH);
        const sDiff = decimalHoursToHHMM(diffH);

        // Spaltenpositionen und -breiten aus dem (ggf. neu gezeichneten) 'table'-Objekt holen
        const p = table.colPositions;
        const w = table.colWidths;

        // Text in die Zellen zeichnen
        // Die Y-Position wird automatisch von pdfkit verwaltet (doc.y)
        const currentY = doc.y; // Aktuelle Y-Position merken für alle Spalten dieser Zeile
        doc.text(sDate, p.date, currentY, { width: w.date });
        doc.text(sStart, p.start, currentY, { width: w.start, align: (sStart !== '--:--' ? 'right' : 'left') });
        doc.text(sEnd, p.end, currentY, { width: w.end, align: (sEnd !== '--:--' ? 'right' : 'left') });
        doc.text(sExp, p.expected, currentY, { width: w.expected, align: 'right' });
        doc.text(sAct, p.actual, currentY, { width: w.actual, align: 'right' });
        doc.text(sDiff, p.diff, currentY, { width: w.diff, align: 'right' });

        // Y-Position für die nächste Zeile erhöhen (NACH dem Zeichnen aller Spalten)
        doc.y = currentY + TABLE_ROW_HEIGHT;

        // Horizontale Trennlinie zeichnen (optional, aber hilfreich)
        doc.save().lineWidth(0.25).strokeColor('#dddddd')
           .moveTo(left, doc.y - 1).lineTo(left + usableWidth, doc.y - 1).stroke().restore();

      }); // Ende aggregatedDays.forEach
      // --- Ende NEU: Iteration ---


      // Gesamten Tabellenrahmen zeichnen (nachdem alle Zeilen gezeichnet wurden)
      // Berechne die Start Y-Position des Headers der ERSTEN Seite neu oder speichere sie
      // Hier nehmen wir an, dass 'yPos' immer noch die Startposition des ersten Headers enthält.
      // Sicherer wäre es, diese explizit zu speichern.
      const tableStartY = yPos - table.headerHeight - V_SPACE.SMALL; // Annahme: table bezieht sich auf die letzte Seite
      const tableEndY = doc.y -1; // Endet an der letzten Trennlinie

      // HINWEIS: Dieser Rahmen funktioniert so nur korrekt, wenn die Tabelle auf EINER Seite ist.
      // Für einen seitenübergreifenden Rahmen müsste man pro Seite zeichnen.
      // Für Einfachheit erstmal weggelassen oder nur auf der letzten Seite zeichnen.
      // doc.save().lineWidth(0.5).strokeColor('#999999')
      //    .rect(left, tableStartY, usableWidth, tableEndY - tableStartY).stroke().restore();
      // Stattdessen: Nur die untere Linie der Tabelle zeichnen
       doc.save().lineWidth(0.5).strokeColor('#999999')
          .moveTo(left, tableEndY).lineTo(left + usableWidth, tableEndY).stroke().restore();


      // Zusammenfassung & Footer
      // Prüfen, ob Zusammenfassung und Footer noch auf die AKTUELLE Seite passen
      if (doc.y + SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT > doc.page.height - doc.page.margins.bottom) {
        page++;
        doc.addPage();
        drawPageNumber(doc, page); // Seitenzahl für neue Seite
        doc.y = doc.page.margins.top; // Y-Position oben auf neuer Seite setzen
      } else {
        doc.y += V_SPACE.LARGE; // Abstand nach der Tabelle
      }
      // Zusammenfassung zeichnen (Logik unverändert, nutzt Gesamtwerte aus 'data')
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
      // Verwende Spaltenbreiten/Positionen der letzten Tabelle ('table')
      const summaryLabelWidth = table.colPositions.expected + table.colWidths.expected - left - V_SPACE.SMALL; // Breite bis Ende Soll-Spalte
      const summaryValueX = table.colPositions.actual; // Start der Ist-Spalte
      const summaryValueWidth = table.colWidths.actual + table.colWidths.diff; // Breite Ist + Diff Spalte

      let summaryY = doc.y; // Start Y für Zusammenfassung
      const summaryLineSpacing = 0.5; // Abstand zwischen Zusammenfassungszeilen

      doc.text('Übertrag Vormonat:', left, summaryY, {width: summaryLabelWidth});
      doc.text(decimalHoursToHHMM(data.previousCarryOver), summaryValueX, summaryY, { width: summaryValueWidth, align:'right' });
      summaryY += SUMMARY_LINE_HEIGHT; doc.y = summaryY; // Y aktualisieren

      doc.text('Gesamt Soll (Monat):', left, summaryY, {width: summaryLabelWidth});
      doc.text(decimalHoursToHHMM(data.totalExpected), summaryValueX, summaryY, { width: summaryValueWidth, align:'right' });
      summaryY += SUMMARY_LINE_HEIGHT; doc.y = summaryY;

      doc.text('Gesamt Ist (Monat):', left, summaryY, {width: summaryLabelWidth});
      // WICHTIG: Sicherstellen, dass data.totalActual die Summe der TAGES-Ist-Stunden ist.
      // Falls calculateMonthlyData dies nicht bereits tut, müsste es hier ggf. neu berechnet werden
      // aus aggregatedDays.reduce((sum, d) => sum + d.totalHours, 0);
      // Annahme: data.totalActual ist korrekt.
      doc.text(decimalHoursToHHMM(data.totalActual), summaryValueX, summaryY, { width: summaryValueWidth, align:'right' });
      summaryY += SUMMARY_LINE_HEIGHT; doc.y = summaryY;

      doc.text('Differenz (Saldo Monat):', left, summaryY, {width: summaryLabelWidth});
      // Annahme: data.totalActual und data.totalExpected sind korrekt
      doc.text(decimalHoursToHHMM(data.totalActual - data.totalExpected), summaryValueX, summaryY, { width: summaryValueWidth, align:'right' });
      summaryY += SUMMARY_LINE_HEIGHT; doc.y = summaryY;

      // NEU: Saldo Gesamt (Übertrag + Differenz Monat) hinzufügen für mehr Klarheit
      const currentBalance = (data.previousCarryOver || 0) + (data.totalActual - data.totalExpected);
      doc.font(FONT_BOLD); // Fett für die wichtigste Zeile
      doc.text('Neuer Übertrag (Saldo Gesamt):', left, summaryY, {width: summaryLabelWidth});
      doc.text(decimalHoursToHHMM(currentBalance), summaryValueX, summaryY, { width: summaryValueWidth, align:'right' });
      doc.font(FONT_NORMAL); // Zurück zu normaler Schrift, falls nötig

      // Y-Position für den Footer setzen (nach der Zusammenfassung)
      doc.y = summaryY + V_SPACE.LARGE; // Abstand nach der Zusammenfassung

      // Signatur-Footer zeichnen (unveränderte Funktion)
      drawSignatureFooter(doc, doc.y);

      // PDF finalisieren und senden
      doc.end();

    } catch (err) {
      // Verbesserte Fehlerbehandlung
      console.error('Schwerwiegender PDF-Erstellungsfehler:', err);
      // Sende keinen PDF-Header, wenn ein Fehler aufgetreten ist
      if (!res.headersSent) {
        res.status(500).send('Interner Serverfehler bei der PDF-Erstellung.');
      }
    }
  }); // Ende der GET Route

  return router; // Router exportieren
}; // Ende module.exports
