// monthlyPdfEndpoint.js - V25: Layout-Optimierung + Seitennummerierung "Seite X von Y"
const express = require('express');
const PDFDocument = require('pdfkit');
// Angenommen, diese Hilfsfunktionen sind in 'utils' oder global verfügbar
// const { isAdmin, calculateMonthlyData, calculatePeriodData, getExpectedHours, formatDateGermanWithWeekday, decimalHoursToHHMM, translateAbsenceType } = require('../utils/sharedUtils'); // Beispielhafter Pfad
// Konstanten sollten idealerweise auch zentral definiert sein
const { PAGE_OPTIONS, FONT_NORMAL, FONT_BOLD, FONT_SIZE, V_SPACE, TABLE_ROW_HEIGHT, SUMMARY_TOTAL_HEIGHT, FOOTER_TOTAL_HEIGHT } = require('../utils/pdfConstants'); // Beispielhafter Pfad
const router = express.Router(); // Router Instanz erstellen

// --- Hilfsfunktionen (angepasst für Router-Kontext) ---

// Hilfsfunktion, um die erwarteten Stunden für einen Tag zu bekommen
// Annahme: Diese Funktion existiert und funktioniert wie im Server-Code
// Beispielhafte Signatur (Implementierung muss bereitgestellt werden)
function getExpectedHours(employeeData, dateString) {
    // Diese Funktion muss die Logik aus server.js widerspiegeln
    // oder aus einer gemeinsamen Utility-Datei importiert werden.
    // Hier nur ein Platzhalter:
    if (!employeeData || !dateString) return 0;
    const date = new Date(dateString + 'T00:00:00Z');
    const day = date.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa
    switch (day) {
        case 1: return employeeData.mo_hours || 0;
        case 2: return employeeData.di_hours || 0;
        case 3: return employeeData.mi_hours || 0;
        case 4: return employeeData.do_hours || 0;
        case 5: return employeeData.fr_hours || 0;
        default: return 0; // Sa, So
    }
}

// Beispielhafte Implementierungen für fehlende Helfer (ersetzen Sie diese mit Ihren tatsächlichen Utilities)
function formatDateGermanWithWeekday(dateString) {
    if (!dateString) return 'N/A';
    try {
        const date = new Date(dateString + 'T00:00:00Z');
        return date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    } catch (e) {
        return dateString;
    }
}

function decimalHoursToHHMM(decHours) {
    if (typeof decHours !== 'number' || isNaN(decHours)) return '--:--';
    const sign = decHours < 0 ? '-' : '';
    const absHours = Math.abs(decHours);
    const h = Math.floor(absHours);
    const m = Math.round((absHours - h) * 60);
    return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function translateAbsenceType(type) {
    switch (type) {
        case 'VACATION': return 'Urlaub';
        case 'SICK': return 'Krank';
        case 'PUBLIC_HOLIDAY': return 'Feiertag';
        default: return type || 'Abwesend';
    }
}

// Funktion zum Zeichnen des Headers (Beispiel, passen Sie es an Ihre Konstanten an)
function drawDocumentHeader(doc, title, employeeName, startDate, endDate) {
    const headerTop = doc.page.margins.top;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER_TITLE).text(title, doc.page.margins.left, headerTop, { align: 'center', width: usableWidth });
    doc.moveDown(0.5);
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.HEADER_SUBTITLE).text(`Mitarbeiter: ${employeeName || 'N/A'}`, { align: 'center', width: usableWidth });
    doc.moveDown(0.2);
    const dateRange = `Zeitraum: ${formatDateGermanWithWeekday(startDate.toISOString().split('T')[0])} - ${formatDateGermanWithWeekday(endDate.toISOString().split('T')[0])}`;
    doc.text(dateRange, { align: 'center', width: usableWidth });
    doc.moveDown(1.5);
    return doc.y; // Gibt die aktuelle Y-Position nach dem Header zurück
}

// Funktion zum Zeichnen des Tabellenkopfes (Beispiel)
function drawTableHeader(doc, startY, usableWidth) {
    const left = doc.page.margins.left;
    const headerHeight = FONT_SIZE.TABLE_HEADER * 1.5 + V_SPACE.SMALL * 2; // Geschätzte Höhe
    const headerBottomY = startY + headerHeight;

    // Spaltenbreiten definieren (Beispiel, anpassen!)
    const colWidths = {
        date: usableWidth * 0.22,
        start: usableWidth * 0.12,
        end: usableWidth * 0.18,
        expected: usableWidth * 0.16,
        actual: usableWidth * 0.16,
        diff: usableWidth * 0.16
    };
    // Spaltenpositionen berechnen
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

    const textY = startY + V_SPACE.SMALL;
    doc.text('Datum', colPositions.date, textY, { width: colWidths.date, align: 'left' });
    doc.text('Von', colPositions.start, textY, { width: colWidths.start, align: 'center' });
    doc.text('Bis / Art', colPositions.end, textY, { width: colWidths.end, align: 'left' });
    doc.text('Soll Std', colPositions.expected, textY, { width: colWidths.expected, align: 'center' });
    doc.text('Ist Std', colPositions.actual, textY, { width: colWidths.actual, align: 'center' });
    doc.text('Diff Std', colPositions.diff, textY, { width: colWidths.diff, align: 'center' });

    return { headerBottomY, colPositions, colWidths };
}

// Funktion zum Zeichnen des Footers mit Unterschriftsfeldern (Beispiel)
function drawSignatureFooter(doc, startY) {
     const left = doc.page.margins.left;
     const right = doc.page.width - doc.page.margins.right;
     const usableWidth = right - left;
     const signatureWidth = usableWidth / 2 - V_SPACE.LARGE; // Breite pro Unterschriftsfeld
     const lineY = startY + FONT_SIZE.FOOTER * 2.5; // Y-Position für die Linien

     doc.fontSize(FONT_SIZE.FOOTER).fillColor('black');

     // Unterschrift Mitarbeiter
     doc.text('Datum, Unterschrift Mitarbeiter', left, startY, { width: signatureWidth, align: 'left' });
     doc.moveTo(left, lineY).lineTo(left + signatureWidth, lineY).lineWidth(0.5).strokeColor('#333333').stroke();

     // Unterschrift Arbeitgeber
     const agX = right - signatureWidth;
     doc.text('Datum, Unterschrift Arbeitgeber', agX, startY, { width: signatureWidth, align: 'left' });
     doc.moveTo(agX, lineY).lineTo(agX + signatureWidth, lineY).lineWidth(0.5).strokeColor('#333333').stroke();

     // Erstellungsdatum (optional)
     const generatedDate = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
     const generatedTime = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
     doc.moveDown(2); // Mehr Platz nach Unterschriften
     doc.fontSize(FONT_SIZE.FOOTER_SMALL).fillColor('#666666').text(`Dokument generiert am ${generatedDate} um ${generatedTime} Uhr`, left, doc.y, { width: usableWidth, align: 'center' });

     return doc.y;
}


/* // VERALTETE Funktion (wird durch drawPageNumberWithTotal ersetzt)
function drawPageNumberOnPage(doc, pageNum) {
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const pageLeft = doc.page.margins.left;
    const pageWidth = doc.page.width - pageLeft - doc.page.margins.right;
    // Position unterhalb des Inhaltsbereichs
    const yPos = pageBottom + (V_SPACE && V_SPACE.MEDIUM ? V_SPACE.MEDIUM : 10);

    doc.save();
    const font = (typeof FONT_NORMAL !== 'undefined') ? FONT_NORMAL : 'Helvetica';
    const fontSize = (typeof FONT_SIZE !== 'undefined' && FONT_SIZE.PAGE_NUMBER) ? FONT_SIZE.PAGE_NUMBER : 8;
    doc.font(font).fontSize(fontSize).fillColor('black');
    doc.text(`Seite ${pageNum}`, pageLeft, yPos, {
        width: pageWidth,
        align: 'center'
    });
    doc.restore();
}
*/

// NEUE Funktion zum Zeichnen von "Seite X von Y"
function drawPageNumberWithTotal(doc, currentPage, totalPages) {
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const pageLeft = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeft - doc.page.margins.right;
    // Positioniere es wie zuvor, leicht unterhalb des Inhaltsbereichs
    const yPos = pageBottom + (V_SPACE && V_SPACE.MEDIUM ? V_SPACE.MEDIUM : 10); // Fallback auf 10

    // Wichtig: Font und Farbe explizit setzen, da wir Seiten wechseln
    doc.save();
    const font = (typeof FONT_NORMAL !== 'undefined') ? FONT_NORMAL : 'Helvetica';
    const fontSize = (typeof FONT_SIZE !== 'undefined' && FONT_SIZE.PAGE_NUMBER) ? FONT_SIZE.PAGE_NUMBER : 8;
    doc.font(font).fontSize(fontSize).fillColor('black');

    doc.text(
        `Seite ${currentPage} von ${totalPages}`,
        pageLeft, // Starte am linken Rand
        yPos,
        {
            width: usableWidth, // Nutze die gesamte Breite zwischen den Rändern
            align: 'center'     // Zentriere den Text
        }
    );
    doc.restore(); // Setze Font/Farbe zurück
}


// ======================================================
// ROUTER DEFINITION
// ======================================================
// Annahme: 'isAdmin', 'calculateMonthlyData', 'calculatePeriodData' werden korrekt übergeben oder importiert
module.exports = function(db, isAdmin, calculateMonthlyData, calculatePeriodData /* ggf. weitere Utils hier übergeben */) {

    // --- Route für Monats-PDF ---
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || String(parseInt(year)).length !== 4 || isNaN(parseInt(month)) || month < 1 || month > 12) {
                 return res.status(400).send('Ungültige Eingabe: Name, Jahr (YYYY) und Monat (1-12) erforderlich.');
            }
            const y = +year; const m = +month;
            console.log(`[PDF Monthly] Anfrage für ${name}, ${m}/${y}. Daten werden geholt...`);
            const data = await calculateMonthlyData(db, name, y, m); // Verwende die übergebene Funktion

            if (!data || !data.employeeData) {
                 console.warn(`[PDF Monthly] Keine Daten für ${name}, ${m}/${y} gefunden.`);
                 throw new Error(`Mitarbeiter '${name}' oder Daten für ${String(m).padStart(2, '0')}/${y} nicht gefunden.`);
            }
             console.log(`[PDF Monthly] Daten erfolgreich geholt für ${data.employeeName}. PDF wird generiert...`);

            const doc = new PDFDocument(PAGE_OPTIONS); // Verwende Konstanten
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${y}_${String(m).padStart(2, '0')}_${safeName}.pdf`;

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            // --- ENTFERNT: Alte Seitennummerierungslogik via Event ---
            /*
            let currentPage = 0;
            doc.on('pageAdded', () => {
                currentPage++;
                // drawPageNumberOnPage(doc, currentPage); // Alte Funktion nicht mehr verwenden
            });
            */

            // WICHTIG: Erste Seite initialisieren, wenn nötig
            doc.addPage(); // Erste Seite hinzufügen (benötigt für Header etc.)
            // --- ENTFERNT: Manuelles Zeichnen der ersten Seitenzahl ---
            /*
            currentPage = 1;
            // drawPageNumberOnPage(doc, currentPage); // Nicht mehr hier zeichnen
            */

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const pageBottomLimit = doc.page.height - doc.page.margins.bottom - (FOOTER_TOTAL_HEIGHT || 50); // Sicherheitsabstand für Footer

            let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`, data.employeeName, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0)));
            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDays = [];
            data.workEntries.forEach(e => allDays.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
            data.absenceEntries.forEach(a => {
                // Füge nur hinzu, wenn nicht schon ein Arbeitseintrag existiert (verhindert doppelte Tage)
                if (!allDays.find(d => d.date === a.date)) {
                    allDays.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                } else {
                    // Optional: Abwesenheits-Infos zum Arbeitstag hinzufügen oder protokollieren
                    console.log(`[PDF Monthly] Hinweis: Abwesenheit an Arbeitstag ${a.date} für ${data.employeeName} wird in Tabelle nicht separat gezeigt.`);
                }
            });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));


            allDays.forEach((d, i) => {
                // Seitenumbruch-Logik prüfen VOR dem Zeichnen der Zeile
                 if (i > 0 && (doc.y + (TABLE_ROW_HEIGHT || 15) + (V_SPACE.SMALL || 3) > pageBottomLimit)) {
                    // Keine Seitenzahl hier zeichnen, das passiert am Ende
                    doc.addPage();
                    // Kopfzeile auf neuer Seite zeichnen
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }

                // Tabellenzeile zeichnen
                const currentLineY = doc.y;
                const expH = getExpectedHours(data.employeeData, d.date); // Verwende Helfer
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date); // Verwende Helfer
                let sStart = '--:--';
                let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center';
                let actualAlign = 'center';
                let diffAlign = 'center';

                if (d.type === 'WORK') {
                    sStart = d.start || '--:--';
                    sEnd = d.end || '--:--';
                    endAlign = 'center';
                } else {
                    sEnd = translateAbsenceType(d.type); // Verwende Helfer
                     // Optional: Kommentar für Abwesenheit anzeigen? Ggf. in eigener Spalte oder unter "Bis / Art"
                     if(d.comment) sEnd += ` (${d.comment})`;
                }
                const sExp = decimalHoursToHHMM(expH); // Verwende Helfer
                const sAct = decimalHoursToHHMM(actH); // Verwende Helfer
                const sDiff = decimalHoursToHHMM(diffH); // Verwende Helfer
                const p = table.colPositions; const w = table.colWidths;

                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });
                doc.y = currentLineY + (TABLE_ROW_HEIGHT || 15); // Konstante verwenden
                // Trennlinie nach jeder Zeile
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                    .moveTo(left, doc.y - (V_SPACE.SMALL || 3)).lineTo(left + uW, doc.y - (V_SPACE.SMALL || 3)).stroke().restore();
            });

            // Prüfen, ob genug Platz für Summary und Footer ist
             const summaryAndFooterHeight = (SUMMARY_TOTAL_HEIGHT || 100) + (FOOTER_TOTAL_HEIGHT || 50) + (V_SPACE.LARGE || 15) + (V_SPACE.XLARGE || 20);
             if (doc.y + summaryAndFooterHeight > pageBottomLimit) {
                 console.log("[PDF Monthly] Seitenumbruch vor Zusammenfassung/Footer benötigt.");
                 // Keine Seitenzahl hier zeichnen
                 doc.addPage();
                 doc.y = doc.page.margins.top; // Starte oben auf neuer Seite
             } else {
                  doc.y += (V_SPACE.LARGE || 15); // Platz vor Summary
             }

            // Zusammenfassung zeichnen
             const summaryYStart = doc.y;
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
             // Spaltenbreiten/-positionen für Summary (aus Tabelle übernehmen oder neu definieren)
             const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - (V_SPACE.SMALL || 3);
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
             doc.text(`(davon gearb.: ${gearbStdM}, Abwesenh.: ${abwesStdM})`, left + (V_SPACE.MEDIUM || 5), doc.y, { width: lblW });
             doc.moveDown(0.5);
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
             doc.text('Gesamt Mehr/Minderstunden:', left, doc.y, { width: lblW });
             doc.text(decimalHoursToHHMM(data.totalDifference), valX, doc.y, { width: valW, align: 'right' });
             doc.moveDown(0.5);
             doc.text('Neuer Übertrag (Saldo Ende):', left, doc.y, { width: lblW });
             doc.text(decimalHoursToHHMM(data.newCarryOver), valX, doc.y, { width: valW, align: 'right' });

            // Footer zeichnen
             drawSignatureFooter(doc, doc.y + (V_SPACE.LARGE || 15)); // Füge Platz hinzu


            // FINAL STEP: Füge Seitennummern "Seite X von Y" hinzu
            const range = doc.bufferedPageRange(); // { start: 0, count: totalPages }
            const totalPages = range.count;
            for (let i = range.start; i < range.count; i++) {
                doc.switchToPage(i); // Wechsle zur Seite mit Index i (0-basiert)
                // Rufe die NEUE Funktion auf, Seitenzahl ist i + 1
                drawPageNumberWithTotal(doc, i + 1, totalPages);
            }

            // Erst JETZT das Dokument finalisieren und senden
            doc.end();
            console.log(`[PDF Monthly] Generierung für ${data.employeeName} (${m}/${y}) abgeschlossen und gesendet. Total Pages: ${totalPages}`);


        } catch (err) {
             console.error('[PDF Monthly] Kritischer Fehler:', err);
             if (!res.headersSent) {
                 // Sende spezifische Fehlermeldung, wenn möglich
                 const userMessage = err.message.includes("nicht gefunden")
                    ? err.message
                    : `Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`;
                 res.status(err.message.includes("nicht gefunden") ? 404 : 500).send(userMessage);
             }
        }
    });

    // --- Route für Perioden-PDF (Quartal/Jahr) MIT TABELLE ---
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, periodType, periodValue } = req.query;
             if (!name || !year || isNaN(+year) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 return res.status(400).send('Parameter fehlen oder ungültig (Name, Jahr, periodType=QUARTER/YEAR).');
             }
             const y = +year;
             const pType = periodType.toUpperCase();
             let pValue = periodValue ? parseInt(periodValue) : null;

             if (pType === 'QUARTER' && (isNaN(pValue) || pValue < 1 || pValue > 4)) {
                  return res.status(400).send('Ungültiger periodValue (1-4) für QUARTER erforderlich.');
             }
             console.log(`[PDF Period] Anfrage für ${name}, ${pType}${pValue ? ' '+pValue : ''}/${y}. Daten werden geholt...`);
             const data = await calculatePeriodData(db, name, y, pType, pValue); // Verwende übergebene Funktion

             if (!data || !data.employeeData) {
                const periodDesc = pType === 'QUARTER' ? `Q${pValue}/${y}` : `Jahr ${y}`;
                console.warn(`[PDF Period] Keine Daten für ${name}, ${periodDesc} gefunden.`);
                throw new Error(`Mitarbeiter '${name}' oder Daten für ${periodDesc} nicht gefunden.`);
             }
             console.log(`[PDF Period] Daten erfolgreich geholt für ${data.employeeName}. PDF wird generiert...`);

            const doc = new PDFDocument(PAGE_OPTIONS);
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

            // --- ENTFERNT: Alte Seitennummerierungslogik via Event ---
            /*
            let currentPage = 0;
            doc.on('pageAdded', () => {
                currentPage++;
                // drawPageNumberOnPage(doc, currentPage);
            });
            */

            // Erste Seite initialisieren
            doc.addPage();
            // --- ENTFERNT: Manuelles Zeichnen der ersten Seitenzahl ---
            /*
            currentPage = 1;
            // drawPageNumberOnPage(doc, currentPage);
            */

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const pageBottomLimit = doc.page.height - doc.page.margins.bottom - (FOOTER_TOTAL_HEIGHT || 50); // Sicherheitsabstand

            let yPos = drawDocumentHeader(doc, titleDesc, data.employeeName, new Date(data.periodStartDate + 'T00:00:00Z'), new Date(data.periodEndDate + 'T00:00:00Z'));

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDaysPeriod = [];
             data.workEntriesPeriod.forEach(e => allDaysPeriod.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
             data.absenceEntriesPeriod.forEach(a => {
                 if (!allDaysPeriod.find(d => d.date === a.date)) {
                      allDaysPeriod.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                 } else {
                     console.log(`[PDF Period] Hinweis: Abwesenheit an Arbeitstag ${a.date} für ${data.employeeName} wird in Tabelle nicht separat gezeigt.`);
                 }
             });
             allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));


            allDaysPeriod.forEach((d, i) => {
                // Seitenumbruch-Logik
                  if (i > 0 && (doc.y + (TABLE_ROW_HEIGHT || 15) + (V_SPACE.SMALL || 3) > pageBottomLimit)) {
                     // Keine Seitenzahl hier zeichnen
                     doc.addPage();
                     const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                     doc.y = nextTable.headerBottomY;
                     doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                 }

                // Tabellenzeile zeichnen
                 const currentLineY = doc.y;
                 const expH = getExpectedHours(data.employeeData, d.date);
                 const actH = d.actual;
                 const diffH = actH - expH;
                 const sDate = formatDateGermanWithWeekday(d.date);
                 let sStart = '--:--';
                 let sEnd = '--:--';
                 let endAlign = 'left'; let startAlign = 'center';
                 let expectedAlign = 'center';
                 let actualAlign = 'center';
                 let diffAlign = 'center';

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
                 doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                 doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                 doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                 doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                 doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                 doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });
                 doc.y = currentLineY + (TABLE_ROW_HEIGHT || 15);
                 doc.save().lineWidth(0.25).strokeColor('#dddddd')
                     .moveTo(left, doc.y - (V_SPACE.SMALL || 3)).lineTo(left + uW, doc.y - (V_SPACE.SMALL || 3)).stroke().restore();
            });

            // Check vor Summary/Footer
             const summaryAndFooterHeight = (SUMMARY_TOTAL_HEIGHT || 100) + (FOOTER_TOTAL_HEIGHT || 50) + (V_SPACE.LARGE || 15) + (V_SPACE.XLARGE || 20);
             if (doc.y + summaryAndFooterHeight > pageBottomLimit) {
                  console.log("[PDF Period] Seitenumbruch vor Zusammenfassung/Footer benötigt.");
                  // Keine Seitenzahl hier zeichnen
                  doc.addPage();
                  doc.y = doc.page.margins.top;
             } else {
                  doc.y += (V_SPACE.LARGE || 15);
             }

            // Zusammenfassung zeichnen
             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY_TITLE).fillColor('black');
             doc.text(`Zusammenfassung für ${data.periodIdentifier} ${y}`, left, doc.y, { align: 'left' });
             doc.moveDown(1.5);
             // Verwende Breiten/Positionen ähnlich wie im Monatsbericht, ggf. anpassen
             const periodLblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - (V_SPACE.SMALL || 3); // Beispielbreite für Labels
             const periodValX = table.colPositions.actual; // Start X für Werte
             const periodValW = table.colWidths.actual + table.colWidths.diff; // Breite für Werte

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
              doc.text(`(davon gearb.: ${gearbStdP}, Abwesenh.: ${abwesStdP})`, left + (V_SPACE.MEDIUM || 5), doc.y, { width: periodLblW });
              doc.moveDown(0.7);
              doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
              doc.text(`Differenz (${data.periodIdentifier}):`, left, doc.y, { width: periodLblW });
              doc.text(decimalHoursToHHMM(data.periodDifference), periodValX, doc.y, { width: periodValW, align: 'right' });
              doc.moveDown(0.7);
              doc.text('Neuer Übertrag (Saldo Periodenende):', left, doc.y, { width: periodLblW });
              doc.text(decimalHoursToHHMM(data.endingBalancePeriod), periodValX, doc.y, { width: periodValW, align: 'right' });

             // Footer zeichnen
             drawSignatureFooter(doc, doc.y + (V_SPACE.XLARGE || 20)); // Mehr Platz


            // FINAL STEP: Füge Seitennummern "Seite X von Y" hinzu
            const range = doc.bufferedPageRange(); // { start: 0, count: totalPages }
            const totalPages = range.count;
            for (let i = range.start; i < range.count; i++) {
                doc.switchToPage(i); // Wechsle zur Seite mit Index i (0-basiert)
                // Rufe die NEUE Funktion auf, Seitenzahl ist i + 1
                drawPageNumberWithTotal(doc, i + 1, totalPages);
            }

            // Erst JETZT das Dokument finalisieren und senden
            doc.end();
            console.log(`[PDF Period] Generierung für ${data.employeeName} (${periodDescFile}) abgeschlossen und gesendet. Total Pages: ${totalPages}`);


        } catch (err) {
            console.error('[PDF Period] Kritischer Fehler:', err);
             if (!res.headersSent) {
                 const userMessage = err.message.includes("nicht gefunden")
                    ? err.message
                    : `Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`;
                 res.status(err.message.includes("nicht gefunden") ? 404 : 500).send(userMessage);
             }
        }
    });

    return router;
};
