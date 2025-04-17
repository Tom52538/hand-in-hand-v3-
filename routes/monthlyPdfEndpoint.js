// monthlyPdfEndpoint.js - V22: Bessere Seitennutzung + Paginierung "Seite X von Y"
// *** KORREKTUR: Seitenumbruch-Logik in Tabelle angepasst für bessere Seitenfüllung ***
// *** FEATURE: Seitennummerierung "Seite X von Y" unten mittig hinzugefügt ***
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
  margins: { top: 25, bottom: 35, left: 40, right: 40 },
  bufferPages: true // WICHTIG: Erlaubt nachträgliches Hinzufügen von Seitenzahlen
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

// Hilfsfunktion zur Übersetzung von Abwesenheitstypen
function translateAbsenceType(type) { /* ... unverändert ... */ }
function decimalHoursToHHMM(decimalHours) { /* ... unverändert ... */ }
function formatDateGerman(dateInput) { /* ... unverändert ... */ }
function formatDateGermanWithWeekday(dateInput) { /* ... unverändert ... */ }
function drawDocumentHeader(doc, title, name, startDate, endDate) { /* ... unverändert ... */ }
function drawTableHeader(doc, startY, usableWidth) { /* ... unverändert ... */ }

// Zeichnet die Seitennummer unten zentriert - Wird jetzt am ENDE aufgerufen
// Funktion kann prinzipiell bleiben, wird aber nicht mehr während der Erstellung genutzt
/*
function drawPageNumber(doc, pageNum) {
    const left = doc.page.margins.left;
    const bottomY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
        .text(`Seite ${pageNum}`, left, bottomY, { width, align: 'center' });
}
*/

// Zeichnet den Fußzeilenbereich
function drawSignatureFooter(doc, startY) {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).fillColor('black');
    const text = 'Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.';

    const requiredHeight = doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL + V_SPACE.MEDIUM;
    // ACHTUNG: Diese Prüfung verschieben wir NACH die Tabelle und VOR die Zusammenfassung
    // if (startY + requiredHeight > doc.page.height - doc.page.margins.bottom) { ... }

    doc.text(text, left, startY, { width });
    let y = startY + doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP;
    doc.moveTo(left, y).lineTo(left + 200, y).stroke();
    doc.text('Datum, Unterschrift', left, y + V_SPACE.SMALL);

    // Gibt die Höhe zurück, die der Footer tatsächlich eingenommen hat
    return (y + FONT_SIZE.FOOTER + V_SPACE.SMALL) - startY;
}

// Middleware zur Prüfung von Admin-Rechten
function isAdmin(req, res, next) { /* ... unverändert ... */ }


// ======================================================
// ROUTER DEFINITION
// ======================================================
module.exports = function(db) {

    // --- Route für Monats-PDF ---
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, month } = req.query;
            // ... Validierung ...
            const y = +year; const m = +month;
            const data = await calculateMonthlyData(db, name, y, m);
            if (!data) throw new Error('Daten nicht abrufbar.');

            // WICHTIG: bufferPages aktivieren!
            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);
            // ... Dateiname etc. ...
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2, '0')}_${y}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0; page++; doc.addPage(); // Start auf Seite 1
            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;

            let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`, data.employeeName, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0)));
            // KEIN drawPageNumber hier

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDays = []; // Daten vorbereiten
            data.workEntries.forEach(e => allDays.push({ /*...*/ }));
            data.absenceEntries.forEach(a => { if (!allDays.find(d => d.date === a.date)) { allDays.push({ /*...*/ }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Tägliche Tabelle zeichnen
            allDays.forEach((d, i) => {
                // *** KORREKTUR: Seitenumbruch prüft nur, ob die NÄCHSTE ZEILE passt ***
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom)) {
                    // Nicht mehr auf Summary/Footer prüfen, nur ob die Zeile überläuft
                    console.log(`[PDF Monthly] Seitenumbruch vor Zeile ${i + 1} (Datum: ${d.date}) bei Y=${doc.y}`);
                    page++; doc.addPage();
                    // KEIN drawPageNumber hier
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }
                const currentLineY = doc.y;

                // Zebra-Streifen bleiben entfernt

                // Zellen-Text zeichnen (unverändert)
                // ... (Code zum Zeichnen der Zellen mit doc.text) ...
                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--'; let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center'; let actualAlign = 'center'; let diffAlign = 'center';
                if (d.type === 'WORK') { sStart = d.start || '--:--'; sEnd = d.end || '--:--'; endAlign = 'center'; }
                else { sEnd = translateAbsenceType(d.type); }
                const sExp = decimalHoursToHHMM(expH); const sAct = decimalHoursToHHMM(actH); const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;
                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });

                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Horizontale Linie
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                    .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });

            // Äußerer Rahmen bleibt entfernt

            // --- Zusammenfassung & Footer ---
            const neededHeightAfterTable = SUMMARY_TOTAL_HEIGHT + V_SPACE.LARGE + FOOTER_TOTAL_HEIGHT;
            if (doc.y + neededHeightAfterTable > doc.page.height - doc.page.margins.bottom) {
               console.log(`[PDF Monthly] Seitenumbruch vor Zusammenfassung bei Y=${doc.y}`);
               page++; doc.addPage();
               // KEIN drawPageNumber hier
               doc.y = doc.page.margins.top; // Oben auf neuer Seite beginnen
               // Optional: Header wiederholen? Eher nicht für Zusammenfassung.
            } else {
               doc.y += V_SPACE.LARGE; // Abstand nach Tabelle
            }

            // Zusammenfassung zeichnen (Code unverändert)
            // ... (Code für draw Summary) ...
            const summaryYStart = doc.y;
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - V_SPACE.SMALL;
            const valX = table.colPositions.actual; const valW = table.colWidths.actual + table.colWidths.diff;
            doc.text('Übertrag Vormonat (+/-):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.previousCarryOver), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Gesamt Soll-Zeit (Monat):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalExpected), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Gesamt Ist-Zeit (Monat):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalActual), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.1);
            const gearbStdM = decimalHoursToHHMM(data.workedHours); const abwesStdM = decimalHoursToHHMM(data.absenceHours);
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
            const footerStartY = doc.y + V_SPACE.LARGE;
            drawSignatureFooter(doc, footerStartY);

            // *** NEU: Seitenzahlen hinzufügen (am Ende) ***
            const totalPages = page; // Aktueller Seitenzähler sollte die Gesamtanzahl sein
            if (totalPages > 1) { // Nur hinzufügen, wenn mehr als eine Seite
                for (let i = 1; i <= totalPages; i++) {
                    doc.switchToPage(i - 1); // Zu Seite i wechseln (0-basiert)
                    const pageNumText = `Seite ${i} von ${totalPages}`;
                    const pageNumX = doc.page.margins.left;
                    // Y-Position für Seitenzahl (wie in alter drawPageNumber Funktion)
                    const pageNumY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
                    const pageNumWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
                       .text(pageNumText, pageNumX, pageNumY, { width: pageNumWidth, align: 'center' });
                }
            }
            // *** Ende Seitenzahlen ***

            doc.end(); // PDF abschließen
            console.log(`[PDF Monthly] Generierung für ${name} abgeschlossen und gesendet.`);

        } catch (err) { /* Fehlerbehandlung */ console.error('[PDF Monthly] Kritischer Fehler:', err); if (!res.headersSent) { res.status(500).send(`Fehler. (${err.message || ''})`); } }
    });


    // --- Route für Perioden-PDF (Quartal/Jahr) MIT TABELLE ---
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        try {
             // ... (Parameter validieren, Daten holen wie gehabt) ...
            const { name, year, periodType, periodValue } = req.query;
             if (!name || !year || isNaN(+year) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) { return res.status(400).send('Parameter fehlen oder ungültig.'); }
            const y = +year; const pType = periodType.toUpperCase(); let pValue = periodValue ? parseInt(periodValue) : null;
             if (pType === 'QUARTER' && (isNaN(pValue) || pValue < 1 || pValue > 4)) { return res.status(400).send('Ungültiger periodValue für QUARTER.'); }
            const data = await calculatePeriodData(db, name, y, pType, pValue);
            if (!data) throw new Error('Daten nicht abrufbar.');

            // WICHTIG: bufferPages aktivieren!
            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);
            // ... Dateiname etc. ...
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            let periodDesc = ''; let titleDesc = '';
            if (pType === 'QUARTER') { periodDesc = `Q${pValue}_${y}`; titleDesc = `Quartalsübersicht ${data.periodIdentifier}/${y}`; }
            else { periodDesc = `Jahr_${y}`; titleDesc = `Jahresübersicht ${y}`; }
            const filename = `Bericht_${periodDesc}_${safeName}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0; page++; doc.addPage(); // Start auf Seite 1
            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;

            let yPos = drawDocumentHeader(doc, titleDesc, data.employeeName, new Date(data.periodStartDate + 'T00:00:00Z'), new Date(data.periodEndDate + 'T00:00:00Z'));
            // KEIN drawPageNumber hier

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDaysPeriod = []; // Daten vorbereiten
            data.workEntriesPeriod.forEach(e => allDaysPeriod.push({ /*...*/ }));
            data.absenceEntriesPeriod.forEach(a => { if (!allDaysPeriod.find(d => d.date === a.date)) { allDaysPeriod.push({ /*...*/ }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Tägliche Tabelle zeichnen
            allDaysPeriod.forEach((d, i) => {
                // *** KORREKTUR: Seitenumbruch prüft nur, ob die NÄCHSTE ZEILE passt ***
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom)) {
                    console.log(`[PDF Period] Seitenumbruch vor Zeile ${i + 1} (Datum: ${d.date}) bei Y=${doc.y}`);
                    page++; doc.addPage();
                    // KEIN drawPageNumber hier
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }
                const currentLineY = doc.y;

                // Zebra-Streifen bleiben entfernt

                // Zellen-Text zeichnen (unverändert)
                 // ... (Code zum Zeichnen der Zellen mit doc.text) ...
                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--'; let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center'; let actualAlign = 'center'; let diffAlign = 'center';
                if (d.type === 'WORK') { sStart = d.start || '--:--'; sEnd = d.end || '--:--'; endAlign = 'center'; }
                else { sEnd = translateAbsenceType(d.type); }
                const sExp = decimalHoursToHHMM(expH); const sAct = decimalHoursToHHMM(actH); const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;
                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });

                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Horizontale Linie
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                   .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });

            // Äußerer Rahmen bleibt entfernt

            // --- Zusammenfassung & Footer ---
             const neededHeightAfterTablePeriod = SUMMARY_TOTAL_HEIGHT + V_SPACE.XLARGE + FOOTER_TOTAL_HEIGHT;
             if (doc.y + neededHeightAfterTablePeriod > doc.page.height - doc.page.margins.bottom) {
               console.log(`[PDF Period] Seitenumbruch vor Zusammenfassung bei Y=${doc.y}`);
               page++; doc.addPage();
               // KEIN drawPageNumber hier
               doc.y = doc.page.margins.top;
            } else {
               doc.y += V_SPACE.LARGE; // Abstand nach Tabelle
            }

            // Zusammenfassung zeichnen (Code unverändert)
             // ... (Code für draw Summary für Periode) ...
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

            // Footer zeichnen
            const footerStartYPeriod = doc.y + V_SPACE.XLARGE; // Mehr Abstand für Periodenbericht
            drawSignatureFooter(doc, footerStartYPeriod);

            // *** NEU: Seitenzahlen hinzufügen (am Ende) ***
            const totalPagesPeriod = page;
            if (totalPagesPeriod > 1) { // Nur hinzufügen, wenn mehr als eine Seite
                 for (let i = 1; i <= totalPagesPeriod; i++) {
                    doc.switchToPage(i - 1);
                    const pageNumText = `Seite ${i} von ${totalPagesPeriod}`;
                    const pageNumX = doc.page.margins.left;
                    const pageNumY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
                    const pageNumWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
                       .text(pageNumText, pageNumX, pageNumY, { width: pageNumWidth, align: 'center' });
                 }
            }
            // *** Ende Seitenzahlen ***

            doc.end(); // PDF abschließen
            console.log(`[PDF Period] Generierung für ${name} abgeschlossen und gesendet.`);

        } catch (err) { /* Fehlerbehandlung */ console.error('[PDF Period] Kritischer Fehler:', err); if (!res.headersSent) { res.status(500).send(`Fehler. (${err.message || ''})`); } }
    });

    return router;
};
