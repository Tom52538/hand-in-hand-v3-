// monthlyPdfEndpoint.js - V3: Paginierung + Test Route + Layout-Verbesserungen

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere BEIDE Berechnungsfunktionen
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const PAGE_OPTIONS = { size: 'A4', autoFirstPage: false, margins: { top: 25, bottom: 35, left: 40, right: 40 } }; // Mehr Platz unten für Seitenzahl
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { HEADER: 16, SUB_HEADER: 11, TABLE_HEADER: 9, TABLE_CONTENT: 9, SUMMARY: 8, FOOTER: 8, PAGE_NUMBER: 8 };

// *** WICHTIG: Höhenabschätzungen - Anpassen bei Bedarf! ***
const TABLE_ROW_HEIGHT = 12; // Etwas mehr Höhe für Lesbarkeit
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL; // Höhe des Bestätigungstextes
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL; // Platz für Linie + "Datum, Unterschrift"
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM; // Geschätzte Gesamthöhe des Footers inkl. Abstände

// Höhe der Zusammenfassung (Beispiel, ggf. genauer berechnen/testen)
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5; // Ca. Höhe einer Zeile in der Summary
const SUMMARY_TOTAL_HEIGHT = (7 * SUMMARY_LINE_HEIGHT) + V_SPACE.LARGE; // Geschätzte Gesamthöhe

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

// Hilfsfunktion: Zeichnet den Dokumentenkopf (Logo, Titel, Name, Zeitraum) - unverändert
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) {
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;
    let currentY = doc.page.margins.top;
    const headerStartY = currentY;

    try {
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        const logoWidth = 70;
        const logoHeight = 70;
        const logoX = doc.page.width - pageRightMargin - logoWidth;
        doc.image(logoPath, logoX, currentY, { width: logoWidth, height: logoHeight });
        currentY += V_SPACE.SMALL;
    } catch (errLogo) {
        console.warn("Logo Fehler:", errLogo);
        currentY += V_SPACE.SMALL;
    }

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
    doc.text(title, pageLeftMargin, headerStartY + V_SPACE.SMALL, { align: 'center', width: usableWidth });

    currentY = headerStartY + V_SPACE.SMALL + FONT_SIZE.HEADER + V_SPACE.LARGE;

    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;

    return currentY;
}

// Hilfsfunktion: Zeichnet den Tabellenkopf - unverändert
function drawTableHeader(doc, startY, usableWidth) {
    const pageLeftMargin = doc.page.margins.left;
    const colWidths = {
        date: 105,
        start: 65,
        end: 85,
        expected: 75,
        actual: 75,
        diff: usableWidth - 105 - 65 - 85 - 75 - 75
    };
    const colPositions = {
        date: pageLeftMargin,
        start: pageLeftMargin + colWidths.date,
        end: pageLeftMargin + colWidths.date + colWidths.start,
        expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
        actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
        diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
    };

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);
    const headerTextY = startY + V_SPACE.TINY;

    doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
    doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
    doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
    doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
    doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
    doc.text("Mehr/Minder\nStd.(HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });

    const headerBottomY = headerTextY + (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.SMALL;
    doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke();

    return { headerBottomY: headerBottomY + V_SPACE.SMALL, colWidths, colPositions };
}

// *** NEUE Hilfsfunktion: Zeichnet die Seitenzahl ***
function drawPageNumber(doc, pageNum) {
    const pageBottom = doc.page.height - doc.page.margins.bottom + 10; // Position unterhalb des unteren Rands
    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;

    // Aktuelle Einstellungen speichern
    const oldFont = doc._font;
    const oldFontSize = doc._fontSize;
    const oldColor = doc._fillColor;

    // Seitenzahl zeichnen
    doc.fontSize(FONT_SIZE.PAGE_NUMBER)
       .font(FONT_NORMAL)
       .fillColor('black') // Standardfarbe sicherstellen
       .text(`Seite ${pageNum}`, pageLeftMargin, pageBottom, {
           width: usableWidth,
           align: 'center' // Zentrierte Seitenzahl
       });

    // Vorherige Einstellungen wiederherstellen
    doc.font(oldFont)
       .fontSize(oldFontSize)
       .fillColor(oldColor);
}


// Hilfsfunktion: Zeichnet den Footer (NUR Bestätigungstext + Unterschriftsbereich)
function drawSignatureFooter(doc, startY) {
    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;
    let currentY = startY;

    // Prüfen, ob genug Platz, notfalls Seite umbrechen (Sicherheit)
    const neededHeight = doc.heightOfString("Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.", { width: usableWidth })
                         + V_SPACE.SIGNATURE_GAP + V_SPACE.SMALL + FONT_SIZE.FOOTER + V_SPACE.SMALL;
    if (currentY + neededHeight > doc.page.height - doc.page.margins.bottom) {
        console.log(`[PDF Footer] Seitenumbruch nötig nur für Signatur-Footer bei Y=${currentY.toFixed(2)}`);
        doc.addPage(); // Löst keinen pageAdded Event aus, wenn direkt von doc aufgerufen? Doch, sollte.
        currentY = doc.page.margins.top;
        // Seitenzahl wird durch pageAdded Event gezeichnet (oder manuell nach addPage)
    }

    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER);
    doc.text("Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.", pageLeftMargin, currentY, { align: 'left', width: usableWidth });
    currentY += doc.heightOfString("Ich bestätige...", { width: usableWidth }) + V_SPACE.SIGNATURE_GAP; // Abstand zur Linie

    // Unterschriftslinie
    const lineStartX = pageLeftMargin;
    const lineEndX = pageLeftMargin + 200;
    doc.moveTo(lineStartX, currentY).lineTo(lineEndX, currentY).lineWidth(0.5).stroke();
    currentY += V_SPACE.SMALL; // Abstand zum Text unter Linie

    // Text unter Linie
    doc.text("Datum, Unterschrift", pageLeftMargin, currentY);
}

// Middleware: isAdmin (unverändert)
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        console.warn(`isAdmin Check FAILED - Session ID: ${req.sessionID}, isAdmin Flag: ${req.session ? req.session.isAdmin : 'undefined'}, Path: ${req.originalUrl}`);
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
    }
}


//-----------------------------------------------------
// PDF ROUTEN
//-----------------------------------------------------
module.exports = function (db) {

    // +++ TEST ROUTE (unverändert) +++
    router.get('/test', (req, res) => {
        console.log('*************************************');
        console.log('[PDF TEST ROUTE] /api/pdf/test wurde erreicht!');
        console.log('*************************************');
        res.status(200).send('PDF Test Route OK');
    });
    // --- Ende Test-Route ---


    // GET /create-monthly-pdf (Angepasst für Paginierung & Layout)
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        let doc;
        let currentPage = 0; // Seitenzähler
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
                return res.status(400).send("Parameter fehlen oder sind ungültig.");
            }
            const parsedYear = parseInt(year, 10);
            const parsedMonth = parseInt(month, 10);

            console.log(`[PDF Mon V3] Starte Generierung für ${name}, ${parsedMonth}/${parsedYear}`);
            const data = await calculateMonthlyData(db, name, year, month);
            const employeeDataForPdf = data.employeeData;

            doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res); // Pipe so früh wie möglich

            // Event Listener für neue Seiten (zeichnet Seitenzahl)
             doc.on('pageAdded', () => {
                 console.log(`[PDF Mon V3] Event 'pageAdded' ausgelöst, aktuelle Seite: ${currentPage + 1}`);
                 currentPage++; // Seitenzähler erhöhen
                 // Optional: Header auf Folgeseiten?
                 // drawDocumentHeader(doc, ...); // Wenn benötigt
                 drawPageNumber(doc, currentPage); // Seitenzahl auf neuer Seite zeichnen
            });


            // Erste Seite manuell hinzufügen (löst noch keinen 'pageAdded' Event aus)
            doc.addPage();
            currentPage++; // Zähler für erste Seite erhöhen
            console.log(`[PDF Mon V3] Erste Seite (${currentPage}) hinzugefügt.`);
            drawPageNumber(doc, currentPage); // Seitenzahl auf erster Seite zeichnen

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            // Wichtig: Header nach doc.pipe() setzen, aber bevor Daten gesendet werden

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

            // *** Erste Seite: Header und Tabellenkopf ***
            let currentY = drawDocumentHeader(doc,
                `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`,
                data.employeeName,
                new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)),
                new Date(Date.UTC(parsedYear, parsedMonth, 0))
            );
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); // Mehr Zeilenabstand
            doc.y = currentY;

            // Kombinierte und sortierte Liste (unverändert)
            const allDays = [];
            data.workEntries.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDays.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntries.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDays.some(d => d.date === dateStr)) { allDays.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            console.log(`[PDF Mon V3] ${allDays.length} Einträge zu zeichnen.`);

            // *** Schleife zum Zeichnen der Tabellenzeilen ***
            if (allDays.length === 0) {
                doc.text('Keine Buchungen/Abwesenheiten für diesen Monat.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Mon V3] Seitenumbruch vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)}`);
                        const oldCurrentPage = currentPage; // Merken für Log

                        doc.addPage(); // löst 'pageAdded' aus -> Seitenzahl wird gezeichnet
                        // currentPage wird im Event Listener erhöht

                        currentY = doc.page.margins.top;
                        console.log(`[PDF Mon V3] Rufe drawTableHeader auf neuer Seite ${currentPage} auf (vorher: ${oldCurrentPage}).`);
                        tableLayout = drawTableHeader(doc, currentY, usableWidth); // Kopf neu zeichnen
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); // Stil wiederherstellen
                        console.log(`[PDF Mon V3] Tabellenkopf gezeichnet, Y=${doc.y.toFixed(2)}`);
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen (mit rechter Ausrichtung) ---
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = employeeDataForPdf ? getExpectedHours(employeeDataForPdf, dayData.date) : 0;
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--";
                    let endOverride = dayData.endTime || "--:--";
                    let isAbsence = false;
                    if (dayData.type !== 'WORK') {
                        startOverride = '--:--';
                        endOverride = dayData.comment || (dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag'));
                        isAbsence = true;
                    }
                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours);
                    const diffStr = decimalHoursToHHMM(diffHours);

                    const currentRowY = doc.y;
                    const { colPositions, colWidths } = tableLayout;

                    // Optional: Zebra-Streifen (Beispiel)
                    // if (i % 2 !== 0) { // Jede zweite Zeile (ungerader Index)
                    //     doc.rect(colPositions.date, currentRowY, usableWidth, TABLE_ROW_HEIGHT).fill('#f9f9f9');
                    // }

                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'right', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: isAbsence ? 'left' : 'right', lineBreak: false }); // Text links, Zeit rechts
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'right', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'right', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'right', lineBreak: false });

                    doc.y = currentRowY + TABLE_ROW_HEIGHT; // Y-Position manuell erhöhen
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen ***
        // *** Zusammenfassung und Signatur-Footer NUR AM ENDE zeichnen ***
            console.log(`[PDF Mon V3] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary (${SUMMARY_TOTAL_HEIGHT.toFixed(2)}px) + Footer (${FOOTER_TOTAL_HEIGHT.toFixed(2)}px).`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;

            // Prüfen, ob Zusammenfassung UND Footer noch auf die AKTUELLE Seite passen
            if (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF Mon V3] Seitenumbruch vor Summary/Footer bei Y=${doc.y.toFixed(2)}`);
                doc.addPage(); // löst 'pageAdded' aus -> Seitenzahl wird gezeichnet
                // currentPage wird im Event Listener erhöht
                doc.y = doc.page.margins.top; // An den Seitenanfang
            } else {
                 doc.y += V_SPACE.LARGE; // Abstand nach der Tabelle
            }

            // --- Zeichne Zusammenfassung (mit rechter Ausrichtung für Werte) ---
            const summaryStartY = doc.y;
            console.log(`[PDF Mon V3] Zeichne Summary auf Seite ${currentPage} bei Y=${summaryStartY.toFixed(2)}`);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
            const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
            const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
            const summaryLabelX = doc.page.margins.left;
            const summaryValueX = tableLayout.colPositions.actual;
            const summaryLineSpacing = 0.5;

            doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.text("Gesamt Soll-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text("Gesamt Ist-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.font(FONT_NORMAL); doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHours)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHours)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth -10}); doc.moveDown(summaryLineSpacing+0.3); doc.font(FONT_BOLD);
            const totalDiff = (data.totalActual || 0) - (data.totalExpected || 0); doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.font(FONT_BOLD);
            doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

            const summaryEndY = doc.y;
            console.log(`[PDF Mon V3] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);

            // --- Zeichne Signatur-Footer ---
            const footerStartY = summaryEndY + V_SPACE.LARGE;
            console.log(`[PDF Mon V3] Zeichne Signatur-Footer auf Seite ${currentPage} bei Y=${footerStartY.toFixed(2)}`);
            drawSignatureFooter(doc, footerStartY); // NUR Signatur-Teil

            // --- PDF abschließen ---
            console.log("[PDF Mon V3] Finalisiere Dokument.");
            doc.end();

        } catch (err) {
            currentPage = -1; // Fehlerindikator
            console.error("Fehler Erstellen Monats-PDF:", err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler Erstellen Monats-PDF: ${err.message}`);
            } else {
                console.error("Monats-PDF Header bereits gesendet, versuche Stream zu beenden.");
                if (doc && !doc.writableEnded) {
                    doc.end();
                }
            }
        }
    }); // Ende /create-monthly-pdf

    //-----------------------------------------------------

    // GET /create-period-pdf (Angepasst für Paginierung & Layout)
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        let doc;
        let currentPage = 0; // Seitenzähler
         try {
            const { name, year, periodType, periodValue } = req.query;
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 return res.status(400).send("Parameter fehlen oder sind ungültig (Name, Jahr, PeriodType).");
            }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
                 return res.status(400).send("Gültiger periodValue (1-4) für Quartal erforderlich.");
            }
            const parsedYear = parseInt(year, 10);
            const pTypeUpper = periodType.toUpperCase();
            const pValue = periodType === 'QUARTER' ? parseInt(periodValue) : null;

            console.log(`[PDF Per V3] Starte Generierung für ${name}, ${year}, Typ: ${pTypeUpper}, Wert: ${pValue}`);
            const data = await calculatePeriodData(db, name, year, pTypeUpper, pValue);
            const employeeDataForPdf = data.employeeData;

            doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res); // Pipe so früh wie möglich

            // Event Listener für neue Seiten (zeichnet Seitenzahl)
            doc.on('pageAdded', () => {
                 console.log(`[PDF Per V3] Event 'pageAdded' ausgelöst, aktuelle Seite: ${currentPage + 1}`);
                 currentPage++; // Seitenzähler erhöhen
                 // Optional: Header auf Folgeseiten?
                 // drawDocumentHeader(doc, ...); // Wenn benötigt
                 drawPageNumber(doc, currentPage); // Seitenzahl auf neuer Seite zeichnen
            });

            // Erste Seite manuell hinzufügen
            doc.addPage();
            currentPage++;
            console.log(`[PDF Per V3] Erste Seite (${currentPage}) hinzugefügt.`);
            drawPageNumber(doc, currentPage); // Seitenzahl auf erster Seite zeichnen

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (pTypeUpper === 'QUARTER' ? `Q${pValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

            // *** Erste Seite: Header und Tabellenkopf ***
            const title = pTypeUpper === 'QUARTER' ? `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}` : `Jahresnachweis ${parsedYear}`;
            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); // Mehr Zeilenabstand
            doc.y = currentY;

            // Kombinierte und sortierte Liste (Periode)
            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDaysPeriod.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntriesPeriod.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDaysPeriod.some(d => d.date === dateStr)) { allDaysPeriod.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            console.log(`[PDF Per V3] ${allDaysPeriod.length} Einträge zu zeichnen.`);

            // *** Schleife zum Zeichnen der Tabellenzeilen (Periode) ***
            if (allDaysPeriod.length === 0) {
                doc.text('Keine Buchungen/Abwesenheiten für diesen Zeitraum.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Per V3] Seitenumbruch vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)}`);
                         const oldCurrentPage = currentPage;

                        doc.addPage(); // löst 'pageAdded' aus -> Seitenzahl wird gezeichnet
                        // currentPage wird im Event Listener erhöht

                        currentY = doc.page.margins.top;
                        console.log(`[PDF Per V3] Rufe drawTableHeader auf neuer Seite ${currentPage} auf (vorher: ${oldCurrentPage}).`);
                        tableLayout = drawTableHeader(doc, currentY, usableWidth); // Kopf neu zeichnen
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5); // Stil wiederherstellen
                        console.log(`[PDF Per V3] Tabellenkopf gezeichnet, Y=${doc.y.toFixed(2)}`);
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen (mit rechter Ausrichtung) ---
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = employeeDataForPdf ? getExpectedHours(employeeDataForPdf, dayData.date) : 0;
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--";
                    let endOverride = dayData.endTime || "--:--";
                    let isAbsence = false;
                     if (dayData.type !== 'WORK') {
                        startOverride = '--:--';
                        endOverride = dayData.comment || (dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag'));
                        isAbsence = true;
                    }
                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours);
                    const diffStr = decimalHoursToHHMM(diffHours);

                    const currentRowY = doc.y;
                    const { colPositions, colWidths } = tableLayout;

                    // Optional: Zebra-Streifen
                    // if (i % 2 !== 0) {
                    //     doc.rect(colPositions.date, currentRowY, usableWidth, TABLE_ROW_HEIGHT).fill('#f9f9f9');
                    // }

                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'right', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: isAbsence ? 'left' : 'right', lineBreak: false }); // Text links, Zeit rechts
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'right', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'right', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'right', lineBreak: false });

                    doc.y = currentRowY + TABLE_ROW_HEIGHT; // Y-Position manuell erhöhen
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen (Periode) ***


             // *** Zusammenfassung und Signatur-Footer NUR AM ENDE zeichnen (Periode) ***
            console.log(`[PDF Per V3] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary (${SUMMARY_TOTAL_HEIGHT.toFixed(2)}px) + Footer (${FOOTER_TOTAL_HEIGHT.toFixed(2)}px).`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;

            // Prüfen, ob Zusammenfassung UND Footer noch auf die AKTUELLE Seite passen
            if (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF Per V3] Seitenumbruch vor Summary/Footer bei Y=${doc.y.toFixed(2)}`);
                doc.addPage(); // löst 'pageAdded' aus -> Seitenzahl wird gezeichnet
                // currentPage wird im Event Listener erhöht
                doc.y = doc.page.margins.top; // An den Seitenanfang
            } else {
                 doc.y += V_SPACE.LARGE; // Abstand nach der Tabelle
            }

            // --- Zeichne Zusammenfassung (Periode - mit rechter Ausrichtung für Werte) ---
            const summaryStartY = doc.y;
            console.log(`[PDF Per V3] Zeichne Summary auf Seite ${currentPage} bei Y=${summaryStartY.toFixed(2)}`);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
            const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
            const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
            const summaryLabelX = doc.page.margins.left;
            const summaryValueX = tableLayout.colPositions.actual;
            const summaryLineSpacing = 0.5;
            const periodLabelSummary = data.periodIdentifier || pTypeUpper;

            doc.text("Übertrag Periodenbeginn (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.startingBalance || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.text(`Gesamt Soll-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.totalExpectedPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text(`Gesamt Ist-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActualPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.font(FONT_NORMAL); doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHoursPeriod)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHoursPeriod)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth-10}); doc.moveDown(summaryLineSpacing+0.3); doc.font(FONT_BOLD);
            doc.text(`Gesamt Mehr/Minderstunden (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.periodDifference || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.font(FONT_BOLD); doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.endingBalancePeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

            const summaryEndY = doc.y;
            console.log(`[PDF Per V3] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);

            // --- Zeichne Signatur-Footer ---
            const footerStartY = summaryEndY + V_SPACE.LARGE;
            console.log(`[PDF Per V3] Zeichne Signatur-Footer auf Seite ${currentPage} bei Y=${footerStartY.toFixed(2)}`);
            drawSignatureFooter(doc, footerStartY); // NUR Signatur-Teil

            // --- PDF abschließen ---
            console.log("[PDF Per V3] Finalisiere Dokument.");
            doc.end();

        } catch (err) { // Catch-Block für die Route
             currentPage = -1; // Fehlerindikator
            console.error("Fehler Erstellen Perioden-PDF:", err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler Erstellen Perioden-PDF: ${err.message}`);
            } else {
                console.error("Perioden-PDF Header bereits gesendet, versuche Stream zu beenden.");
                if (doc && !doc.writableEnded) {
                    doc.end();
                }
            }
        } // Ende Catch-Block für die Route
    }); // Ende /create-period-pdf


    return router; // Router zurückgeben
}; // Ende module.exports
