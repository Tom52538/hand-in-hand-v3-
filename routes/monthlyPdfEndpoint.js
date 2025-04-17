// monthlyPdfEndpoint.js - V9: Fix für Font-Handling & robuste Fehlerbehandlung
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

// Hilfsfunktion: Zeichnet den Dokumentenkopf (unverändert von V8)
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) {
    console.log(`[PDF DEBUG V9] drawDocumentHeader START für Titel: ${title}`);
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;
    let currentY = doc.page.margins.top; // Startet oben!
    const headerStartY = currentY;
    console.log(`[PDF DEBUG V9] drawDocumentHeader: Start Y = ${currentY.toFixed(2)} (Margin Top)`);

    // Logo
    try {
        console.log(`[PDF DEBUG V9] drawDocumentHeader: Versuche Logo zu laden...`);
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        const logoWidth = 70;
        const logoHeight = 70;
        const logoX = doc.page.width - pageRightMargin - logoWidth;
        doc.image(logoPath, logoX, headerStartY, { width: logoWidth, height: logoHeight });
        console.log(`[PDF DEBUG V9] drawDocumentHeader: Logo rechts oben gezeichnet.`);
    } catch (errLogo) {
        console.warn("[PDF DEBUG V9] Logo Fehler:", errLogo);
    }

    // Titel
    console.log(`[PDF DEBUG V9] drawDocumentHeader: Zeichne Titel...`);
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
    const titleY = headerStartY + V_SPACE.SMALL;
    doc.text(title, pageLeftMargin, titleY, { align: 'center', width: usableWidth });
    currentY = titleY + doc.heightOfString(title, { width: usableWidth, align: 'center' }) + V_SPACE.LARGE;
    console.log(`[PDF DEBUG V9] drawDocumentHeader: Y nach Titel: ${currentY.toFixed(2)}`);

    // Name und Zeitraum
    console.log(`[PDF DEBUG V9] drawDocumentHeader: Zeichne Name/Zeitraum...`);
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
    console.log(`[PDF DEBUG V9] drawDocumentHeader ENDE bei Y=${currentY.toFixed(2)}`);
    return currentY;
}

// Hilfsfunktion: Zeichnet den Tabellenkopf (unverändert von V8)
// !! Wichtig: Überprüfe, ob der Tippfehler "Seite 2" hier noch vorhanden ist !!
function drawTableHeader(doc, startY, usableWidth) {
    console.log(`[PDF DEBUG V9] drawTableHeader START bei Y=${startY.toFixed(2)}`);
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
    console.log(`[PDF DEBUG V9] drawTableHeader ENDE, returniert headerBottomY=${result.headerBottomY.toFixed(2)}`);
    return result;
}

// Hilfsfunktion: Zeichnet die Seitenzahl UNTEN ZENTRIERT (mit Font-Sicherung)
function drawPageNumber(doc, pageNum) {
    console.log(`[PDF DEBUG V9] drawPageNumber START für Seite ${pageNum}`);
    // <<< CHANGE START - V9: Sicherstellen, dass doc.page und margins existieren >>>
    if (!doc || !doc.page || !doc.page.margins) {
        console.error("[PDF DEBUG V9] drawPageNumber: doc.page oder doc.page.margins ist nicht verfügbar!");
        return; // Funktion verlassen, wenn kritische Objekte fehlen
    }
    // <<< CHANGE END >>>

    const pageBottomMargin = doc.page.margins.bottom;
    const pageHeight = doc.page.height;
    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;
    const numberY = pageHeight - pageBottomMargin + V_SPACE.MEDIUM;

    // Speichere den aktuellen Font-Status
    const oldFont = doc._font;
    const oldFontSize = doc._fontSize;
    const oldFillColor = doc._fillColor;
    const oldLineGap = doc._lineGap;

    try {
        console.log(`[PDF DEBUG V9] drawPageNumber: Setze Font auf ${FONT_NORMAL}, Size ${FONT_SIZE.PAGE_NUMBER}`);
        doc.font(FONT_NORMAL)
           .fontSize(FONT_SIZE.PAGE_NUMBER)
           .fillColor('black')
           .lineGap(0)
           .text(`Seite ${pageNum}`, pageLeftMargin, numberY, {
               width: usableWidth,
               align: 'center'
           });
    } catch (fontError) {
        console.error("[PDF DEBUG V9] drawPageNumber: FEHLER beim Setzen des Fonts oder Zeichnen des Texts!", fontError);
        // Nicht versuchen, den Font wiederherzustellen, wenn schon das Setzen fehlschlug
        return;
    }

    // Stelle den vorherigen Font-Status wieder her (nur wenn gültig)
    // <<< CHANGE START - V9: Sichere Font-Wiederherstellung >>>
    try {
        if (oldFont) {
            doc.font(oldFont);
        }
        if (oldFontSize) {
             doc.fontSize(oldFontSize);
        }
        if (oldFillColor) {
            doc.fillColor(oldFillColor);
        }
         // lineGap könnte 0 sein, was gültig ist, daher prüfen wir auf undefined
        if (typeof oldLineGap !== 'undefined') {
            doc.lineGap(oldLineGap);
        }
    } catch (restoreError) {
        console.error("[PDF DEBUG V9] drawPageNumber: FEHLER beim Wiederherstellen des Font-Status!", restoreError);
    }
    // <<< CHANGE END >>>

    console.log(`[PDF DEBUG V9] drawPageNumber ENDE für Seite ${pageNum}`);
}


// Hilfsfunktion: Zeichnet den Footer (NUR Signatur) (mit Font-Sicherung)
function drawSignatureFooter(doc, startY) {
    console.log(`[PDF DEBUG V9] drawSignatureFooter START bei Y=${startY.toFixed(2)}`);
     // <<< CHANGE START - V9: Sicherstellen, dass doc.page und margins existieren >>>
     if (!doc || !doc.page || !doc.page.margins) {
        console.error("[PDF DEBUG V9] drawSignatureFooter: doc.page oder doc.page.margins ist nicht verfügbar!");
        return;
    }
    // <<< CHANGE END >>>

    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;
    let currentY = startY;

    // Speichere Font-Status
    const oldFont = doc._font;
    const oldFontSize = doc._fontSize;
    const oldFillColor = doc._fillColor;
    const oldLineGap = doc._lineGap;

    try {
        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).lineGap(0);
        console.log(`[PDF DEBUG V9] drawSignatureFooter: Zeichne Bestätigungstext...`);
        const confirmationText = "Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.";
        doc.text(confirmationText, pageLeftMargin, currentY, { align: 'left', width: usableWidth });
        currentY += doc.heightOfString(confirmationText, { width: usableWidth }) + V_SPACE.SIGNATURE_GAP;

        const lineStartX = pageLeftMargin;
        const lineEndX = pageLeftMargin + 200;
        console.log(`[PDF DEBUG V9] drawSignatureFooter: Zeichne Unterschriftslinie bei Y=${currentY.toFixed(2)}`);
        doc.moveTo(lineStartX, currentY).lineTo(lineEndX, currentY).lineWidth(0.5).stroke();
        currentY += V_SPACE.SMALL;

        console.log(`[PDF DEBUG V9] drawSignatureFooter: Zeichne 'Datum, Unterschrift'...`);
        doc.text("Datum, Unterschrift", pageLeftMargin, currentY);
        currentY += doc.heightOfString("Datum, Unterschrift");
    } catch(drawError) {
         console.error("[PDF DEBUG V9] drawSignatureFooter: FEHLER beim Zeichnen!", drawError);
         // Nicht versuchen, Font wiederherzustellen, wenn Fehler auftrat
         return;
    }

    // Font wiederherstellen (nur wenn gültig)
    // <<< CHANGE START - V9: Sichere Font-Wiederherstellung >>>
    try {
        if (oldFont) doc.font(oldFont);
        if (oldFontSize) doc.fontSize(oldFontSize);
        if (oldFillColor) doc.fillColor(oldFillColor);
        if (typeof oldLineGap !== 'undefined') doc.lineGap(oldLineGap);
    } catch (restoreError) {
        console.error("[PDF DEBUG V9] drawSignatureFooter: FEHLER beim Wiederherstellen des Font-Status!", restoreError);
    }
    // <<< CHANGE END >>>

    console.log(`[PDF DEBUG V9] drawSignatureFooter ENDE bei Y=${currentY.toFixed(2)}`);
}

// Middleware: isAdmin (unverändert)
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        console.warn(`[ADMIN CHECK FAILED] Session ID: ${req.sessionID}, isAdmin Flag: ${req.session ? req.session.isAdmin : 'undefined'}, Path: ${req.originalUrl}`);
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

    // GET /create-monthly-pdf (V9 - Layout Fix, robuste Fehlerbehandlung)
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        console.log(`[PDF Mon V9 DEBUG] Route /create-monthly-pdf START.`);
        let doc;
        let currentPage = 0;
        // usableWidth wird jetzt im try-Block initialisiert, wenn doc erstellt wird

        try {
            const { name, year, month } = req.query;
            console.log(`[PDF Mon V9 DEBUG] Query Params: name=${name}, year=${year}, month=${month}`);
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
                 console.error("[PDF Mon V9 DEBUG] Ungültige Parameter empfangen.");
                return res.status(400).send("Parameter fehlen oder sind ungültig.");
            }

            const parsedYear = parseInt(year, 10);
            const parsedMonth = parseInt(month, 10);

            console.log(`[PDF Mon V9] Starte Generierung für ${name}, ${parsedMonth}/${parsedYear}`);
            const data = await calculateMonthlyData(db, name, year, month);
            console.log(`[PDF Mon V9 DEBUG] calculateMonthlyData erfolgreich. ${data?.workEntries?.length || 0} Arbeits- und ${data?.absenceEntries?.length || 0} Abwesenheitseinträge gefunden.`);
            const employeeDataForPdf = data.employeeData;

            console.log(`[PDF Mon V9 DEBUG] Erstelle PDFDocument...`);
            doc = new PDFDocument(PAGE_OPTIONS);
            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // usableWidth hier initialisieren
            console.log(`[PDF Mon V9 DEBUG] Pipe PDF zu Response...`);
            doc.pipe(res);

            // Header setzen
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            console.log(`[PDF Mon V9 DEBUG] Setze Header: Content-Type und Content-Disposition (Filename: ${filename})`);
            // Wichtig: Header *vor* dem ersten Senden von Daten (wie addPage) setzen!
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            console.log(`[PDF Mon V9 DEBUG] Usable Width: ${usableWidth.toFixed(2)}`);

            // *** Erste Seite hinzufügen und Kopf/Seitenzahl zeichnen ***
            currentPage++;
            console.log(`[PDF Mon V9 DEBUG] Füge Seite ${currentPage} hinzu (explizit vor Header)...`);
            doc.addPage();
            console.log(`[PDF Mon V9 DEBUG] Seite ${currentPage} hinzugefügt.`);

            // Dokumentenkopf zeichnen
            console.log(`[PDF Mon V9 DEBUG] Zeichne Dokumentenkopf auf Seite ${currentPage}...`);
            let currentY = drawDocumentHeader(doc,
                `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`,
                data.employeeName,
                new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)),
                new Date(Date.UTC(parsedYear, parsedMonth, 0))
            );
            console.log(`[PDF Mon V9 DEBUG] Dokumentenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

            // Seitenzahl zeichnen
            console.log(`[PDF Mon V9 DEBUG] Zeichne Seitenzahl ${currentPage} unten...`);
            drawPageNumber(doc, currentPage);

            // Tabellenkopf zeichnen
            console.log(`[PDF Mon V9 DEBUG] Zeichne Tabellenkopf auf Seite ${currentPage} bei Y=${currentY.toFixed(2)}...`);
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY;
            console.log(`[PDF Mon V9 DEBUG] Tabellenkopf gezeichnet, Y=${currentY.toFixed(2)}`);
            // Font für Tabelleninhalt setzen
            console.log(`[PDF Mon V9 DEBUG] Setze Font für Tabelleninhalt auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
            doc.y = currentY; // Setze die aktuelle Zeichenposition

            // --- Kombinierte und sortierte Liste ---
            const allDays = [];
            data.workEntries.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDays.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntries.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDays.some(d => d.date === dateStr)) { allDays.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));
            console.log(`[PDF Mon V9 DEBUG] ${allDays.length} Einträge zu zeichnen.`);

            // --- Schleife zum Zeichnen der Tabellenzeilen ---
            console.log(`[PDF Mon V9 DEBUG] Starte Schleife zum Zeichnen der Tabellenzeilen bei Y=${doc.y.toFixed(2)}...`);
            if (allDays.length === 0) {
                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT);
                doc.text('Keine Buchungen/Abwesenheiten für diesen Monat.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];
                    console.log(`[PDF Mon V9 DEBUG] --- Schleife Iteration ${i+1}/${allDays.length} für Datum ${dayData.date} ---`);

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    const estimatedLineHeight = TABLE_ROW_HEIGHT;
                    if (doc.y + estimatedLineHeight > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Mon V9 DEBUG] >>> Seitenumbruch NÖTIG vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)} <<<`);
                        doc.addPage();
                        currentPage++;
                        console.log(`[PDF Mon V9 DEBUG] Seite ${currentPage} manuell hinzugefügt.`);
                        drawPageNumber(doc, currentPage); // Seitenzahl unten

                        // Tabellenkopf auf neuer Seite zeichnen
                        currentY = doc.page.margins.top;
                        console.log(`[PDF Mon V9 DEBUG] Rufe drawTableHeader auf Seite ${currentPage} auf bei Y=${currentY.toFixed(2)}.`);
                        tableLayout = drawTableHeader(doc, currentY, usableWidth);
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY;

                        // Font für Tabelleninhalt auf neuer Seite setzen!
                        console.log(`[PDF Mon V9 DEBUG] Setze Font für Tabelleninhalt auf neuer Seite auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
                        console.log(`[PDF Mon V9 DEBUG] Tabellenkopf auf neuer Seite gezeichnet, weiter bei Y=${doc.y.toFixed(2)}`);
                    } else {
                         // Kein Seitenumbruch nötig.
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen ---
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT); // Font sicherheitshalber setzen
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
                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'right', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: isAbsence ? 'left' : 'right', lineBreak: false });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'right', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'right', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'right', lineBreak: false });

                    doc.y = currentRowY + TABLE_ROW_HEIGHT;
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen ***

            // *** Zusammenfassung und Signatur-Footer ***
            console.log(`[PDF Mon V9 DEBUG] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary/Footer.`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;

            // Prüfen auf Seitenumbruch vor Summary/Footer (Logik aus V8)
            const isAtTopOfPageSummary = Math.abs(doc.y - doc.page.margins.top) < 1;
            if (!isAtTopOfPageSummary && (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom)) {
                console.log(`[PDF Mon V9 DEBUG] >>> Seitenumbruch NÖTIG vor Summary/Footer bei Y=${doc.y.toFixed(2)} <<<`);
                doc.addPage();
                currentPage++;
                console.log(`[PDF Mon V9 DEBUG] Seite ${currentPage} manuell für Summary/Footer hinzugefügt.`);
                drawPageNumber(doc, currentPage);
                doc.y = doc.page.margins.top;
            } else if (isAtTopOfPageSummary) {
                console.log(`[PDF Mon V9 DEBUG] Kein Seitenumbruch vor Summary/Footer nötig (bereits oben).`);
            } else {
                 console.log(`[PDF Mon V9 DEBUG] Kein Seitenumbruch vor Summary/Footer nötig (genug Platz).`);
                 doc.y += V_SPACE.LARGE;
            }

            // --- Zeichne Zusammenfassung ---
            const summaryStartY = doc.y;
            console.log(`[PDF Mon V9 DEBUG] Zeichne Summary auf Seite ${currentPage} bei Y=${summaryStartY.toFixed(2)}`);
            // Font-Status speichern/wiederherstellen für Summary
            const oldFontSum = doc._font;
            const oldFontSizeSum = doc._fontSize;
            const oldFillColorSum = doc._fillColor;
            const oldLineGapSum = doc._lineGap;

            try {
                doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).lineGap(0);
                const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
                const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
                const summaryLabelX = doc.page.margins.left;
                const summaryValueX = tableLayout.colPositions.actual;
                const summaryLineSpacing = 0.5;

                doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(data.previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
                doc.moveDown(summaryLineSpacing);
                doc.text("Gesamt Soll-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(data.totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
                doc.moveDown(summaryLineSpacing);
                doc.text("Gesamt Ist-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(data.totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
                doc.moveDown(summaryLineSpacing);

                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY); // Font für Detailzeile
                doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHours)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHours)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth -10});
                doc.moveDown(summaryLineSpacing+0.3);
                doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY); // Font wieder auf BOLD

                const totalDiff = (data.totalActual || 0) - (data.totalExpected || 0);
                doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
                doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(data.newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

                const summaryEndY = doc.y + doc.heightOfString("Neuer Übertrag...", {width: summaryLabelWidth});
                console.log(`[PDF Mon V9 DEBUG] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);
                doc.y = summaryEndY;
            } catch (summaryError) {
                 console.error("[PDF Mon V9 DEBUG] FEHLER beim Zeichnen der Summary!", summaryError);
                 // Fehler aufgetreten, Font-Wiederherstellung überspringen oder spezifisch handhaben
                 throw summaryError; // Fehler weitergeben, um den Catch-Block auszulösen
            } finally {
                 // Font-Status nach Summary wiederherstellen (nur wenn gültig)
                 // <<< CHANGE START - V9: Sichere Font-Wiederherstellung >>>
                 try {
                     if (oldFontSum) doc.font(oldFontSum);
                     if (oldFontSizeSum) doc.fontSize(oldFontSizeSum);
                     if (oldFillColorSum) doc.fillColor(oldFillColorSum);
                     if (typeof oldLineGapSum !== 'undefined') doc.lineGap(oldLineGapSum);
                 } catch (restoreError) {
                     console.error("[PDF Mon V9 DEBUG] Summary: FEHLER beim Wiederherstellen des Font-Status!", restoreError);
                 }
                 // <<< CHANGE END >>>
            }

            // --- Zeichne Signatur-Footer ---
            const footerStartY = doc.y + V_SPACE.LARGE;
            console.log(`[PDF Mon V9 DEBUG] Zeichne Signatur-Footer auf Seite ${currentPage} bei Y=${footerStartY.toFixed(2)}`);
            drawSignatureFooter(doc, footerStartY); // Beinhaltet Font-Sicherung

            // --- PDF abschließen ---
            console.log("[PDF Mon V9 DEBUG] Finalisiere Dokument (rufe doc.end() auf)...");
            doc.end();
            console.log("[PDF Mon V9 DEBUG] doc.end() aufgerufen. Warten auf Stream-Ende.");

        } catch (err) {
             // *** Fehlerbehandlung (V9 - Robuster) ***
            console.error("[PDF Mon V9 DEBUG] !!!!! CATCH BLOCK REACHED (MONTHLY) !!!!!");
            console.error("Fehler Erstellen Monats-PDF V9:", err.message, err.stack);

            // <<< CHANGE START - V9: Robuste Fehlerbehandlung >>>
            // Versuche NICHT mehr, ein Fehler-PDF zu generieren, wenn der Stream schon gestartet wurde oder Header gesendet wurden.
            // Sende stattdessen einen klaren Fehlerstatus, wenn möglich.
            if (!res.headersSent) {
                 console.error("[PDF Mon V9 DEBUG] Catch-Block: Header noch nicht gesendet. Sende 500er Status.");
                 // Sicherstellen, dass der Stream beendet wird, falls er existiert und beschreibbar ist
                 if (doc && doc.writable && !doc.writableEnded) {
                     console.error("[PDF Mon V9 DEBUG] Catch-Block: Beende Stream vor dem Senden des Fehlers.");
                     doc.end(); // Stream schließen
                 }
                 res.status(500).send(`Interner Serverfehler beim Erstellen des Monats-PDF: ${err.message}`);
            } else {
                 console.error("[PDF Mon V9 DEBUG] Catch-Block: Header bereits gesendet. Beende Stream, falls möglich, aber sende keinen Statuscode mehr.");
                 if (doc && doc.writable && !doc.writableEnded) {
                     console.error("[PDF Mon V9 DEBUG] Catch-Block: Beende Stream.");
                     doc.end(); // Stream schließen
                 }
                 // Hier kann kein res.status() mehr gesendet werden. Der Client erhält ein unvollständiges/fehlerhaftes PDF.
            }
            // <<< CHANGE END >>>
        }
    }); // Ende /create-monthly-pdf
    //-----------------------------------------------------

     // GET /create-period-pdf (V9 - Layout Fix, robuste Fehlerbehandlung)
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        console.log(`[PDF Per V9 DEBUG] Route /create-period-pdf START.`);
        let doc;
        let currentPage = 0;
        // usableWidth wird jetzt im try-Block initialisiert

         try {
            const { name, year, periodType, periodValue } = req.query;
            console.log(`[PDF Per V9 DEBUG] Query Params: name=${name}, year=${year}, periodType=${periodType}, periodValue=${periodValue}`);
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                return res.status(400).send("Parameter fehlen oder sind ungültig (Name, Jahr, PeriodType).");
            }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
                 return res.status(400).send("Gültiger periodValue (1-4) für Quartal erforderlich.");
            }

            const parsedYear = parseInt(year, 10);
            const pTypeUpper = periodType.toUpperCase();
            const pValue = pTypeUpper === 'QUARTER' ? parseInt(periodValue) : null;

            console.log(`[PDF Per V9] Starte Generierung für ${name}, ${year}, Typ: ${pTypeUpper}, Wert: ${pValue}`);
            const data = await calculatePeriodData(db, name, year, pTypeUpper, pValue);
            console.log(`[PDF Per V9 DEBUG] calculatePeriodData erfolgreich. ${data?.workEntriesPeriod?.length || 0} Arbeits- und ${data?.absenceEntriesPeriod?.length || 0} Abwesenheitseinträge gefunden.`);
            const employeeDataForPdf = data.employeeData;

            console.log(`[PDF Per V9 DEBUG] Erstelle PDFDocument...`);
            doc = new PDFDocument(PAGE_OPTIONS);
            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // usableWidth hier initialisieren
            console.log(`[PDF Per V9 DEBUG] Pipe PDF zu Response...`);
            doc.pipe(res);

            // Header setzen
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (pTypeUpper === 'QUARTER' ? `Q${pValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            console.log(`[PDF Per V9 DEBUG] Setze Header: Content-Type und Content-Disposition (Filename: ${filename})`);
            // Wichtig: Header *vor* dem ersten Senden von Daten (wie addPage) setzen!
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            console.log(`[PDF Per V9 DEBUG] Usable Width: ${usableWidth.toFixed(2)}`);

             // *** Erste Seite hinzufügen und Kopf/Seitenzahl zeichnen ***
            currentPage++;
            console.log(`[PDF Per V9 DEBUG] Füge Seite ${currentPage} hinzu (explizit vor Header)...`);
            doc.addPage();
            console.log(`[PDF Per V9 DEBUG] Seite ${currentPage} hinzugefügt.`);

            // Dokumentenkopf zeichnen
            const title = pTypeUpper === 'QUARTER' ? `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}` : `Jahresnachweis ${parsedYear}`;
            console.log(`[PDF Per V9 DEBUG] Zeichne Dokumentenkopf auf Seite ${currentPage} mit Titel: ${title}...`);
            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);
            console.log(`[PDF Per V9 DEBUG] Dokumentenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

            // Seitenzahl zeichnen
            console.log(`[PDF Per V9 DEBUG] Zeichne Seitenzahl ${currentPage} unten...`);
            drawPageNumber(doc, currentPage);

            // Tabellenkopf zeichnen
            console.log(`[PDF Per V9 DEBUG] Zeichne Tabellenkopf auf Seite ${currentPage} bei Y=${currentY.toFixed(2)}...`);
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY;
            console.log(`[PDF Per V9 DEBUG] Tabellenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

            // Font für Tabelleninhalt setzen
            console.log(`[PDF Per V9 DEBUG] Setze Font für Tabelleninhalt auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
            doc.y = currentY;

            // --- Kombinierte und sortierte Liste (Periode) ---
            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDaysPeriod.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntriesPeriod.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDaysPeriod.some(d => d.date === dateStr)) { allDaysPeriod.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));
            console.log(`[PDF Per V9 DEBUG] ${allDaysPeriod.length} Einträge zu zeichnen.`);

            // --- Schleife zum Zeichnen der Tabellenzeilen (Periode) ---
            console.log(`[PDF Per V9 DEBUG] Starte Schleife zum Zeichnen der Tabellenzeilen bei Y=${doc.y.toFixed(2)}...`);
            if (allDaysPeriod.length === 0) {
                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT);
                doc.text('Keine Buchungen/Abwesenheiten für diesen Zeitraum.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];
                    console.log(`[PDF Per V9 DEBUG] --- Schleife Iteration ${i+1}/${allDaysPeriod.length} für Datum ${dayData.date} ---`);

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    const estimatedLineHeight = TABLE_ROW_HEIGHT;
                    if (doc.y + estimatedLineHeight > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Per V9 DEBUG] >>> Seitenumbruch NÖTIG vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)} <<<`);
                        doc.addPage();
                        currentPage++;
                        console.log(`[PDF Per V9 DEBUG] Seite ${currentPage} manuell hinzugefügt.`);
                        drawPageNumber(doc, currentPage); // Seitenzahl unten

                        // Tabellenkopf auf neuer Seite zeichnen
                        currentY = doc.page.margins.top;
                        console.log(`[PDF Per V9 DEBUG] Rufe drawTableHeader auf Seite ${currentPage} auf bei Y=${currentY.toFixed(2)}.`);
                        tableLayout = drawTableHeader(doc, currentY, usableWidth);
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY;

                        // Font für Tabelleninhalt auf neuer Seite setzen!
                        console.log(`[PDF Per V9 DEBUG] Setze Font für Tabelleninhalt auf neuer Seite auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
                        console.log(`[PDF Per V9 DEBUG] Tabellenkopf auf neuer Seite gezeichnet, weiter bei Y=${doc.y.toFixed(2)}`);
                    } else {
                         // Kein Seitenumbruch nötig.
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen ---
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT); // Font sicherheitshalber setzen
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
                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'right', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: isAbsence ? 'left' : 'right', lineBreak: false });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'right', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'right', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'right', lineBreak: false });

                    doc.y = currentRowY + TABLE_ROW_HEIGHT;
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen (Periode) ***

             // *** Zusammenfassung und Signatur-Footer ***
            console.log(`[PDF Per V9 DEBUG] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary/Footer.`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;

             // Prüfen auf Seitenumbruch vor Summary/Footer (Logik aus V8)
            const isAtTopOfPageSummaryPeriod = Math.abs(doc.y - doc.page.margins.top) < 1;
            if (!isAtTopOfPageSummaryPeriod && (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom)) {
                 console.log(`[PDF Per V9 DEBUG] >>> Seitenumbruch NÖTIG vor Summary/Footer bei Y=${doc.y.toFixed(2)} <<<`);
                 doc.addPage();
                 currentPage++;
                 console.log(`[PDF Per V9 DEBUG] Seite ${currentPage} manuell für Summary/Footer hinzugefügt.`);
                 drawPageNumber(doc, currentPage);
                 doc.y = doc.page.margins.top;
            } else if (isAtTopOfPageSummaryPeriod) {
                 console.log(`[PDF Per V9 DEBUG] Kein Seitenumbruch vor Summary/Footer nötig (bereits oben).`);
            } else {
                 console.log(`[PDF Per V9 DEBUG] Kein Seitenumbruch vor Summary/Footer nötig (genug Platz).`);
                 doc.y += V_SPACE.LARGE;
            }
             // --- Zeichne Zusammenfassung (Periode) ---
            const summaryStartY = doc.y;
            console.log(`[PDF Per V9 DEBUG] Zeichne Summary auf Seite ${currentPage} bei Y=${summaryStartY.toFixed(2)}`);
            // Font-Status speichern/wiederherstellen für Summary
            const oldFontSumP = doc._font;
            const oldFontSizeSumP = doc._fontSize;
            const oldFillColorSumP = doc._fillColor;
            const oldLineGapSumP = doc._lineGap;

            try {
                doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).lineGap(0);
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

                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY); // Font für Detailzeile
                doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHoursPeriod)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHoursPeriod)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth-10});
                doc.moveDown(summaryLineSpacing+0.3);
                doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY); // Font wieder auf BOLD

                doc.text(`Gesamt Mehr/Minderstunden (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(data.periodDifference || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
                doc.moveDown(summaryLineSpacing);
                doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth });
                doc.text(decimalHoursToHHMM(data.endingBalancePeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

                const summaryEndY = doc.y + doc.heightOfString("Neuer Übertrag...", {width: summaryLabelWidth});
                console.log(`[PDF Per V9 DEBUG] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);
                doc.y = summaryEndY;
            } catch (summaryError) {
                console.error("[PDF Per V9 DEBUG] FEHLER beim Zeichnen der Summary!", summaryError);
                throw summaryError; // Fehler weitergeben
            } finally {
                // Font-Status nach Summary wiederherstellen (nur wenn gültig)
                // <<< CHANGE START - V9: Sichere Font-Wiederherstellung >>>
                try {
                    if (oldFontSumP) doc.font(oldFontSumP);
                    if (oldFontSizeSumP) doc.fontSize(oldFontSizeSumP);
                    if (oldFillColorSumP) doc.fillColor(oldFillColorSumP);
                    if (typeof oldLineGapSumP !== 'undefined') doc.lineGap(oldLineGapSumP);
                } catch (restoreError) {
                     console.error("[PDF Per V9 DEBUG] Summary: FEHLER beim Wiederherstellen des Font-Status!", restoreError);
                }
                // <<< CHANGE END >>>
            }

            // --- Zeichne Signatur-Footer ---
            const footerStartY = doc.y + V_SPACE.LARGE;
            console.log(`[PDF Per V9 DEBUG] Zeichne Signatur-Footer auf Seite ${currentPage} bei Y=${footerStartY.toFixed(2)}`);
            drawSignatureFooter(doc, footerStartY); // Beinhaltet Font-Sicherung

            // --- PDF abschließen ---
            console.log("[PDF Per V9 DEBUG] Finalisiere Dokument (rufe doc.end() auf)...");
            doc.end();
            console.log("[PDF Per V9 DEBUG] doc.end() aufgerufen. Warten auf Stream-Ende.");

        } catch (err) {
             // *** Fehlerbehandlung (V9 - Robuster) ***
            console.error("[PDF Per V9 DEBUG] !!!!! CATCH BLOCK REACHED (PERIOD) !!!!!");
            console.error("Fehler Erstellen Perioden-PDF V9:", err.message, err.stack);

             // <<< CHANGE START - V9: Robuste Fehlerbehandlung >>>
            if (!res.headersSent) {
                 console.error("[PDF Per V9 DEBUG] Catch-Block: Header noch nicht gesendet. Sende 500er Status.");
                 if (doc && doc.writable && !doc.writableEnded) {
                     console.error("[PDF Per V9 DEBUG] Catch-Block: Beende Stream vor dem Senden des Fehlers.");
                     doc.end();
                 }
                 res.status(500).send(`Interner Serverfehler beim Erstellen des Perioden-PDF: ${err.message}`);
            } else {
                 console.error("[PDF Per V9 DEBUG] Catch-Block: Header bereits gesendet. Beende Stream, falls möglich, aber sende keinen Statuscode mehr.");
                 if (doc && doc.writable && !doc.writableEnded) {
                     console.error("[PDF Per V9 DEBUG] Catch-Block: Beende Stream.");
                     doc.end();
                 }
            }
             // <<< CHANGE END >>>
        } // Ende Catch-Block für die Route
    }); // Ende /create-period-pdf


    return router; // Router zurückgeben
}; // Ende module.exports
