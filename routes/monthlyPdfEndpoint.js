// monthlyPdfEndpoint.js - MIT ANGEPASSTER DATUMSFORMATIERUNG

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere BEIDE Berechnungsfunktionen
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('../utils/calculationUtils'); // getExpectedHours hier importieren

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Helvetica'; const FONT_BOLD = 'Helvetica-Bold';
const PAGE_OPTIONS = { size: 'A4', margins: { top: 25, bottom: 25, left: 40, right: 40 } };
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { HEADER: 16, SUB_HEADER: 11, TABLE_HEADER: 9, TABLE_CONTENT: 9, SUMMARY: 8, FOOTER: 8 };
const TABLE_ROW_HEIGHT = 10;

// Formatierungsoptionen
const pdfDateOptions = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };
const pdfDateOptionsWithWeekday = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };

function decimalHoursToHHMM(decimalHours) { /* ... unverändert ... */ if (isNaN(decimalHours) || decimalHours === null) return "00:00"; const sign = decimalHours < 0 ? "-" : ""; const absHours = Math.abs(decimalHours); const totalMinutes = Math.round(absHours * 60); const hours = Math.floor(totalMinutes / 60); const minutes = totalMinutes % 60; return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`; }

// Formatiert Datum als TT.MM.YYYY (OHNE Wochentag) - Unverändert
function formatDateGerman(dateInput) {
    if (!dateInput) return 'N/A';
    try {
        const dateStr = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
        const dateObj = new Date(dateStr + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) return String(dateInput);
        return dateObj.toLocaleDateString('de-DE', pdfDateOptions);
    } catch (e) {
        console.warn("Fehler Datumsformat (ohne Wochentag):", dateInput, e);
        return String(dateInput);
    }
}

// ** NEUE VERSION: Formatiert Datum als "Wochentag. TT.MM.YYYY" **
function formatDateGermanWithWeekday(dateInput) {
    if (!dateInput) return 'N/A';
    try {
        const dateStr = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
        const dateObj = new Date(dateStr + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) return String(dateInput);
        // Nutzt die neuen Optionen und gibt direkt den formatierten String zurück
        return dateObj.toLocaleDateString('de-DE', pdfDateOptionsWithWeekday);
    } catch (e) {
        console.warn("Fehler Datum mit Wochentag:", dateInput, e);
        return String(dateInput);
    }
}
// ENDE monthlyPdfEndpoint.js TEIL 1/4
// START monthlyPdfEndpoint.js TEIL 2/4
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) { /* ... unverändert ... */ const pageLeftMargin = doc.page.margins.left; const pageRightMargin = doc.page.margins.right; const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin; let currentY = doc.page.margins.top; try { const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png'); const logoWidth = 95; const logoHeight = 95; const logoX = doc.page.width - pageRightMargin - logoWidth; doc.image(logoPath, logoX, currentY, { width: logoWidth, height: logoHeight }); currentY = Math.max(currentY + V_SPACE.TINY, currentY + logoHeight); } catch (errLogo) { console.warn("Logo Fehler:", errLogo); } doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER); doc.text(title, pageLeftMargin, doc.page.margins.top + V_SPACE.TINY, { align: 'center', width: usableWidth }); doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER); doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY); currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL; doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY); currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE; return currentY; } // Verwendet weiterhin formatDateGerman für den Zeitraum
function drawTableHeader(doc, startY, usableWidth) { /* ... unverändert ... */ const pageLeftMargin = doc.page.margins.left; const colWidths = { date: 115, start: 75, end: 75, expected: 85, actual: 85, diff: usableWidth - 115 - 75 - 75 - 85 - 85 }; const colPositions = { date: pageLeftMargin, start: pageLeftMargin + colWidths.date, end: pageLeftMargin + colWidths.date + colWidths.start, expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end, actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected, diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual }; doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER); const headerTextY = startY + V_SPACE.SMALL / 2; doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' }); doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' }); doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' }); doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' }); doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' }); doc.text("Mehr/Minder\nStd.(HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' }); const headerBottomY = startY + (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.SMALL; doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke(); return { headerBottomY: headerBottomY + V_SPACE.MEDIUM - 2, colWidths, colPositions }; }
function drawFooter(doc, startY) { /* ... unverändert ... */ const pageLeftMargin = doc.page.margins.left; const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right; doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER); doc.text("Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.", pageLeftMargin, startY, { align: 'left', width: usableWidth }); const signatureY = startY + FONT_SIZE.FOOTER + V_SPACE.SIGNATURE_GAP; const lineStartX = pageLeftMargin; const lineEndX = pageLeftMargin + 200; doc.moveTo(lineStartX, signatureY).lineTo(lineEndX, signatureY).lineWidth(0.5).stroke(); doc.text("Datum, Unterschrift", pageLeftMargin, signatureY + V_SPACE.SMALL); }
function isAdmin(req, res, next) { /* ... unverändert ... */ if (req.session && req.session.isAdmin === true) { next(); } else { console.warn(`PDF Route: isAdmin-Check fehlgeschlagen.`); res.status(403).send('Zugriff verweigert.'); } }

//-----------------------------------------------------
// PDF ROUTEN
//-----------------------------------------------------
module.exports = function (db) {

    // GET /create-monthly-pdf (Bestehende Route)
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        let doc; // Definiere doc außerhalb des try-Blocks für den finally/catch Zugriff
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) { return res.status(400).send("Parameter fehlen."); }
            const parsedYear = parseInt(year, 10); const parsedMonth = parseInt(month, 10);

            const data = await calculateMonthlyData(db, name, year, month); // Holt jetzt auch employeeData
            const employeeDataForPdf = data.employeeData; // <<< Mitarbeiterdaten für getExpectedHours holen

            doc = new PDFDocument(PAGE_OPTIONS);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            let currentY = drawDocumentHeader(doc, `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`, data.employeeName, new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)), new Date(Date.UTC(parsedYear, parsedMonth, 0)));
            const { headerBottomY, colWidths, colPositions } = drawTableHeader(doc, currentY, usableWidth);
            currentY = headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5); doc.y = currentY;
            const footerHeight = FONT_SIZE.FOOTER + V_SPACE.SIGNATURE_GAP + 1 + V_SPACE.SMALL + FONT_SIZE.FOOTER;
            const summaryHeight = 5 * (FONT_SIZE.SUMMARY + V_SPACE.TINY) + V_SPACE.LARGE;

            // Kombinierte Liste aus Arbeit und Abwesenheit
            const allDays = [];
            data.workEntries.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDays.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntries.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDays.some(d => d.date === dateStr)) { allDays.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            if (allDays.length === 0) { doc.text('Keine Buchungen/Abwesenheiten.', doc.page.margins.left, doc.y); doc.y += TABLE_ROW_HEIGHT; }
            else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];
                    // Seitenumbruch prüfen...
                    const spaceNeededForRest = TABLE_ROW_HEIGHT + summaryHeight + footerHeight;
                    if ((doc.y + spaceNeededForRest > doc.page.height - doc.page.margins.bottom && i > 0) || (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - summaryHeight - footerHeight)) {
                        drawFooter(doc, doc.page.height - doc.page.margins.bottom - footerHeight + V_SPACE.MEDIUM);
                        doc.addPage(); currentY = doc.page.margins.top;
                        const tableLayout = drawTableHeader(doc, currentY, usableWidth); currentY = tableLayout.headerBottomY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5); doc.y = currentY;
                    }

                    // ** VERWENDET NEUE FUNKTION **
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = getExpectedHours(employeeDataForPdf, dayData.date); // Holt Soll-Std
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--"; let endOverride = dayData.endTime || "--:--";
                    if (dayData.type !== 'WORK') { startOverride = '--:--'; endOverride = dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag'); }
                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours); const diffStr = decimalHoursToHHMM(diffHours);
                    const currentRowY = doc.y;
                    const textOptions = { align: 'center', lineBreak: false };

                    doc.text(dateFormatted, colPositions.date, currentRowY, { ...textOptions, width: colWidths.date, align: 'left' }); // Formatiertes Datum
                    doc.text(startOverride, colPositions.start, currentRowY, { ...textOptions, width: colWidths.start });
                    doc.text(endOverride, colPositions.end, currentRowY, { ...textOptions, width: colWidths.end });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { ...textOptions, width: colWidths.expected });
                    doc.text(actualStr, colPositions.actual, currentRowY, { ...textOptions, width: colWidths.actual });
                    doc.text(diffStr, colPositions.diff, currentRowY, { ...textOptions, width: colWidths.diff });
                    doc.y += TABLE_ROW_HEIGHT;
                }
            }
// ENDE monthlyPdfEndpoint.js TEIL 2/4
        // START monthlyPdfEndpoint.js TEIL 3/4
            currentY = doc.y + V_SPACE.LARGE;
            // Zusammenfassung (Monat)
             if (currentY + summaryHeight + footerHeight > doc.page.height - doc.page.margins.bottom) { doc.addPage(); currentY = doc.page.margins.top; }
             doc.y = currentY;
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
             const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - V_SPACE.SMALL; const summaryValueWidth = colWidths.actual + colWidths.diff;
             const summaryLabelX = doc.page.margins.left; const summaryValueX = colPositions.actual; const summaryLineSpacing = 0.2;
             doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.text("Gesamt Soll-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.text("Gesamt Ist-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.font(FONT_NORMAL); doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHours)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHours)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth -10}); doc.moveDown(summaryLineSpacing+0.3); doc.font(FONT_BOLD);
             const totalDiff = (data.totalActual || 0) - (data.totalExpected || 0); doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.font(FONT_BOLD); doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
             currentY = doc.y + V_SPACE.LARGE;

            drawFooter(doc, currentY); // Footer zeichnen
            doc.end(); // PDF abschließen

        } catch (err) {
            console.error("Fehler Erstellen Monats-PDF:", err);
            if (!res.headersSent) { res.status(500).send(`Fehler Erstellen Monats-PDF: ${err.message}`); }
            else { console.error("Monats-PDF Header bereits gesendet."); if (doc && !doc.writableEnded) doc.end(); }
        }
    });

    // GET /create-period-pdf (Neue Route)
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        let doc; // Definiere doc außerhalb für Catch-Block Zugriff
         try {
            const { name, year, periodType, periodValue } = req.query;
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) { return res.status(400).send("Parameter fehlen/ungültig."); }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) { return res.status(400).send("Gültiger periodValue (1-4) für Quartal erforderlich."); }
            const parsedYear = parseInt(year, 10);

            const data = await calculatePeriodData(db, name, year, periodType.toUpperCase(), periodValue); // Holt jetzt auch employeeData
            const employeeDataForPdf = data.employeeData; // <<< Mitarbeiterdaten für getExpectedHours holen

            doc = new PDFDocument(PAGE_OPTIONS);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (periodType === 'QUARTER' ? `Q${periodValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const title = periodType === 'QUARTER' ? `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}` : `Jahresnachweis ${parsedYear}`;
            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);
            const { headerBottomY, colWidths, colPositions } = drawTableHeader(doc, currentY, usableWidth);
            currentY = headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5); doc.y = currentY;
            const footerHeight = FONT_SIZE.FOOTER + V_SPACE.SIGNATURE_GAP + 1 + V_SPACE.SMALL + FONT_SIZE.FOOTER;
            const summaryHeight = 5 * (FONT_SIZE.SUMMARY + V_SPACE.TINY) + V_SPACE.LARGE;

            // Kombinierte Liste aus Arbeit und Abwesenheit für Periode
            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDaysPeriod.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntriesPeriod.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDaysPeriod.some(d => d.date === dateStr)) { allDaysPeriod.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            if (allDaysPeriod.length === 0) { doc.text('Keine Buchungen/Abwesenheiten.', doc.page.margins.left, doc.y); doc.y += TABLE_ROW_HEIGHT; }
            else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];
                    // Seitenumbruch prüfen...
                    const spaceNeededForRest = TABLE_ROW_HEIGHT + summaryHeight + footerHeight;
                    if ((doc.y + spaceNeededForRest > doc.page.height - doc.page.margins.bottom && i > 0) || (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - summaryHeight - footerHeight)) {
                        drawFooter(doc, doc.page.height - doc.page.margins.bottom - footerHeight + V_SPACE.MEDIUM);
                        doc.addPage(); currentY = doc.page.margins.top;
                        const tableLayout = drawTableHeader(doc, currentY, usableWidth); currentY = tableLayout.headerBottomY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5); doc.y = currentY;
                    }

                    // ** VERWENDET NEUE FUNKTION **
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = getExpectedHours(employeeDataForPdf, dayData.date); // Holt Soll-Std
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--"; let endOverride = dayData.endTime || "--:--";
                    if (dayData.type !== 'WORK') { startOverride = '--:--'; endOverride = dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag'); }
                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours); const diffStr = decimalHoursToHHMM(diffHours);
                    const currentRowY = doc.y;
                    const textOptions = { align: 'center', lineBreak: false };

                    doc.text(dateFormatted, colPositions.date, currentRowY, { ...textOptions, width: colWidths.date, align: 'left' }); // Formatiertes Datum
                    doc.text(startOverride, colPositions.start, currentRowY, { ...textOptions, width: colWidths.start });
                    doc.text(endOverride, colPositions.end, currentRowY, { ...textOptions, width: colWidths.end });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { ...textOptions, width: colWidths.expected });
                    doc.text(actualStr, colPositions.actual, currentRowY, { ...textOptions, width: colWidths.actual });
                    doc.text(diffStr, colPositions.diff, currentRowY, { ...textOptions, width: colWidths.diff });
                    doc.y += TABLE_ROW_HEIGHT;
                }
            }
// ENDE monthlyPdfEndpoint.js TEIL 3/4
        // START monthlyPdfEndpoint.js TEIL 4/4
            currentY = doc.y + V_SPACE.LARGE;
            // Zusammenfassung (Periode)
             if (currentY + summaryHeight + footerHeight > doc.page.height - doc.page.margins.bottom) { doc.addPage(); currentY = doc.page.margins.top; }
             doc.y = currentY;
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
             const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - V_SPACE.SMALL; const summaryValueWidth = colWidths.actual + colWidths.diff;
             const summaryLabelX = doc.page.margins.left; const summaryValueX = colPositions.actual; const summaryLineSpacing = 0.2;
             const periodLabelSummary = data.periodIdentifier || periodType;
             doc.text("Übertrag Periodenbeginn (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.startingBalance || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.text(`Gesamt Soll-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalExpectedPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.text(`Gesamt Ist-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActualPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.font(FONT_NORMAL); doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHoursPeriod)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHoursPeriod)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth-10}); doc.moveDown(summaryLineSpacing+0.3); doc.font(FONT_BOLD);
             doc.text(`Gesamt Mehr/Minderstunden (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.periodDifference || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
             doc.font(FONT_BOLD); doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.endingBalancePeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
             currentY = doc.y + V_SPACE.LARGE;

            drawFooter(doc, currentY); // Footer zeichnen
            doc.end(); // PDF abschließen

        } catch (err) {
            console.error("Fehler Erstellen Perioden-PDF:", err);
            if (!res.headersSent) { res.status(500).send(`Fehler Erstellen Perioden-PDF: ${err.message}`); }
            else { console.error("Perioden-PDF Header bereits gesendet."); if (doc && !doc.writableEnded) doc.end(); }
        }
    });

    return router;
};
// ENDE monthlyPdfEndpoint.js TEIL 4/4
