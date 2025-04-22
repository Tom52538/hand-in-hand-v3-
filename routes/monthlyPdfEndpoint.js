// routes/monthlyPdfEndpoint.js - V27: Robuste Version mit "Seite X von Y" Paginierung, lokalen Konstanten & Utilities
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path'); // Für Schriftarten benötigt (optional)

// Importiere Berechnungsfunktionen direkt aus dem korrekten Pfad
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('../utils/calculationUtils');

const router = express.Router(); // Router Instanz erstellen

// --- Konstanten Definition (da keine separate Datei existiert) ---
const PAGE_OPTIONS = {
    size: 'A4',
    margin: 50 // Standard-Margin (ca. 1.76cm)
};
// Verwende Standard PDFKit Schriften (Helvetica)
const FONT_NORMAL = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

const FONT_SIZE = {
    HEADER_TITLE: 16,
    HEADER_SUBTITLE: 12,
    TABLE_HEADER: 9,
    TABLE_CONTENT: 9,
    SUMMARY_TITLE: 11,
    SUMMARY: 10,
    SUMMARY_DETAIL: 8,
    FOOTER: 9,
    FOOTER_SMALL: 7,
    PAGE_NUMBER: 8
};
const V_SPACE = { // Vertikale Abstände
    SMALL: 3,
    MEDIUM: 5,
    LARGE: 10,
    XLARGE: 15
};
// Abgeleitete Konstanten (können angepasst werden)
const TABLE_ROW_HEIGHT = FONT_SIZE.TABLE_CONTENT * 1.6; // Etwas mehr Platz pro Zeile
const SUMMARY_TOTAL_HEIGHT = 120; // Geschätzter Platzbedarf für die Zusammenfassung
const FOOTER_TOTAL_HEIGHT = 70;  // Geschätzter Platzbedarf für den Footer + Generierungsdatum

// --- Hilfsfunktionen (lokal definiert, da timeUtils.js kommentiert ist) ---

function decimalHoursToHHMM(decHours) {
    if (typeof decHours !== 'number' || isNaN(decHours)) return '--:--';
    const sign = decHours < 0 ? '-' : '';
    const absHours = Math.abs(decHours);
    const h = Math.floor(absHours);
    const m = Math.round((absHours - h) * 60);
    return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDateGermanWithWeekday(dateInput) {
    if (!dateInput) return 'N/A';
    try {
        const date = (dateInput instanceof Date) ? dateInput : new Date(String(dateInput).split('T')[0] + 'T00:00:00Z');
        if (isNaN(date.getTime())) return String(dateInput);
        return date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    } catch (e) {
        console.error("Fehler bei formatDateGermanWithWeekday:", e);
        return String(dateInput);
    }
}

function translateAbsenceType(type) {
    switch (String(type).toUpperCase()) {
        case 'VACATION': return 'Urlaub';
        case 'SICK': return 'Krank';
        case 'PUBLIC_HOLIDAY': return 'Feiertag';
        default: return type || 'Abwesend';
    }
}

// --- PDF Zeichenfunktionen ---

function drawDocumentHeader(doc, title, employeeName, startDate, endDate) {
    const headerTop = doc.page.margins.top;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER_TITLE).text(title, doc.page.margins.left, headerTop, { align: 'center', width: usableWidth });
    doc.moveDown(0.5);
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.HEADER_SUBTITLE).text(`Mitarbeiter: ${employeeName || 'N/A'}`, { align: 'center', width: usableWidth });
    doc.moveDown(0.2);

    const safeStartDate = (startDate instanceof Date) ? startDate : new Date(startDate);
    const safeEndDate = (endDate instanceof Date) ? endDate : new Date(endDate);
    const dateRange = `Zeitraum: ${formatDateGermanWithWeekday(safeStartDate)} - ${formatDateGermanWithWeekday(safeEndDate)}`;
    doc.text(dateRange, { align: 'center', width: usableWidth });
    doc.moveDown(1.5);
    return doc.y;
}

function drawTableHeader(doc, startY, usableWidth) {
    const left = doc.page.margins.left;
    const headerHeight = FONT_SIZE.TABLE_HEADER * 1.5 + V_SPACE.MEDIUM * 2;
    const headerBottomY = startY + headerHeight;

    const colWidths = {
        date: usableWidth * 0.25,
        start: usableWidth * 0.10,
        end: usableWidth * 0.20,
        expected: usableWidth * 0.15,
        actual: usableWidth * 0.15,
        diff: usableWidth * 0.15
    };
    const colPositions = {
        date: left,
        start: left + colWidths.date,
        end: left + colWidths.date + colWidths.start,
        expected: left + colWidths.date + colWidths.start + colWidths.end,
        actual: left + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
        diff: left + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
    };

    doc.rect(left, startY, usableWidth, headerHeight).fillAndStroke('#E8E8E8', '#AAAAAA');
    doc.fillColor('black').font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);

    const textY = startY + V_SPACE.MEDIUM;
    doc.text('Datum', colPositions.date, textY, { width: colWidths.date, align: 'left', lineBreak: false });
    doc.text('Von', colPositions.start, textY, { width: colWidths.start, align: 'center', lineBreak: false });
    doc.text('Bis / Art', colPositions.end, textY, { width: colWidths.end, align: 'left', lineBreak: false });
    doc.text('Soll Std', colPositions.expected, textY, { width: colWidths.expected, align: 'center', lineBreak: false });
    doc.text('Ist Std', colPositions.actual, textY, { width: colWidths.actual, align: 'center', lineBreak: false });
    doc.text('Diff Std', colPositions.diff, textY, { width: colWidths.diff, align: 'center', lineBreak: false });

    // Setze die y-Position *nach* dem Zeichnen des Headers, bevor die Funktion zurückkehrt
    doc.y = headerBottomY;
    return { colPositions, colWidths }; // headerBottomY wird nicht mehr benötigt, da doc.y gesetzt wird
}

function drawSignatureFooter(doc, startY) {
     const left = doc.page.margins.left;
     const right = doc.page.width - doc.page.margins.right;
     const usableWidth = right - left;
     const signatureWidth = usableWidth / 2 - V_SPACE.LARGE;
     const lineY = startY + FONT_SIZE.FOOTER * 2.5;

     doc.fontSize(FONT_SIZE.FOOTER).fillColor('black');

     doc.text('Datum, Unterschrift Mitarbeiter', left, startY, { width: signatureWidth, align: 'left' });
     doc.moveTo(left, lineY).lineTo(left + signatureWidth, lineY).lineWidth(0.5).strokeColor('#333333').stroke();

     const agX = right - signatureWidth;
     doc.text('Datum, Unterschrift Arbeitgeber', agX, startY, { width: signatureWidth, align: 'left' });
     doc.moveTo(agX, lineY).lineTo(agX + signatureWidth, lineY).lineWidth(0.5).strokeColor('#333333').stroke();

     const generatedDate = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
     const generatedTime = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

     doc.fontSize(FONT_SIZE.FOOTER_SMALL).fillColor('#666666')
        .text(`Dokument generiert am ${generatedDate} um ${generatedTime} Uhr`, left, lineY + V_SPACE.LARGE, { width: usableWidth, align: 'center' });

     // Wichtig: Die Y-Position nach dem Footer aktualisieren, falls noch etwas folgt
     doc.y = lineY + V_SPACE.LARGE + FONT_SIZE.FOOTER_SMALL;
}

// Funktion zum Zeichnen von "Seite X von Y"
function drawPageNumberWithTotal(doc, currentPage, totalPages) {
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const pageLeft = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeft - doc.page.margins.right;
    // Y-Position leicht unterhalb des Hauptinhaltsbereichs
    const yPos = pageBottom + V_SPACE.MEDIUM;

    doc.save(); // Zustand speichern (Font, Farbe etc.)
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black');
    doc.text(
        `Seite ${currentPage} von ${totalPages}`,
        pageLeft,
        yPos,
        {
            width: usableWidth,
            align: 'center'
        }
    );
    doc.restore(); // Zustand wiederherstellen
}


// ======================================================
// ROUTER DEFINITION
// ======================================================
// isAdmin wird hier nicht mehr übergeben, muss in server.js angewendet werden
module.exports = function(db) {

    // --- Route für Monats-PDF ---
    // isAdmin muss in server.js vor dieser Route als Middleware stehen
    router.get('/create-monthly-pdf', async (req, res, next) => {
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4 || isNaN(parseInt(month)) || month < 1 || month > 12) {
                 const err = new Error('Ungültige Eingabe: Name, Jahr (YYYY) und Monat (1-12) erforderlich.');
                 err.status = 400;
                 return next(err); // Fehler an Handler übergeben
            }
            const y = +year; const m = +month;
            console.log(`[PDF Monthly] Anfrage für ${name}, ${m}/${y}. Daten werden geholt...`);

            const data = await calculateMonthlyData(db, name, y, m); // Importierte Funktion

            if (!data || !data.employeeData) {
                 const err = new Error(`Mitarbeiter '${name}' oder Daten für ${String(m).padStart(2, '0')}/${y} nicht gefunden.`);
                 err.status = 404;
                 return next(err); // Fehler an Handler übergeben
            }
             console.log(`[PDF Monthly] Daten erfolgreich geholt für ${data.employeeName}. PDF wird generiert...`);

            const doc = new PDFDocument(PAGE_OPTIONS); // Konstante verwenden
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${y}_${String(m).padStart(2, '0')}_${safeName}.pdf`;

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            // --- KEINE Event-Listener für Seitenzahlen mehr ---

            // Erste Seite wird durch addPage() implizit oder explizit vor dem ersten Inhalt erstellt
            // doc.addPage(); // Nur wenn nötig, z.B. wenn erste Seite leer sein soll

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            // Untere Grenze für Inhalt definieren
            const pageBottomLimit = doc.page.height - doc.page.margins.bottom - FOOTER_TOTAL_HEIGHT - V_SPACE.LARGE;

            // Header auf erster Seite zeichnen (addPage wird hier ggf. implizit von PDFKit aufgerufen)
            let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`, data.employeeName, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0)));
            const table = drawTableHeader(doc, yPos, uW);
            // yPos wird in drawTableHeader gesetzt durch doc.y = headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');

            const allDays = [];
             data.workEntries.forEach(e => allDays.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
             data.absenceEntries.forEach(a => {
                 const absenceDateStr = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date).split('T')[0];
                 if (!allDays.find(d => ((d.date instanceof Date ? d.date.toISOString().split('T')[0] : String(d.date).split('T')[0]) === absenceDateStr))) {
                     allDays.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                 }
             });
             allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            // --- Tabellenzeilen zeichnen ---
            allDays.forEach((d) => {
                 // Seitenumbruch-Prüfung VOR dem Zeichnen
                 if (doc.y + TABLE_ROW_HEIGHT + V_SPACE.SMALL > pageBottomLimit) {
                    doc.addPage(); // PDFKit fügt Seite hinzu, KEINE manuelle Seitenzahl
                    drawTableHeader(doc, doc.page.margins.top, uW); // Tabellenkopf auf neuer Seite
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black'); // Font wieder setzen
                }

                const currentLineY = doc.y; // Aktuelle Y-Position merken
                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--';
                let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center'; let actualAlign = 'center'; let diffAlign = 'center';

                if (d.type === 'WORK') {
                    sStart = d.start || '--:--';
                    sEnd = d.end || '--:--';
                    endAlign = 'center';
                } else {
                    sEnd = translateAbsenceType(d.type);
                    if(d.comment) sEnd += ` (${d.comment})`;
                }
                const sExp = decimalHoursToHHMM(expH);
                const sAct = decimalHoursToHHMM(actH);
                const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;

                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date, lineBreak: false });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign, lineBreak: false });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign, lineBreak: false }); // Kommentar darf umbrechen
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign, lineBreak: false });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign, lineBreak: false });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign, lineBreak: false });

                // Setze Y-Position explizit nach dem Zeichnen der höchsten Zelle (oder fester Höhe)
                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Trennlinie nach jeder Zeile
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                    .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });

            // --- Zusammenfassung und Footer ---
             const summaryAndFooterHeightCombined = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;
             if (doc.y + summaryAndFooterHeightCombined > pageBottomLimit) {
                 console.log("[PDF Monthly] Seitenumbruch vor Zusammenfassung/Footer benötigt.");
                 doc.addPage(); // PDFKit fügt Seite hinzu
                 // Optional: Header wiederholen? Meist nicht nötig vor Summary.
                 doc.y = doc.page.margins.top; // Starte oben
             } else {
                  doc.y += V_SPACE.LARGE; // Platz vor Summary
             }

            // Zusammenfassung
             const summaryYStart = doc.y; // Merke Start Y für Footer-Positionierung
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

            // Footer (wird am Ende der Summary platziert)
             drawSignatureFooter(doc, doc.y + V_SPACE.LARGE);


            // ===============================================================
            // FINAL STEP: Füge Seitennummern "Seite X von Y" hinzu
            // ===============================================================
            const range = doc.bufferedPageRange();
            const totalPages = range.count;
            for (let i = range.start; i < range.count; i++) {
                doc.switchToPage(i);
                drawPageNumberWithTotal(doc, i + 1, totalPages); // Eigene Funktion
            }

            doc.end(); // Dokument abschließen und Stream senden
            console.log(`[PDF Monthly] Generierung für ${data.employeeName} (${m}/${y}) abgeschlossen. Total Pages: ${totalPages}`);

        } catch (err) {
             console.error('[PDF Monthly] Fehler in Route:', err);
             // Leite den Fehler an den globalen Error Handler weiter
             if (!res.headersSent) {
                 res.status(err.status || 500);
             }
             next(err);
        }
    });

    // --- Route für Perioden-PDF ---
    // isAdmin muss in server.js vor dieser Route als Middleware stehen
    router.get('/create-period-pdf', async (req, res, next) => {
        try {
            const { name, year, periodType, periodValue } = req.query;
             if (!name || !year || isNaN(+year) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 const err = new Error('Parameter fehlen oder ungültig (Name, Jahr, periodType=QUARTER/YEAR).');
                 err.status = 400;
                 return next(err);
             }
             const y = +year;
             const pType = periodType.toUpperCase();
             let pValue = periodValue ? parseInt(periodValue) : null;

             if (pType === 'QUARTER' && (isNaN(pValue) || pValue < 1 || pValue > 4)) {
                  const err = new Error('Ungültiger periodValue (1-4) für QUARTER erforderlich.');
                  err.status = 400;
                  return next(err);
             }
             console.log(`[PDF Period] Anfrage für ${name}, ${pType}${pValue ? ' '+pValue : ''}/${y}. Daten werden geholt...`);

             const data = await calculatePeriodData(db, name, y, pType, pValue); // Importierte Funktion

             if (!data || !data.employeeData) {
                const periodDesc = pType === 'QUARTER' ? `Q${pValue}/${y}` : `Jahr ${y}`;
                const err = new Error(`Mitarbeiter '${name}' oder Daten für ${periodDesc} nicht gefunden.`);
                err.status = 404;
                return next(err);
             }
             console.log(`[PDF Period] Daten erfolgreich geholt für ${data.employeeName}. PDF wird generiert...`);

            const doc = new PDFDocument(PAGE_OPTIONS); // Konstante
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            let periodDescFile = ''; let titleDesc = '';
             if (pType === 'QUARTER') {
                  periodDescFile = `Q${pValue}_${y}`;
                  titleDesc = `Quartalsübersicht ${data.periodIdentifier}/${y}`;
             } else {
                  periodDescFile = `Jahr_${y}`;
                  titleDesc = `Jahresübersicht ${y}`;
             }
            const filename = `Bericht_${periodDescFile}_${safeName}.pdf`;

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            // --- KEINE Event-Listener für Seitenzahlen mehr ---

            // Erste Seite
            // doc.addPage(); // Nur wenn nötig

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const pageBottomLimit = doc.page.height - doc.page.margins.bottom - FOOTER_TOTAL_HEIGHT - V_SPACE.LARGE;

            // Header
            let yPos = drawDocumentHeader(doc, titleDesc, data.employeeName, new Date(data.periodStartDate + 'T00:00:00Z'), new Date(data.periodEndDate + 'T00:00:00Z'));
            const table = drawTableHeader(doc, yPos, uW);
            // yPos in drawTableHeader gesetzt
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');

            const allDaysPeriod = [];
             data.workEntriesPeriod.forEach(e => allDaysPeriod.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
             data.absenceEntriesPeriod.forEach(a => {
                 const absenceDateStr = (a.date instanceof Date) ? a.date.toISOString().split('T')[0] : String(a.date).split('T')[0];
                 if (!allDaysPeriod.find(d => ((d.date instanceof Date ? d.date.toISOString().split('T')[0] : String(d.date).split('T')[0]) === absenceDateStr))) {
                      allDaysPeriod.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                 }
             });
             allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            // --- Tabellenzeilen ---
            allDaysPeriod.forEach((d) => {
                  // Seitenumbruch
                  if (doc.y + TABLE_ROW_HEIGHT + V_SPACE.SMALL > pageBottomLimit) {
                     doc.addPage();
                     drawTableHeader(doc, doc.page.margins.top, uW);
                     doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                 }

                // Zeile zeichnen
                 const currentLineY = doc.y;
                 const expH = getExpectedHours(data.employeeData, d.date);
                 const actH = d.actual;
                 const diffH = actH - expH;
                 const sDate = formatDateGermanWithWeekday(d.date);
                 let sStart = '--:--';
                 let sEnd = '--:--';
                 let endAlign = 'left'; let startAlign = 'center';
                 let expectedAlign = 'center'; let actualAlign = 'center'; let diffAlign = 'center';

                 if (d.type === 'WORK') {
                      sStart = d.start || '--:--';
                      sEnd = d.end || '--:--';
                      endAlign = 'center';
                 } else {
                      sEnd = translateAbsenceType(d.type);
                      if(d.comment) sEnd += ` (${d.comment})`;
                 }
                 const sExp = decimalHoursToHHMM(expH);
                 const sAct = decimalHoursToHHMM(actH);
                 const sDiff = decimalHoursToHHMM(diffH);
                 const p = table.colPositions; const w = table.colWidths;

                 doc.fillColor('black');
                 doc.text(sDate,    p.date,     currentLineY, { width: w.date, lineBreak: false });
                 doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign, lineBreak: false });
                 doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign, lineBreak: false });
                 doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign, lineBreak: false });
                 doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign, lineBreak: false });
                 doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign, lineBreak: false });

                 doc.y = currentLineY + TABLE_ROW_HEIGHT; // Nächste Zeile

                 doc.save().lineWidth(0.25).strokeColor('#dddddd')
                     .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });

            // --- Summary und Footer ---
             const summaryAndFooterHeightCombined = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;
             if (doc.y + summaryAndFooterHeightCombined > pageBottomLimit) {
                  console.log("[PDF Period] Seitenumbruch vor Zusammenfassung/Footer benötigt.");
                  doc.addPage();
                  doc.y = doc.page.margins.top;
             } else {
                  doc.y += V_SPACE.LARGE;
             }

            // Zusammenfassung
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY_TITLE).fillColor('black');
             doc.text(`Zusammenfassung für ${data.periodIdentifier} ${y}`, left, doc.y, { align: 'left' });
             doc.moveDown(1.5);
             const periodLblW = 250;
             const periodValX = left + periodLblW + V_SPACE.MEDIUM;
             const periodValW = uW - periodLblW - V_SPACE.MEDIUM;

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

             // Footer
             drawSignatureFooter(doc, doc.y + V_SPACE.XLARGE);


            // ===============================================================
            // FINAL STEP: Füge Seitennummern "Seite X von Y" hinzu
            // ===============================================================
            const range = doc.bufferedPageRange();
            const totalPages = range.count;
            for (let i = range.start; i < range.count; i++) {
                doc.switchToPage(i);
                drawPageNumberWithTotal(doc, i + 1, totalPages); // Eigene Funktion
            }

            doc.end(); // Dokument abschließen
            console.log(`[PDF Period] Generierung für ${data.employeeName} (${periodDescFile}) abgeschlossen. Total Pages: ${totalPages}`);

        } catch (err) {
             console.error('[PDF Period] Fehler in Route:', err);
             if (!res.headersSent) {
                 res.status(err.status || 500);
             }
             next(err); // Weiterleiten an globalen Handler
        }
    });

    // Router zurückgeben
    return router;
};
