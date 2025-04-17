// monthlyPdfEndpoint.js - V20: Äußerer Tabellenrahmen entfernt, Zebra-Streifen hinzugefügt
// *** KORREKTUR: Äußerer Tabellenrahmen entfernt ***
// *** FEATURE: Zebra-Streifen (alternierende Hintergrundfarbe) für Tabellenzeilen ***
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Berechnungsfunktionen importieren
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Times-Roman';
const FONT_BOLD   = 'Times-Bold';
const PAGE_OPTIONS = {
  size: 'A4',
  autoFirstPage: false,
  margins: { top: 25, bottom: 35, left: 40, right: 40 }
};
const V_SPACE = { TINY: 0.5, SMALL: 3, MEDIUM: 8, LARGE: 15, XLARGE: 25, SIGNATURE_GAP: 35 };
const FONT_SIZE = {
  HEADER: 16, SUB_HEADER: 11,
  TABLE_HEADER: 8.5, TABLE_CONTENT: 8.5,
  SUMMARY_TITLE: 10, SUMMARY: 9, SUMMARY_DETAIL: 8, FOOTER: 8, PAGE_NUMBER: 8
};
const TABLE_ROW_HEIGHT = 13;
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL;
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL;
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM;
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5;
const SUMMARY_DETAIL_LINE_HEIGHT = FONT_SIZE.SUMMARY_DETAIL + V_SPACE.TINY;
const SUMMARY_TOTAL_HEIGHT = (5 * SUMMARY_LINE_HEIGHT) + SUMMARY_DETAIL_LINE_HEIGHT + V_SPACE.MEDIUM + V_SPACE.SMALL;
// Farbe für Zebra-Streifen (sehr helles Grau)
const ZEBRA_COLOR = '#f5f5f5';


// Hilfsfunktion zur Übersetzung von Abwesenheitstypen
function translateAbsenceType(type) {
    switch (type) {
        case 'VACATION': return 'Urlaub';
        case 'SICK': return 'Krank';
        case 'PUBLIC_HOLIDAY': return 'Feiertag';
        default: return type;
    }
}

// Konvertiert Dezimalstunden in HH:MM Format
function decimalHoursToHHMM(decimalHours) {
  if (isNaN(decimalHours) || decimalHours === null) return '00:00';
  const sign = decimalHours < 0 ? '-' : '';
  const absH = Math.abs(decimalHours);
  const totalMin = Math.round(absH * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// Formatiert Datum zu DD.MM.YYYY (UTC)
function formatDateGerman(dateInput) {
    if (!dateInput) return 'N/A';
    const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
    const d = new Date(str + 'T00:00:00Z');
    return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

// Formatiert Datum zu Wochentag., DD.MM.YYYY (UTC)
function formatDateGermanWithWeekday(dateInput) {
    if (!dateInput) return 'N/A';
    const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
    const d = new Date(str + 'T00:00:00Z');
    return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'UTC'
    }); // Kein replace mehr
}

// Zeichnet den Dokumentenkopf
function drawDocumentHeader(doc, title, name, startDate, endDate) {
    const left = doc.page.margins.left;
    const right = doc.page.margins.right;
    const width = doc.page.width - left - right;
    let y = doc.page.margins.top;

    try {
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        doc.image(logoPath, doc.page.width - right - 70, y, { width: 70, height: 70 });
    } catch (e) {
        console.warn("Logo konnte nicht geladen/gezeichnet werden:", e.message);
    }

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).fillColor('black');
    doc.text(title, left, y + V_SPACE.SMALL, { align: 'center', width });
    y += V_SPACE.SMALL + doc.heightOfString(title, { width, align: 'center' }) + V_SPACE.LARGE;

    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${name || 'Unbekannt'}`, left, y);
    y += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(startDate)} - ${formatDateGerman(endDate)}`, left, y);

    return y + FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
}

// Zeichnet den Tabellenkopf
function drawTableHeader(doc, startY, usableWidth) {
    const left = doc.page.margins.left;
    const cols = { date: 95, start: 60, end: 75, expected: 70, actual: 70 };
    cols.diff = Math.max(40, usableWidth - Object.values(cols).reduce((a, b) => a + b, 0));
    const pos = { date: left };
    pos.start    = pos.date + cols.date;
    pos.end      = pos.start + cols.start;
    pos.expected = pos.end + cols.end;
    pos.actual   = pos.expected + cols.expected;
    pos.diff     = pos.actual + cols.actual;
    const headerHeight = (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.TINY + V_SPACE.SMALL;

    doc.save().fillColor('#eeeeee').rect(left, startY, usableWidth, headerHeight).fill().restore();
    doc.save().lineWidth(0.5).strokeColor('#cccccc');
    doc.moveTo(left, startY).lineTo(left + usableWidth, startY).stroke();
    doc.moveTo(left, startY + headerHeight).lineTo(left + usableWidth, startY + headerHeight).stroke();
    Object.values(pos).forEach(x => doc.moveTo(x, startY).lineTo(x, startY + headerHeight).stroke());
    doc.restore();

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER).fillColor('black');
    const yText = startY + V_SPACE.TINY;
    doc.text('Datum',             pos.date,     yText, { width: cols.date });
    doc.text('Arbeits-\nbeginn',    pos.start,    yText, { width: cols.start, align: 'center' });
    doc.text('Arbeits-\nende',     pos.end,      yText, { width: cols.end, align: 'center' });
    doc.text('Soll-Zeit\n(HH:MM)', pos.expected, yText, { width: cols.expected, align: 'center' });
    doc.text('Ist-Zeit\n(HH:MM)',  pos.actual,   yText, { width: cols.actual, align: 'center' });
    doc.text('Mehr/Minder\nStd.(HH:MM)', pos.diff, yText, { width: cols.diff, align: 'center' });

    return {
        headerBottomY: startY + headerHeight + V_SPACE.SMALL,
        colWidths: cols,
        colPositions: pos,
        headerHeight: headerHeight
    };
}

// Zeichnet die Seitennummer unten zentriert
function drawPageNumber(doc, pageNum) {
    const left = doc.page.margins.left;
    const bottomY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
        .text(`Seite ${pageNum}`, left, bottomY, { width, align: 'center' });
}

// Zeichnet den Fußzeilenbereich
function drawSignatureFooter(doc, startY) {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).fillColor('black');
    const text = 'Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.';

    const requiredHeight = doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.MEDIUM;
    if (startY + requiredHeight > doc.page.height - doc.page.margins.bottom) {
        console.log("[PDF] Seitenumbruch vor Footer");
        doc.addPage();
        startY = doc.page.margins.top;
    }

    doc.text(text, left, startY, { width });
    let y = startY + doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP;
    doc.moveTo(left, y).lineTo(left + 200, y).stroke();
    doc.text('Datum, Unterschrift', left, y + V_SPACE.SMALL);
}

// Middleware zur Prüfung von Admin-Rechten
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
    }
}


// ======================================================
// ROUTER DEFINITION
// ======================================================
module.exports = function(db) {

    // --- Route für Monats-PDF ---
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            // ... (Parameter validieren, Daten holen wie gehabt) ...
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(+year) || isNaN(+month) || month < 1 || month > 12) {
                 return res.status(400).send('Parameter fehlen oder ungültig (name, year, month erforderlich).');
             }
            const y = +year; const m = +month;
            console.log(`[PDF Monthly] Anforderung für ${name}, ${String(m).padStart(2, '0')}/${y}`);
            const data = await calculateMonthlyData(db, name, y, m);
            if (!data) throw new Error('Daten für PDF konnten nicht abgerufen werden.');

            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2, '0')}_${y}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0;
            page++;
            doc.addPage();
            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;

            let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`, data.employeeName, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0)));
            // drawPageNumber(doc, page);

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDays = [];
            data.workEntries.forEach(e => allDays.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
            data.absenceEntries.forEach(a => {
                if (!allDays.find(d => d.date === a.date)) {
                    allDays.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                }
            });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Tägliche Tabelle zeichnen
            allDays.forEach((d, i) => {
                const neededHeightForRest = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - neededHeightForRest)) {
                    page++; doc.addPage();
                    // drawPageNumber(doc, page);
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }

                const currentLineY = doc.y; // Y-Position für die aktuelle Zeile

                // *** NEU: Zebra-Streifen ***
                if (i % 2 === 0) { // Jede gerade Zeile (Index 0, 2, 4...)
                    doc.save()
                       .fillColor(ZEBRA_COLOR)
                       // Rechteck von linkem Rand bis rechtem Rand, Höhe = Zeilenhöhe
                       .rect(left, currentLineY - V_SPACE.TINY, uW, TABLE_ROW_HEIGHT) // Kleiner Y-Offset für bessere Optik
                       .fill()
                       .restore();
                }
                // *** Ende Zebra-Streifen ***

                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--'; let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center'; let actualAlign = 'center'; let diffAlign = 'center';
                if (d.type === 'WORK') {
                    sStart = d.start || '--:--'; sEnd = d.end || '--:--'; endAlign = 'center';
                } else { sEnd = translateAbsenceType(d.type); }
                const sExp = decimalHoursToHHMM(expH);
                const sAct = decimalHoursToHHMM(actH);
                const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;

                // Zellen-Text über den Hintergrund zeichnen
                doc.fillColor('black'); // Sicherstellen, dass Textfarbe schwarz ist
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });

                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Dünne horizontale Linie zwischen den Zeilen
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                    .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });

            // *** KORREKTUR: Äußerer Rahmen entfernt ***
            // const tableTopY = table.headerBottomY - table.headerHeight - V_SPACE.SMALL;
            // const tableBottomY = doc.y - V_SPACE.SMALL;
            // doc.save().lineWidth(0.5).strokeColor('#999999')
            //    .rect(left, tableTopY, uW, tableBottomY - tableTopY).stroke().restore();
            // *** Ende Rahmen entfernt ***

            // --- Zusammenfassung & Footer für Monatsbericht ---
            if (doc.y + SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT > doc.page.height - doc.page.margins.bottom) {
               page++; doc.addPage(); doc.y = doc.page.margins.top;
            } else { doc.y += V_SPACE.LARGE; }

            // (Code für Zusammenfassung bleibt unverändert)
            const summaryYStart = doc.y;
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - V_SPACE.SMALL;
            const valX = table.colPositions.actual;
            const valW = table.colWidths.actual + table.colWidths.diff;
            doc.text('Übertrag Vormonat (+/-):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.previousCarryOver), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Gesamt Soll-Zeit (Monat):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalExpected), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Gesamt Ist-Zeit (Monat):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalActual), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.1);
            const gearbStdM = decimalHoursToHHMM(data.workedHours);
            const abwesStdM = decimalHoursToHHMM(data.absenceHours);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY_DETAIL).fillColor('black');
            doc.text(`(davon gearb.: ${gearbStdM}, Abwesenh.: ${abwesStdM})`, left + V_SPACE.MEDIUM, doc.y, { width: lblW });
            doc.moveDown(0.5);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            doc.text('Gesamt Mehr/Minderstunden:', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalDifference), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Neuer Übertrag (Saldo Ende):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.newCarryOver), valX, doc.y, { width: valW, align: 'right' });

            drawSignatureFooter(doc, doc.y + V_SPACE.LARGE);
            doc.end();
            console.log(`[PDF Monthly] Generierung für ${name} abgeschlossen und gesendet.`);

        } catch (err) { /* Fehlerbehandlung */ }
    });


    // --- Route für Perioden-PDF (Quartal/Jahr) MIT TABELLE ---
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        try {
             // ... (Parameter validieren, Daten holen wie gehabt) ...
            const { name, year, periodType, periodValue } = req.query;
             if (!name || !year || isNaN(+year) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 return res.status(400).send('Parameter fehlen oder ungültig (name, year, periodType [QUARTER/YEAR] erforderlich).');
             }
            const y = +year;
            const pType = periodType.toUpperCase();
            let pValue = periodValue ? parseInt(periodValue) : null;
             if (pType === 'QUARTER' && (isNaN(pValue) || pValue < 1 || pValue > 4)) {
                 return res.status(400).send('Ungültiger periodValue (1-4) für QUARTER erforderlich.');
             }
            console.log(`[PDF Period] Anforderung für ${name}, ${year}, ${pType}${pValue ? ' '+pValue : ''}`);
            const data = await calculatePeriodData(db, name, y, pType, pValue);
            if (!data) throw new Error('Daten für Perioden-PDF konnten nicht abgerufen werden.');

            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            let periodDesc = ''; let titleDesc = '';
            if (pType === 'QUARTER') { periodDesc = `Q${pValue}_${y}`; titleDesc = `Quartalsübersicht ${data.periodIdentifier}/${y}`; }
            else { periodDesc = `Jahr_${y}`; titleDesc = `Jahresübersicht ${y}`; }
            const filename = `Bericht_${periodDesc}_${safeName}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0;
            page++;
            doc.addPage();
            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;

            let yPos = drawDocumentHeader(doc, titleDesc, data.employeeName, new Date(data.periodStartDate + 'T00:00:00Z'), new Date(data.periodEndDate + 'T00:00:00Z'));
            // drawPageNumber(doc, page);

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(e => allDaysPeriod.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
            data.absenceEntriesPeriod.forEach(a => {
                if (!allDaysPeriod.find(d => d.date === a.date)) {
                    allDaysPeriod.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                }
            });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Tägliche Tabelle zeichnen
            allDaysPeriod.forEach((d, i) => {
                const neededHeightForRest = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - neededHeightForRest)) {
                    page++; doc.addPage();
                    // drawPageNumber(doc, page);
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }

                const currentLineY = doc.y; // Y-Position für die aktuelle Zeile

                // *** NEU: Zebra-Streifen ***
                if (i % 2 === 0) { // Jede gerade Zeile
                    doc.save()
                       .fillColor(ZEBRA_COLOR)
                       .rect(left, currentLineY - V_SPACE.TINY, uW, TABLE_ROW_HEIGHT)
                       .fill()
                       .restore();
                }
                // *** Ende Zebra-Streifen ***

                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--'; let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center'; let actualAlign = 'center'; let diffAlign = 'center';
                if (d.type === 'WORK') {
                    sStart = d.start || '--:--'; sEnd = d.end || '--:--'; endAlign = 'center';
                } else { sEnd = translateAbsenceType(d.type); }
                const sExp = decimalHoursToHHMM(expH);
                const sAct = decimalHoursToHHMM(actH);
                const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;

                // Zellen-Text über den Hintergrund zeichnen
                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });

                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Dünne horizontale Linie zwischen den Zeilen
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                   .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });

             // *** KORREKTUR: Äußerer Rahmen entfernt ***
            // const tableTopYPeriod = table.headerBottomY - table.headerHeight - V_SPACE.SMALL;
            // const tableBottomYPeriod = doc.y - V_SPACE.SMALL;
            // doc.save().lineWidth(0.5).strokeColor('#999999')
            //    .rect(left, tableTopYPeriod, uW, tableBottomYPeriod - tableTopYPeriod).stroke().restore();
            // *** Ende Rahmen entfernt ***


            // --- Zusammenfassung & Footer für Periodenbericht ---
            if (doc.y + SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT > doc.page.height - doc.page.margins.bottom) {
               page++; doc.addPage(); doc.y = doc.page.margins.top;
            } else { doc.y += V_SPACE.LARGE; }

            // (Code für Zusammenfassung bleibt unverändert)
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY_TITLE).fillColor('black');
            doc.text(`Zusammenfassung für ${data.periodIdentifier} ${y}`, left, doc.y, { align: 'left' });
            doc.moveDown(1.5);
            const periodLblW = 250; const periodValX = left + periodLblW + V_SPACE.MEDIUM; const periodValW = uW - periodLblW - V_SPACE.MEDIUM;
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            doc.text('Übertrag Periodenbeginn:', left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.startingBalance), periodValX, doc.y, { width: periodValW, align: 'right' });
            doc.moveDown(0.7);
            doc.text(`Gesamt Soll-Stunden (${data.periodIdentifier}):`, left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.totalExpectedPeriod), periodValX, doc.y, { width: periodValW, align: 'right' });
            doc.moveDown(0.7);
            doc.text(`Gesamt Ist-Stunden (${data.periodIdentifier}):`, left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.totalActualPeriod), periodValX, doc.y, { width: periodValW, align: 'right' });
            doc.moveDown(0.1);
            const gearbStdP = decimalHoursToHHMM(data.workedHoursPeriod); const abwesStdP = decimalHoursToHHMM(data.absenceHoursPeriod);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY_DETAIL).fillColor('black');
            doc.text(`(davon gearb.: ${gearbStdP}, Abwesenh.: ${abwesStdP})`, left + V_SPACE.MEDIUM, doc.y, { width: periodLblW });
            doc.moveDown(0.7);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            doc.text(`Differenz (${data.periodIdentifier}):`, left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.periodDifference), periodValX, doc.y, { width: periodValW, align: 'right' });
            doc.moveDown(0.7);
            doc.text('Neuer Übertrag (Saldo Periodenende):', left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.endingBalancePeriod), periodValX, doc.y, { width: periodValW, align: 'right' });

            drawSignatureFooter(doc, doc.y + V_SPACE.XLARGE);
            doc.end();
            console.log(`[PDF Period] Generierung für ${name} abgeschlossen und gesendet.`);

        } catch (err) { /* Fehlerbehandlung */ }
    });

    return router;
};
