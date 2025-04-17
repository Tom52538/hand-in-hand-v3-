// monthlyPdfEndpoint.js - V10: Check tableLayout after drawTableHeader
// +++ DEBUG LOGGING WEITERHIN AKTIV +++

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere BEIDE Berechnungsfunktionen
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const PAGE_OPTIONS = { size: 'A4', autoFirstPage: false, margins: { top: 25, bottom: 35, left: 40, right: 40 } };
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { HEADER: 16, SUB_HEADER: 11, TABLE_HEADER: 9, TABLE_CONTENT: 9, SUMMARY: 8, FOOTER: 8, PAGE_NUMBER: 8 };

// Höhenabschätzungen (unverändert)
const TABLE_ROW_HEIGHT = 12;
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL;
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL;
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM;
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5;
const SUMMARY_TOTAL_HEIGHT = (7 * SUMMARY_LINE_HEIGHT) + V_SPACE.LARGE; // Angepasst für 7 Zeilen

// Formatierungsoptionen (unverändert)
const pdfDateOptions = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };
const pdfDateOptionsWithWeekday = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };

// Hilfsfunktion: Dezimalstunden in HH:MM (unverändert)
function decimalHoursToHHMM(decimalHours) {
    if (isNaN(decimalHours) || decimalHours === null) return "00:00";
    const sign = decimalHours < 0 ? "-" : "";
    const absHours = Math.abs(decimalHours);
    const totalMinutes = Math.round(absHours * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Hilfsfunktion: Datum TT.MM.YYYY (unverändert)
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

// Hilfsfunktion: Datum Wochentag. TT.MM.YYYY (unverändert)
function formatDateGermanWithWeekday(dateInput) {
    if (!dateInput) return 'N/A';
    try {
        const dateStr = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
        const dateObj = new Date(dateStr + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) return String(dateInput);
        return dateObj.toLocaleDateString('de-DE', pdfDateOptionsWithWeekday);
    } catch (e) {
        console.warn("Fehler Datum mit Wochentag:", dateInput, e);
        return String(dateInput);
    }
}

// Hilfsfunktion: Zeichnet den Dokumentenkopf (unverändert von V9)
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) {
    console.log(`[PDF DEBUG V10] drawDocumentHeader START für Titel: ${title}`);
    if (!doc || !doc.page || !doc.page.margins) { console.error("[PDF DEBUG V10] drawDocumentHeader: doc.page oder doc.page.margins ist nicht verfügbar!"); return doc.page?.margins?.top || 50; } // Fallback Y
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;
    let currentY = doc.page.margins.top;
    const headerStartY = currentY;
    try {
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        const logoWidth = 70; const logoHeight = 70;
        const logoX = doc.page.width - pageRightMargin - logoWidth;
        doc.image(logoPath, logoX, headerStartY, { width: logoWidth, height: logoHeight });
    } catch (errLogo) { console.warn("[PDF DEBUG V10] Logo Fehler:", errLogo); }
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
    const titleY = headerStartY + V_SPACE.SMALL;
    doc.text(title, pageLeftMargin, titleY, { align: 'center', width: usableWidth });
    currentY = titleY + doc.heightOfString(title, { width: usableWidth, align: 'center' }) + V_SPACE.LARGE;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
    console.log(`[PDF DEBUG V10] drawDocumentHeader ENDE bei Y=${currentY.toFixed(2)}`);
    return currentY;
}

// Hilfsfunktion: Zeichnet den Tabellenkopf (mit interner Prüfung)
function drawTableHeader(doc, startY, usableWidth) {
    console.log(`[PDF DEBUG V10] drawTableHeader START bei Y=${startY.toFixed(2)}`);
    // <<< CHANGE START - V10: Check doc state >>>
    if (!doc || !doc.page || !doc.page.margins || !usableWidth || usableWidth <= 0) {
         console.error("[PDF DEBUG V10] drawTableHeader: Ungültiger Zustand für doc oder usableWidth!");
         // Könnte null zurückgeben oder Fehler werfen, hier werfen wir Fehler:
         throw new Error("[PDF V10 Error] drawTableHeader received invalid doc state or usableWidth.");
    }
    // <<< CHANGE END >>>

    const pageLeftMargin = doc.page.margins.left;
    const colWidths = {
        date: 105, start: 65, end: 85, expected: 75, actual: 75,
        diff: usableWidth - 105 - 65 - 85 - 75 - 75
    };
    if (colWidths.diff < 30) colWidths.diff = 30;

    const colPositions = {
        date: pageLeftMargin, start: pageLeftMargin + colWidths.date,
        end: pageLeftMargin + colWidths.date + colWidths.start,
        expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
        actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
        diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
    };

    // Speichere Font-Status
    const oldFont = doc._font;
    const oldFontSize = doc._fontSize;

    try {
        doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);
        const headerTextY = startY + V_SPACE.TINY;
        doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
        doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
        doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
        doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
        doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
        doc.text("Mehr/Minder\nStd.(HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });

        const headerHeight = (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.TINY + V_SPACE.SMALL;
        const headerBottomY = startY + headerHeight;
        doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke();

        const result = { headerBottomY: headerBottomY + V_SPACE.SMALL, colWidths, colPositions };
        console.log(`[PDF DEBUG V10] drawTableHeader ENDE, returniert headerBottomY=${result.headerBottomY.toFixed(2)}`);

        // Font wiederherstellen (nur falls nötig, Header setzt meist eigenen Font)
        if (oldFont) doc.font(oldFont);
        if (oldFontSize) doc.fontSize(oldFontSize);

        return result;

    } catch (headerError){
         console.error("[PDF DEBUG V10] FEHLER innerhalb drawTableHeader!", headerError);
         // Font wiederherstellen versuchen, falls möglich
         try {
             if (oldFont) doc.font(oldFont);
             if (oldFontSize) doc.fontSize(oldFontSize);
         } catch(restoreErr){}
         // Fehler weiterwerfen, damit der Aufrufer merkt, dass es schiefging
         throw headerError;
    }
}

// Hilfsfunktion: Zeichnet die Seitenzahl UNTEN ZENTRIERT (unverändert von V9)
function drawPageNumber(doc, pageNum) {
    console.log(`[PDF DEBUG V10] drawPageNumber START für Seite ${pageNum}`);
    if (!doc || !doc.page || !doc.page.margins) { console.error("[PDF DEBUG V10] drawPageNumber: doc.page oder doc.page.margins ist nicht verfügbar!"); return; }
    const pageBottomMargin = doc.page.margins.bottom; const pageHeight = doc.page.height; const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right; const numberY = pageHeight - pageBottomMargin + V_SPACE.MEDIUM;
    const oldFont = doc._font; const oldFontSize = doc._fontSize; const oldFillColor = doc._fillColor; const oldLineGap = doc._lineGap;
    try {
        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black').lineGap(0)
           .text(`Seite ${pageNum}`, pageLeftMargin, numberY, { width: usableWidth, align: 'center' });
    } catch (fontError) { console.error("[PDF DEBUG V10] drawPageNumber: FEHLER beim Setzen des Fonts oder Zeichnen des Texts!", fontError); return; }
    try {
        if (oldFont) doc.font(oldFont); if (oldFontSize) doc.fontSize(oldFontSize); if (oldFillColor) doc.fillColor(oldFillColor);
        if (typeof oldLineGap !== 'undefined') doc.lineGap(oldLineGap);
    } catch (restoreError) { console.error("[PDF DEBUG V10] drawPageNumber: FEHLER beim Wiederherstellen des Font-Status!", restoreError); }
    console.log(`[PDF DEBUG V10] drawPageNumber ENDE für Seite ${pageNum}`);
}

// Hilfsfunktion: Zeichnet den Footer (NUR Signatur) (unverändert von V9)
function drawSignatureFooter(doc, startY) {
    console.log(`[PDF DEBUG V10] drawSignatureFooter START bei Y=${startY.toFixed(2)}`);
    if (!doc || !doc.page || !doc.page.margins) { console.error("[PDF DEBUG V10] drawSignatureFooter: doc.page oder doc.page.margins ist nicht verfügbar!"); return; }
    const pageLeftMargin = doc.page.margins.left; const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right; let currentY = startY;
    const oldFont = doc._font; const oldFontSize = doc._fontSize; const oldFillColor = doc._fillColor; const oldLineGap = doc._lineGap;
    try {
        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).lineGap(0);
        const confirmationText = "Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.";
        doc.text(confirmationText, pageLeftMargin, currentY, { align: 'left', width: usableWidth });
        currentY += doc.heightOfString(confirmationText, { width: usableWidth }) + V_SPACE.SIGNATURE_GAP;
        const lineStartX = pageLeftMargin; const lineEndX = pageLeftMargin + 200;
        doc.moveTo(lineStartX, currentY).lineTo(lineEndX, currentY).lineWidth(0.5).stroke(); currentY += V_SPACE.SMALL;
        doc.text("Datum, Unterschrift", pageLeftMargin, currentY); currentY += doc.heightOfString("Datum, Unterschrift");
    } catch(drawError) { console.error("[PDF DEBUG V10] drawSignatureFooter: FEHLER beim Zeichnen!", drawError); return; }
    try {
        if (oldFont) doc.font(oldFont); if (oldFontSize) doc.fontSize(oldFontSize); if (oldFillColor) doc.fillColor(oldFillColor);
        if (typeof oldLineGap !== 'undefined') doc.lineGap(oldLineGap);
    } catch (restoreError) { console.error("[PDF DEBUG V10] drawSignatureFooter: FEHLER beim Wiederherstellen des Font-Status!", restoreError); }
    console.log(`[PDF DEBUG V10] drawSignatureFooter ENDE bei Y=${currentY.toFixed(2)}`);
}

// Middleware: isAdmin (unverändert)
function isAdmin(req, res, next) { /* ... unverändert ... */ }

//-----------------------------------------------------
// PDF ROUTEN
//-----------------------------------------------------
module.exports = function (db) {

    // +++ TEST ROUTE (unverändert) +++
    router.get('/test', (req, res) => { /* ... unverändert ... */ });

    // GET /create-monthly-pdf (V10 - Check tableLayout)
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        console.log(`[PDF Mon V10 DEBUG] Route /create-monthly-pdf START.`);
        let doc; let currentPage = 0;
        try {
            // Parameter validieren
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) { return res.status(400).send("Parameter fehlen oder sind ungültig."); }
            const parsedYear = parseInt(year, 10); const parsedMonth = parseInt(month, 10);
            console.log(`[PDF Mon V10] Starte Generierung für ${name}, ${parsedMonth}/${parsedYear}`);

            // Daten holen
            const data = await calculateMonthlyData(db, name, year, month);
            const employeeDataForPdf = data.employeeData;

            // PDF initialisieren und Header setzen
            doc = new PDFDocument(PAGE_OPTIONS);
            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            doc.pipe(res);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            // Erste Seite hinzufügen und Kopf/Seitenzahl
            currentPage++; doc.addPage(); console.log(`[PDF Mon V10 DEBUG] Seite ${currentPage} hinzugefügt.`);
            let currentY = drawDocumentHeader(doc, `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`, data.employeeName, new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)), new Date(Date.UTC(parsedYear, parsedMonth, 0)));
            drawPageNumber(doc, currentPage);

            // Erster Tabellenkopf
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            // <<< CHANGE START - V10: Check tableLayout validity >>>
            if (!tableLayout || !tableLayout.colWidths || !tableLayout.colPositions) {
                throw new Error(`[PDF V10 Error] drawTableHeader returned invalid layout object on page ${currentPage} (initial).`);
            }
             // <<< CHANGE END >>>
            currentY = tableLayout.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); doc.y = currentY;

            // Kombinierte Liste erstellen
            const allDays = [];
            data.workEntries.forEach(entry => { const dateStr=(entry.date instanceof Date)?entry.date.toISOString().split('T')[0]:String(entry.date); allDays.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours)||0, comment: entry.comment }); });
            data.absenceEntries.forEach(absence => { const dateStr=(absence.date instanceof Date)?absence.date.toISOString().split('T')[0]:String(absence.date); if (!allDays.some(d=>d.date===dateStr)) { allDays.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours)||0, comment: absence.type==='VACATION'?'Urlaub':(absence.type==='SICK'?'Krank':'Feiertag') }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));
            // --- Schleife zum Zeichnen der Tabellenzeilen ---
            if (allDays.length === 0) {
                doc.text('Keine Buchungen/Abwesenheiten für diesen Monat.', doc.page.margins.left, doc.y, {width: usableWidth}); doc.y += TABLE_ROW_HEIGHT;
            } else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen ===
                    const estimatedLineHeight = TABLE_ROW_HEIGHT;
                    if (doc.y + estimatedLineHeight > doc.page.height - doc.page.margins.bottom) {
                        doc.addPage(); currentPage++; console.log(`[PDF Mon V10 DEBUG] Seite ${currentPage} manuell hinzugefügt.`);
                        drawPageNumber(doc, currentPage);
                        currentY = doc.page.margins.top;
                        tableLayout = drawTableHeader(doc, currentY, usableWidth); // Header neu zeichnen
                        // <<< CHANGE START - V10: Check tableLayout validity >>>
                        if (!tableLayout || !tableLayout.colWidths || !tableLayout.colPositions) {
                            throw new Error(`[PDF V10 Error] drawTableHeader returned invalid layout object on page ${currentPage} (after page break).`);
                        }
                        // <<< CHANGE END >>>
                        currentY = tableLayout.headerBottomY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); // Font neu setzen
                        doc.y = currentY;
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen ---
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT); // Font sicherstellen
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = employeeDataForPdf ? getExpectedHours(employeeDataForPdf, dayData.date) : 0;
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--"; let endOverride = dayData.endTime || "--:--"; let isAbsence = false;
                    if (dayData.type !== 'WORK') { startOverride = '--:--'; endOverride = dayData.comment || (dayData.type==='VACATION'?'Urlaub':(dayData.type==='SICK'?'Krank':'Feiertag')); isAbsence = true; }
                    const expectedStr = decimalHoursToHHMM(expectedHours); const actualStr = decimalHoursToHHMM(actualHours); const diffStr = decimalHoursToHHMM(diffHours);
                    const currentRowY = doc.y;
                    // WICHTIG: Hier greifen wir auf tableLayout zu, das muss gültig sein!
                    const { colPositions, colWidths } = tableLayout;
                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'right', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: isAbsence ? 'left' : 'right', lineBreak: false });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'right', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'right', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'right', lineBreak: false });
                    doc.y = currentRowY + TABLE_ROW_HEIGHT;
                    // --- Ende Zeile zeichnen ---
                } // Ende for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen ***

            // *** Zusammenfassung und Signatur-Footer ***
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;
            const isAtTopOfPageSummary = Math.abs(doc.y - doc.page.margins.top) < 1;
            if (!isAtTopOfPageSummary && (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom)) {
                doc.addPage(); currentPage++; console.log(`[PDF Mon V10 DEBUG] Seite ${currentPage} manuell für Summary/Footer hinzugefügt.`);
                drawPageNumber(doc, currentPage); doc.y = doc.page.margins.top;
            } else if (!isAtTopOfPageSummary) { doc.y += V_SPACE.LARGE; }

            // --- Zeichne Zusammenfassung ---
            const oldFontSum = doc._font; const oldFontSizeSum = doc._fontSize; const oldFillColorSum = doc._fillColor; const oldLineGapSum = doc._lineGap;
            try {
                doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).lineGap(0);
                const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
                const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
                const summaryLabelX = doc.page.margins.left; const summaryValueX = tableLayout.colPositions.actual; const summaryLineSpacing = 0.5;
                doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text("Gesamt Soll-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text("Gesamt Ist-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY); doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHours)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHours)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth -10}); doc.moveDown(summaryLineSpacing+0.3); doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
                const totalDiff = (data.totalActual || 0) - (data.totalExpected || 0);
                doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
                const summaryEndY = doc.y + doc.heightOfString("Neuer Übertrag...", {width: summaryLabelWidth}); doc.y = summaryEndY;
            } catch (summaryError) { console.error("[PDF Mon V10 DEBUG] FEHLER beim Zeichnen der Summary!", summaryError); throw summaryError; }
            finally { try { if (oldFontSum) doc.font(oldFontSum); if (oldFontSizeSum) doc.fontSize(oldFontSizeSum); if (oldFillColorSum) doc.fillColor(oldFillColorSum); if (typeof oldLineGapSum !== 'undefined') doc.lineGap(oldLineGapSum); } catch (restoreError) {} }

            // --- Zeichne Signatur-Footer ---
            const footerStartY = doc.y + V_SPACE.LARGE; drawSignatureFooter(doc, footerStartY);

            // --- PDF abschließen ---
            console.log("[PDF Mon V10 DEBUG] Finalisiere Dokument..."); doc.end(); console.log("[PDF Mon V10 DEBUG] doc.end() aufgerufen.");
        } catch (err) {
            // *** Fehlerbehandlung (V10 - Robust) ***
            console.error("[PDF Mon V10 DEBUG] !!!!! CATCH BLOCK REACHED (MONTHLY) !!!!!");
            console.error("Fehler Erstellen Monats-PDF V10:", err.message, err.stack);
            if (!res.headersSent) {
                console.error("[PDF Mon V10 DEBUG] Catch-Block: Sende 500er Status.");
                if (doc && doc.writable && !doc.writableEnded) { console.error("[PDF Mon V10 DEBUG] Catch-Block: Beende Stream."); doc.end(); }
                res.status(500).send(`Interner Serverfehler beim Erstellen des Monats-PDF: ${err.message}`);
            } else {
                console.error("[PDF Mon V10 DEBUG] Catch-Block: Header bereits gesendet.");
                if (doc && doc.writable && !doc.writableEnded) { console.error("[PDF Mon V10 DEBUG] Catch-Block: Beende Stream."); doc.end(); }
            }
        }
    }); // Ende /create-monthly-pdf
    //-----------------------------------------------------

     // GET /create-period-pdf (V10 - Check tableLayout)
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        console.log(`[PDF Per V10 DEBUG] Route /create-period-pdf START.`);
        let doc; let currentPage = 0;
         try {
            // Parameter validieren
            const { name, year, periodType, periodValue } = req.query;
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) { return res.status(400).send("Parameter fehlen oder sind ungültig (Name, Jahr, PeriodType)."); }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) { return res.status(400).send("Gültiger periodValue (1-4) für Quartal erforderlich."); }
            const parsedYear = parseInt(year, 10); const pTypeUpper = periodType.toUpperCase(); const pValue = pTypeUpper === 'QUARTER' ? parseInt(periodValue) : null;
            console.log(`[PDF Per V10] Starte Generierung für ${name}, ${year}, Typ: ${pTypeUpper}, Wert: ${pValue}`);

            // Daten holen
            const data = await calculatePeriodData(db, name, year, pTypeUpper, pValue);
            const employeeDataForPdf = data.employeeData;

            // PDF initialisieren und Header setzen
            doc = new PDFDocument(PAGE_OPTIONS);
            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            doc.pipe(res);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (pTypeUpper === 'QUARTER' ? `Q${pValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            // Erste Seite hinzufügen und Kopf/Seitenzahl
            currentPage++; doc.addPage(); console.log(`[PDF Per V10 DEBUG] Seite ${currentPage} hinzugefügt.`);
            const title = pTypeUpper === 'QUARTER' ? `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}` : `Jahresnachweis ${parsedYear}`;
            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);
            drawPageNumber(doc, currentPage);

            // Erster Tabellenkopf
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            // <<< CHANGE START - V10: Check tableLayout validity >>>
            if (!tableLayout || !tableLayout.colWidths || !tableLayout.colPositions) {
                 throw new Error(`[PDF V10 Error] drawTableHeader returned invalid layout object on page ${currentPage} (initial).`);
            }
            // <<< CHANGE END >>>
            currentY = tableLayout.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); doc.y = currentY;

            // Kombinierte Liste erstellen
            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(entry => { const dateStr=(entry.date instanceof Date)?entry.date.toISOString().split('T')[0]:String(entry.date); allDaysPeriod.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours)||0, comment: entry.comment }); });
            data.absenceEntriesPeriod.forEach(absence => { const dateStr=(absence.date instanceof Date)?absence.date.toISOString().split('T')[0]:String(absence.date); if (!allDaysPeriod.some(d=>d.date===dateStr)) { allDaysPeriod.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours)||0, comment: absence.type==='VACATION'?'Urlaub':(absence.type==='SICK'?'Krank':'Feiertag') }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            // --- Schleife zum Zeichnen der Tabellenzeilen (Periode) ---
            if (allDaysPeriod.length === 0) {
                 doc.text('Keine Buchungen/Abwesenheiten für diesen Zeitraum.', doc.page.margins.left, doc.y, {width: usableWidth}); doc.y += TABLE_ROW_HEIGHT;
            } else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen ===
                    const estimatedLineHeight = TABLE_ROW_HEIGHT;
                    if (doc.y + estimatedLineHeight > doc.page.height - doc.page.margins.bottom) {
                        doc.addPage(); currentPage++; console.log(`[PDF Per V10 DEBUG] Seite ${currentPage} manuell hinzugefügt.`);
                        drawPageNumber(doc, currentPage);
                        currentY = doc.page.margins.top;
                        tableLayout = drawTableHeader(doc, currentY, usableWidth); // Header neu zeichnen
                         // <<< CHANGE START - V10: Check tableLayout validity >>>
                        if (!tableLayout || !tableLayout.colWidths || !tableLayout.colPositions) {
                             throw new Error(`[PDF V10 Error] drawTableHeader returned invalid layout object on page ${currentPage} (after page break).`);
                        }
                         // <<< CHANGE END >>>
                        currentY = tableLayout.headerBottomY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); // Font neu setzen
                        doc.y = currentY;
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen ---
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT); // Font sicherstellen
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = employeeDataForPdf ? getExpectedHours(employeeDataForPdf, dayData.date) : 0;
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--"; let endOverride = dayData.endTime || "--:--"; let isAbsence = false;
                     if (dayData.type !== 'WORK') { startOverride = '--:--'; endOverride = dayData.comment || (dayData.type==='VACATION'?'Urlaub':(dayData.type==='SICK'?'Krank':'Feiertag')); isAbsence = true; }
                    const expectedStr = decimalHoursToHHMM(expectedHours); const actualStr = decimalHoursToHHMM(actualHours); const diffStr = decimalHoursToHHMM(diffHours);
                    const currentRowY = doc.y;
                     // WICHTIG: Hier greifen wir auf tableLayout zu, das muss gültig sein!
                    const { colPositions, colWidths } = tableLayout;
                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'right', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: isAbsence ? 'left' : 'right', lineBreak: false });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'right', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'right', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'right', lineBreak: false });
                    doc.y = currentRowY + TABLE_ROW_HEIGHT;
                    // --- Ende Zeile zeichnen ---
                } // Ende for-Schleife
            }
             // *** Ende Schleife für Tabellenzeilen (Periode) ***

             // *** Zusammenfassung und Signatur-Footer ***
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;
            const isAtTopOfPageSummaryPeriod = Math.abs(doc.y - doc.page.margins.top) < 1;
            if (!isAtTopOfPageSummaryPeriod && (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom)) {
                 doc.addPage(); currentPage++; console.log(`[PDF Per V10 DEBUG] Seite ${currentPage} manuell für Summary/Footer hinzugefügt.`);
                 drawPageNumber(doc, currentPage); doc.y = doc.page.margins.top;
            } else if (!isAtTopOfPageSummaryPeriod) { doc.y += V_SPACE.LARGE; }
             // --- Zeichne Zusammenfassung (Periode) ---
            const oldFontSumP = doc._font; const oldFontSizeSumP = doc._fontSize; const oldFillColorSumP = doc._fillColor; const oldLineGapSumP = doc._lineGap;
            try {
                doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).lineGap(0);
                // <<< CHANGE START - V10: Check tableLayout before accessing >>>
                 if (!tableLayout || !tableLayout.colWidths || !tableLayout.colPositions) {
                     throw new Error(`[PDF V10 Error] Invalid tableLayout object before drawing summary on page ${currentPage}.`);
                 }
                // <<< CHANGE END >>>
                const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
                const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
                const summaryLabelX = doc.page.margins.left; const summaryValueX = tableLayout.colPositions.actual; const summaryLineSpacing = 0.5; const periodLabelSummary = data.periodIdentifier || pTypeUpper;
                doc.text("Übertrag Periodenbeginn (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.startingBalance || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text(`Gesamt Soll-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalExpectedPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text(`Gesamt Ist-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActualPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY); doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHoursPeriod)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHoursPeriod)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth-10}); doc.moveDown(summaryLineSpacing+0.3); doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
                doc.text(`Gesamt Mehr/Minderstunden (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.periodDifference || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.endingBalancePeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
                const summaryEndY = doc.y + doc.heightOfString("Neuer Übertrag...", {width: summaryLabelWidth}); doc.y = summaryEndY;
            } catch (summaryError) { console.error("[PDF Per V10 DEBUG] FEHLER beim Zeichnen der Summary!", summaryError); throw summaryError; }
            finally { try { if (oldFontSumP) doc.font(oldFontSumP); if (oldFontSizeSumP) doc.fontSize(oldFontSizeSumP); if (oldFillColorSumP) doc.fillColor(oldFillColorSumP); if (typeof oldLineGapSumP !== 'undefined') doc.lineGap(oldLineGapSumP); } catch (restoreError) {} }

            // --- Zeichne Signatur-Footer ---
            const footerStartY = doc.y + V_SPACE.LARGE; drawSignatureFooter(doc, footerStartY);

            // --- PDF abschließen ---
            console.log("[PDF Per V10 DEBUG] Finalisiere Dokument..."); doc.end(); console.log("[PDF Per V10 DEBUG] doc.end() aufgerufen.");

        } catch (err) {
            // *** Fehlerbehandlung (V10 - Robust) ***
            console.error("[PDF Per V10 DEBUG] !!!!! CATCH BLOCK REACHED (PERIOD) !!!!!");
            console.error("Fehler Erstellen Perioden-PDF V10:", err.message, err.stack);
            if (!res.headersSent) {
                 console.error("[PDF Per V10 DEBUG] Catch-Block: Sende 500er Status.");
                 if (doc && doc.writable && !doc.writableEnded) { console.error("[PDF Per V10 DEBUG] Catch-Block: Beende Stream."); doc.end(); }
                 res.status(500).send(`Interner Serverfehler beim Erstellen des Perioden-PDF: ${err.message}`);
            } else {
                 console.error("[PDF Per V10 DEBUG] Catch-Block: Header bereits gesendet.");
                 if (doc && doc.writable && !doc.writableEnded) { console.error("[PDF Per V10 DEBUG] Catch-Block: Beende Stream."); doc.end(); }
            }
        } // Ende Catch-Block für die Route
    }); // Ende /create-period-pdf


    return router; // Router zurückgeben
}; // Ende module.exports
