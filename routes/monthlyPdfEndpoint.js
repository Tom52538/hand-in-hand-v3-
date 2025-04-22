// monthlyPdfEndpoint.js - V24: Layout-Optimierung + Seitennummerierung via Event
const express = require('express');
const PDFDocument = require('pdfkit');
// ... (andere Imports wie in V22) ...

// --- Konstanten & Hilfsfunktionen ---
// ... (alle Konstanten und Helfer wie in V22) ...

// Funktion zum Zeichnen der Seitenzahl ANPASSEN (wird vom Event aufgerufen)
function drawPageNumberOnPage(doc, pageNum) {
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const pageLeft = doc.page.margins.left;
    const pageWidth = doc.page.width - pageLeft - doc.page.margins.right;
    const yPos = pageBottom + V_SPACE.MEDIUM; // Position unterhalb des Inhaltsbereichs

    // Wichtig: Font und Farbe explizit setzen, da der Kontext beim Event anders sein kann
    doc.save();
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black');
    doc.text(`Seite ${pageNum}`, pageLeft, yPos, {
        width: pageWidth,
        align: 'center'
    });
    doc.restore();
}
// ... (Restliche Helfer wie drawDocumentHeader, drawTableHeader etc. aus V22) ...

// ======================================================
// ROUTER DEFINITION
// ======================================================
module.exports = function(db) {

    // --- Route für Monats-PDF ---
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            // ... (Parameter validieren, Daten holen wie in V22) ...
            const { name, year, month } = req.query;
            // ... Validierung ...
            const y = +year; const m = +month;
            const data = await calculateMonthlyData(db, name, y, m);
            // ... Fehlerbehandlung ...

            const doc = new PDFDocument(PAGE_OPTIONS);
            // ... (Header, Pipe, Dateiname wie in V22) ...
             res.setHeader('Content-Type', 'application/pdf');
             res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
             doc.pipe(res);

            let currentPage = 0; // Zähler für Event
            doc.on('pageAdded', () => {
                currentPage++;
                drawPageNumberOnPage(doc, currentPage); // Zahl auf JEDER NEUEN Seite zeichnen
            });

            // Erste Seite manuell hinzufügen und Zähler setzen
            currentPage = 1;
            doc.addPage();
            drawPageNumberOnPage(doc, currentPage); // Zahl auf der ERSTEN Seite zeichnen

            // *** HIER KEINE drawPageNumber Aufrufe mehr einfügen ***

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const pageBottomLimit = doc.page.height - doc.page.margins.bottom;
            let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`, data.employeeName, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0)));

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDays = [];
            // ... (allDays befüllen und sortieren wie in V22) ...
             data.workEntries.forEach(e => allDays.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
             data.absenceEntries.forEach(a => {
                 if (!allDays.find(d => d.date === a.date)) {
                     allDays.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                 }
             });
             allDays.sort((a, b) => new Date(a.date) - new Date(b.date));


            allDays.forEach((d, i) => {
                // Seitenumbruch-Logik (OPTIMIERT, wie in V22)
                 if (i > 0 && (doc.y + TABLE_ROW_HEIGHT + V_SPACE.SMALL > pageBottomLimit)) {
                    // 'pageAdded' Event wird automatisch ausgelöst -> Seitenzahl gezeichnet
                    doc.addPage();
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }
                // ... (Code zum Zeichnen der Tabellenzeile wie in V22) ...
                 const currentLineY = doc.y;
                 // ... (Daten für Zeile vorbereiten) ...
                 const expH = getExpectedHours(data.employeeData, d.date);
                 const actH = d.actual;
                 const diffH = actH - expH;
                 const sDate = formatDateGermanWithWeekday(d.date);
                 let sStart = '--:--'; let sEnd = '--:--';
                 let endAlign = 'left'; let startAlign = 'center';
                 let expectedAlign = 'center';
                 let actualAlign = 'center'; let diffAlign = 'center';

                 if (d.type === 'WORK') {
                     sStart = d.start || '--:--';
                     sEnd = d.end || '--:--';
                     endAlign = 'center';
                 } else {
                     sEnd = translateAbsenceType(d.type);
                 }
                 const sExp = decimalHoursToHHMM(expH);
                 const sAct = decimalHoursToHHMM(actH);
                 const sDiff = decimalHoursToHHMM(diffH);
                 const p = table.colPositions; const w = table.colWidths;

                 doc.fillColor('black');
                 doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                 doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                 doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                 doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                 doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                 doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });

                 doc.y = currentLineY + TABLE_ROW_HEIGHT;
                 doc.save().lineWidth(0.25).strokeColor('#dddddd')
                     .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();

            });

            // Check vor Summary/Footer (OPTIMIERT, wie in V22)
             const summaryAndFooterHeight = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE + V_SPACE.XLARGE;
             if (doc.y + summaryAndFooterHeight > pageBottomLimit) {
                 console.log("[PDF Monthly] Seitenumbruch vor Zusammenfassung/Footer benötigt.");
                 // 'pageAdded' Event wird automatisch ausgelöst -> Seitenzahl gezeichnet
                 doc.addPage();
                 doc.y = doc.page.margins.top;
             } else {
                  doc.y += V_SPACE.LARGE;
             }

            // ... (Code zum Zeichnen von Summary und Footer wie in V22) ...
            // Zusammenfassung zeichnen
             const summaryYStart = doc.y;
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
             const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - V_SPACE.SMALL;
             const valX = table.colPositions.actual;
             const valW = table.colWidths.actual + table.colWidths.diff;
             // ... (Summary Text zeichnen) ...
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


             // Footer zeichnen
             drawSignatureFooter(doc, doc.y + V_SPACE.LARGE);

            doc.end();
            console.log(`[PDF Monthly] Generierung für ${name} abgeschlossen und gesendet.`);

        } catch (err) {
            // ... (Fehlerbehandlung wie in V22) ...
             console.error('[PDF Monthly] Kritischer Fehler:', err);
             if (!res.headersSent) {
                 res.status(500).send(`Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`);
             }
        }
    });


    // --- Route für Perioden-PDF (Quartal/Jahr) MIT TABELLE ---
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        try {
            // ... (Parameter validieren, Daten holen wie in V22) ...
             const { name, year, periodType, periodValue } = req.query;
             // ... Validierung ...
              if (!name || !year || isNaN(+year) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 return res.status(400).send('Parameter fehlen oder ungültig.');
             }
             const y = +year;
             const pType = periodType.toUpperCase();
             let pValue = periodValue ? parseInt(periodValue) : null;
             if (pType === 'QUARTER' && (isNaN(pValue) || pValue < 1 || pValue > 4)) {
                  return res.status(400).send('Ungültiger periodValue (1-4) für QUARTER erforderlich.');
             }
             const data = await calculatePeriodData(db, name, y, pType, pValue);
             // ... Fehlerbehandlung ...
             if (!data) throw new Error('Daten für Perioden-PDF konnten nicht abgerufen werden.');


            const doc = new PDFDocument(PAGE_OPTIONS);
            // ... (Header, Pipe, Dateiname wie in V22) ...
             const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
             let periodDesc = ''; let titleDesc = '';
             if (pType === 'QUARTER') {
                  periodDesc = `Q${pValue}_${y}`;
                  titleDesc = `Quartalsübersicht ${data.periodIdentifier}/${y}`;
             } else {
                  periodDesc = `Jahr_${y}`;
                  titleDesc = `Jahresübersicht ${y}`;
             }
             const filename = `Bericht_${periodDesc}_${safeName}.pdf`;
             res.setHeader('Content-Type', 'application/pdf');
             res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
             doc.pipe(res);


            let currentPage = 0; // Zähler für Event
            doc.on('pageAdded', () => {
                currentPage++;
                drawPageNumberOnPage(doc, currentPage); // Zahl auf JEDER NEUEN Seite zeichnen
            });

            // Erste Seite manuell hinzufügen und Zähler setzen
            currentPage = 1;
            doc.addPage();
            drawPageNumberOnPage(doc, currentPage); // Zahl auf der ERSTEN Seite zeichnen

            // *** HIER KEINE drawPageNumber Aufrufe mehr einfügen ***

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const pageBottomLimit = doc.page.height - doc.page.margins.bottom;
            let yPos = drawDocumentHeader(doc, titleDesc, data.employeeName, new Date(data.periodStartDate + 'T00:00:00Z'), new Date(data.periodEndDate + 'T00:00:00Z'));

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDaysPeriod = [];
            // ... (allDaysPeriod befüllen und sortieren wie in V22) ...
             data.workEntriesPeriod.forEach(e => allDaysPeriod.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
             data.absenceEntriesPeriod.forEach(a => {
                 if (!allDaysPeriod.find(d => d.date === a.date)) {
                      allDaysPeriod.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                 }
             });
             allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));


            allDaysPeriod.forEach((d, i) => {
                // Seitenumbruch-Logik (OPTIMIERT, wie in V22)
                  if (i > 0 && (doc.y + TABLE_ROW_HEIGHT + V_SPACE.SMALL > pageBottomLimit)) {
                     // 'pageAdded' Event wird automatisch ausgelöst -> Seitenzahl gezeichnet
                     doc.addPage();
                     const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                     doc.y = nextTable.headerBottomY;
                     doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                 }
                // ... (Code zum Zeichnen der Tabellenzeile wie in V22) ...
                  const currentLineY = doc.y;
                 // ... (Daten für Zeile vorbereiten) ...
                  const expH = getExpectedHours(data.employeeData, d.date);
                 const actH = d.actual;
                 const diffH = actH - expH;
                 const sDate = formatDateGermanWithWeekday(d.date);
                 let sStart = '--:--'; let sEnd = '--:--';
                 let endAlign = 'left'; let startAlign = 'center';
                 let expectedAlign = 'center';
                 let actualAlign = 'center'; let diffAlign = 'center';

                 if (d.type === 'WORK') {
                      sStart = d.start || '--:--';
                      sEnd = d.end || '--:--';
                      endAlign = 'center';
                 } else {
                      sEnd = translateAbsenceType(d.type);
                 }
                 const sExp = decimalHoursToHHMM(expH);
                 const sAct = decimalHoursToHHMM(actH);
                 const sDiff = decimalHoursToHHMM(diffH);
                 const p = table.colPositions; const w = table.colWidths;

                 doc.fillColor('black');
                 doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                 doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                 doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                 doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                 doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                 doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });

                  doc.y = currentLineY + TABLE_ROW_HEIGHT;
                  doc.save().lineWidth(0.25).strokeColor('#dddddd')
                     .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();

            });

            // Check vor Summary/Footer (OPTIMIERT, wie in V22)
             const summaryAndFooterHeight = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE + V_SPACE.XLARGE;
             if (doc.y + summaryAndFooterHeight > pageBottomLimit) {
                  console.log("[PDF Period] Seitenumbruch vor Zusammenfassung/Footer benötigt.");
                  // 'pageAdded' Event wird automatisch ausgelöst -> Seitenzahl gezeichnet
                  doc.addPage();
                  doc.y = doc.page.margins.top;
             } else {
                  doc.y += V_SPACE.LARGE;
             }

            // ... (Code zum Zeichnen von Summary und Footer wie in V22) ...
             // Zusammenfassung zeichnen
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY_TITLE).fillColor('black');
             doc.text(`Zusammenfassung für ${data.periodIdentifier} ${y}`, left, doc.y, { align: 'left' });
             doc.moveDown(1.5);
             const periodLblW = 250;
             const periodValX = left + periodLblW + V_SPACE.MEDIUM;
             const periodValW = uW - periodLblW - V_SPACE.MEDIUM;
             // ... (Summary Text zeichnen) ...
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
             const gearbStdP = decimalHoursToHHMM(data.workedHoursPeriod);
             const abwesStdP = decimalHoursToHHMM(data.absenceHoursPeriod);
             doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY_DETAIL).fillColor('black');
             doc.text(`(davon gearb.: ${gearbStdP}, Abwesenh.: ${abwesStdP})`, left + V_SPACE.MEDIUM, doc.y, { width: periodLblW });
             doc.moveDown(0.7);
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
             doc.text(`Differenz (${data.periodIdentifier}):`, left, doc.y, { width: periodLblW });
             doc.text(decimalHoursToHHMM(data.periodDifference), periodValX, doc.y, { width: periodValW, align: 'right' });
             doc.moveDown(0.7);
             doc.text('Neuer Übertrag (Saldo Periodenende):', left, doc.y, { width: periodLblW });
             doc.text(decimalHoursToHHMM(data.endingBalancePeriod), periodValX, doc.y, { width: periodValW, align: 'right' });


             // Footer zeichnen
             drawSignatureFooter(doc, doc.y + V_SPACE.XLARGE);


            doc.end();
            console.log(`[PDF Period] Generierung für ${name} (${periodDesc}) abgeschlossen und gesendet.`);

        } catch (err) {
            // ... (Fehlerbehandlung wie in V22) ...
             console.error('[PDF Period] Kritischer Fehler:', err);
             if (!res.headersSent) {
                 res.status(500).send(`Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`);
             }
        }
    });

    return router;
};
