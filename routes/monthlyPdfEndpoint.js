// monthlyPdfEndpoint.js - V7: Fix für Layout (leere erste Seite, Header-Position)
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

// Hilfsfunktion: Zeichnet den Dokumentenkopf (mit Debug Log)
// Setzt intern die benötigten Fonts und gibt die Y-Position *nach* dem Header zurück.
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) {
    console.log(`[PDF DEBUG V7] drawDocumentHeader START für Titel: ${title}`);
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;
    let currentY = doc.page.margins.top; // Startet oben!
    const headerStartY = currentY;
    console.log(`[PDF DEBUG V7] drawDocumentHeader: Start Y = ${currentY.toFixed(2)} (Margin Top)`);

    // Logo (mit Debug Log)
    try {
        console.log(`[PDF DEBUG V7] drawDocumentHeader: Versuche Logo zu laden...`);
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        const logoWidth = 70;
        const logoHeight = 70;
        const logoX = doc.page.width - pageRightMargin - logoWidth;
        // Zeichne Logo *rechts oben*
        doc.image(logoPath, logoX, headerStartY, { width: logoWidth, height: logoHeight });
        console.log(`[PDF DEBUG V7] drawDocumentHeader: Logo rechts oben gezeichnet.`);
        // Y Position für Text unter dem Logo / neben dem Titel? Vorerst Y für Titel beibehalten
        // currentY += logoHeight + V_SPACE.SMALL; // Nicht erhöhen, Text beginnt links
    } catch (errLogo) {
        console.warn("[PDF DEBUG V7] Logo Fehler:", errLogo);
        // Kein Y-Inkrement bei Fehler
    }

    // Titel (zentriert, etwas unterhalb des oberen Rands)
    console.log(`[PDF DEBUG V7] drawDocumentHeader: Zeichne Titel...`);
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
    const titleY = headerStartY + V_SPACE.SMALL; // Kleiner Abstand von oben
    doc.text(title, pageLeftMargin, titleY, { align: 'center', width: usableWidth });
    // Y-Position nach dem Titel (Titelhöhe + Abstand)
    currentY = titleY + doc.heightOfString(title, { width: usableWidth, align: 'center' }) + V_SPACE.LARGE;
    console.log(`[PDF DEBUG V7] drawDocumentHeader: Y nach Titel: ${currentY.toFixed(2)}`);


    // Name und Zeitraum (linksbündig, unterhalb des Titels)
    console.log(`[PDF DEBUG V7] drawDocumentHeader: Zeichne Name/Zeitraum...`);
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL; // Abstand nach Name
    doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE; // Größerer Abstand nach dem gesamten Header
    console.log(`[PDF DEBUG V7] drawDocumentHeader ENDE bei Y=${currentY.toFixed(2)}`);
    return currentY; // Gibt die Y-Position zurück, wo der nächste Inhalt starten soll
}

// Hilfsfunktion: Zeichnet den Tabellenkopf (mit Debug Log)
// Setzt intern die benötigten Fonts und gibt die Y-Position *nach* dem Header + Linie zurück.
function drawTableHeader(doc, startY, usableWidth) {
    console.log(`[PDF DEBUG V7] drawTableHeader START bei Y=${startY.toFixed(2)}`);
    const pageLeftMargin = doc.page.margins.left;
    const colWidths = {
        date: 105,
        start: 65,
        end: 85,
        expected: 75,
        actual: 75,
        diff: usableWidth - 105 - 65 - 85 - 75 - 75 // Restbreite
    };
    // Sicherstellen, dass diff nicht negativ wird (falls usableWidth zu klein)
    if (colWidths.diff < 30) colWidths.diff = 30; // Mindestbreite

    const colPositions = {
        date: pageLeftMargin,
        start: pageLeftMargin + colWidths.date,
        end: pageLeftMargin + colWidths.date + colWidths.start,
        expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
        actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
        diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
    };

    // Font für Header setzen
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);
    const headerTextY = startY + V_SPACE.TINY; // Kleiner Abstand nach oben

    // Texte zeichnen
    doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
    doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
    doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
    doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
    doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
    doc.text("Mehr/Minder\nStd.(HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });

    // Höhe des Headers berechnen (ca. 2 Zeilen Text + Abstand)
    const headerHeight = (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.TINY + V_SPACE.SMALL;
    const headerBottomY = startY + headerHeight;

    // Linie unter dem Header
    doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke();

    const result = { headerBottomY: headerBottomY + V_SPACE.SMALL, colWidths, colPositions }; // Nächster Startpunkt mit kleinem Abstand
    console.log(`[PDF DEBUG V7] drawTableHeader ENDE, returniert headerBottomY=${result.headerBottomY.toFixed(2)}`);
    return result;
}

// Hilfsfunktion: Zeichnet die Seitenzahl (Vereinfacht V6/V7)
// Setzt intern Font und Größe, *ändert* den globalen Font-Status.
function drawPageNumber(doc, pageNum) {
    console.log(`[PDF DEBUG V7] drawPageNumber START für Seite ${pageNum}`);
    const pageBottom = doc.page.height - doc.page.margins.bottom + 10; // Etwas unterhalb des unteren Rands
    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;

    // Font explizit setzen
    console.log(`[PDF DEBUG V7] drawPageNumber: Setze Font auf ${FONT_NORMAL}, Size ${FONT_SIZE.PAGE_NUMBER}`);
    doc.font(FONT_NORMAL)
       .fontSize(FONT_SIZE.PAGE_NUMBER)
       .fillColor('black') // Sicherstellen, dass die Farbe stimmt
       .text(`Seite ${pageNum}`, pageLeftMargin, pageBottom, {
           width: usableWidth,
           align: 'center'
       });

    console.log(`[PDF DEBUG V7] drawPageNumber ENDE für Seite ${pageNum}`);
    // Font-Status wurde geändert! Aufrufer muss ggf. zurücksetzen.
}


// Hilfsfunktion: Zeichnet den Footer (NUR Signatur)
// Setzt intern Font und Größe.
function drawSignatureFooter(doc, startY) {
    console.log(`[PDF DEBUG V7] drawSignatureFooter START bei Y=${startY.toFixed(2)}`);
    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;
    let currentY = startY;

    // Font für Footer setzen
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER);
    console.log(`[PDF DEBUG V7] drawSignatureFooter: Zeichne Bestätigungstext... (Font: ${doc._font?.name}, Size: ${doc._fontSize})`);
    const confirmationText = "Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.";
    doc.text(confirmationText, pageLeftMargin, currentY, { align: 'left', width: usableWidth });
    currentY += doc.heightOfString(confirmationText, { width: usableWidth }) + V_SPACE.SIGNATURE_GAP; // Größerer Abstand für Unterschrift

    const lineStartX = pageLeftMargin;
    const lineEndX = pageLeftMargin + 200; // Länge der Linie
    console.log(`[PDF DEBUG V7] drawSignatureFooter: Zeichne Unterschriftslinie bei Y=${currentY.toFixed(2)}`);
    doc.moveTo(lineStartX, currentY).lineTo(lineEndX, currentY).lineWidth(0.5).stroke();
    currentY += V_SPACE.SMALL; // Kleiner Abstand unter der Linie

    console.log(`[PDF DEBUG V7] drawSignatureFooter: Zeichne 'Datum, Unterschrift'...`);
    doc.text("Datum, Unterschrift", pageLeftMargin, currentY);
    currentY += doc.heightOfString("Datum, Unterschrift") // Höhe der Zeile addieren
    console.log(`[PDF DEBUG V7] drawSignatureFooter ENDE bei Y=${currentY.toFixed(2)}`);
    // Beachte: currentY ist hier die Position *nach* dem Text "Datum, Unterschrift"
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
    // --- Ende Test-Route ---


    // GET /create-monthly-pdf (V7 - Layout Fix)
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        console.log(`[PDF Mon V7 DEBUG] Route /create-monthly-pdf START.`);
        let doc;
        let currentPage = 0;
        try {
            const { name, year, month } = req.query;
            console.log(`[PDF Mon V7 DEBUG] Query Params: name=${name}, year=${year}, month=${month}`);
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
                 console.error("[PDF Mon V7 DEBUG] Ungültige Parameter empfangen.");
                return res.status(400).send("Parameter fehlen oder sind ungültig.");
            }
            const parsedYear = parseInt(year, 10);
            const parsedMonth = parseInt(month, 10);

            console.log(`[PDF Mon V7] Starte Generierung für ${name}, ${parsedMonth}/${parsedYear}`);
            console.log(`[PDF Mon V7 DEBUG] Rufe calculateMonthlyData auf...`);
            const data = await calculateMonthlyData(db, name, year, month);
            console.log(`[PDF Mon V7 DEBUG] calculateMonthlyData erfolgreich. ${data?.workEntries?.length || 0} Arbeits- und ${data?.absenceEntries?.length || 0} Abwesenheitseinträge gefunden.`);
            const employeeDataForPdf = data.employeeData;

            console.log(`[PDF Mon V7 DEBUG] Erstelle PDFDocument...`);
            doc = new PDFDocument(PAGE_OPTIONS);
            console.log(`[PDF Mon V7 DEBUG] Pipe PDF zu Response...`);
            doc.pipe(res);

            // --- Erste Seite ---
            console.log(`[PDF Mon V7 DEBUG] Füge erste Seite hinzu...`);
            doc.addPage(); // Fügt Seite 1 hinzu
            currentPage++;
            console.log(`[PDF Mon V7 DEBUG] Erste Seite (${currentPage}) hinzugefügt.`);
            drawPageNumber(doc, currentPage); // Zeichnet "Seite 1" unten auf Seite 1

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            console.log(`[PDF Mon V7 DEBUG] Setze Header: Content-Type und Content-Disposition (Filename: ${filename})`);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            console.log(`[PDF Mon V7 DEBUG] Usable Width: ${usableWidth.toFixed(2)}`);

            // Dokumentenkopf zeichnen (startet bei doc.page.margins.top)
            console.log(`[PDF Mon V7 DEBUG] Zeichne Dokumentenkopf auf Seite ${currentPage}...`);
            let currentY = drawDocumentHeader(doc,
                `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`,
                data.employeeName,
                new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)),
                new Date(Date.UTC(parsedYear, parsedMonth, 0))
            );
            console.log(`[PDF Mon V7 DEBUG] Dokumentenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

            // Tabellenkopf zeichnen (startet bei currentY, den drawDocumentHeader zurückgegeben hat)
            console.log(`[PDF Mon V7 DEBUG] Zeichne Tabellenkopf auf Seite ${currentPage} bei Y=${currentY.toFixed(2)}...`);
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY; // Y-Position nach dem Tabellenkopf
            console.log(`[PDF Mon V7 DEBUG] Tabellenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

            // Font für Tabelleninhalt setzen (wichtig!)
            console.log(`[PDF Mon V7 DEBUG] Setze Font für Tabelleninhalt auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
            doc.y = currentY; // Setze die aktuelle Zeichenposition

            // --- Kombinierte und sortierte Liste ---
            console.log(`[PDF Mon V7 DEBUG] Bereite kombinierte Tagesliste vor...`);
            const allDays = [];
            // ... (Rest der Datenaufbereitung bleibt gleich)
            data.workEntries.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDays.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntries.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDays.some(d => d.date === dateStr)) { allDays.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));
            console.log(`[PDF Mon V7 DEBUG] ${allDays.length} Einträge zu zeichnen.`);

            // --- Schleife zum Zeichnen der Tabellenzeilen ---
            console.log(`[PDF Mon V7 DEBUG] Starte Schleife zum Zeichnen der Tabellenzeilen bei Y=${doc.y.toFixed(2)}...`);
            if (allDays.length === 0) {
                console.log(`[PDF Mon V7 DEBUG] Keine Einträge vorhanden, zeichne Platzhaltertext.`);
                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT); // Font sicherheitshalber setzen
                doc.text('Keine Buchungen/Abwesenheiten für diesen Monat.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];
                    console.log(`[PDF Mon V7 DEBUG] --- Schleife Iteration ${i+1}/${allDays.length} für Datum ${dayData.date} ---`);
                    console.log(`[PDF Mon V7 DEBUG] Aktuelle Position Y=${doc.y.toFixed(2)}, Seitenhöhe=${doc.page.height}, Unterer Rand=${doc.page.margins.bottom}`);

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    const estimatedLineHeight = TABLE_ROW_HEIGHT; // Einfache Annahme
                    console.log(`[PDF Mon V7 DEBUG] Prüfe Seitenumbruch: Y (${doc.y.toFixed(2)}) + RowHeight (${estimatedLineHeight}) > Limit (${(doc.page.height - doc.page.margins.bottom).toFixed(2)})?`);
                    if (doc.y + estimatedLineHeight > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Mon V7 DEBUG] >>> Seitenumbruch NÖTIG vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)} <<<`);
                        console.log(`[PDF Mon V7 DEBUG] Füge neue Seite hinzu...`);
                        doc.addPage(); // Fügt Seite (currentPage + 1) hinzu
                        currentPage++;
                        console.log(`[PDF Mon V7 DEBUG] Seite ${currentPage} manuell hinzugefügt.`);
                        drawPageNumber(doc, currentPage); // Zeichnet Seitenzahl unten

                        // Tabellenkopf auf neuer Seite zeichnen
                        currentY = doc.page.margins.top; // Startet oben auf der neuen Seite
                        console.log(`[PDF Mon V7 DEBUG] Rufe drawTableHeader auf Seite ${currentPage} auf bei Y=${currentY.toFixed(2)}.`);
                        tableLayout = drawTableHeader(doc, currentY, usableWidth); // Zeichnet Header, gibt Y danach zurück
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY; // Setzt aktuelle Zeichenposition

                        // Font für Tabelleninhalt auf neuer Seite setzen!
                        console.log(`[PDF Mon V7 DEBUG] Setze Font für Tabelleninhalt auf neuer Seite auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
                        console.log(`[PDF Mon V7 DEBUG] Tabellenkopf auf neuer Seite gezeichnet, weiter bei Y=${doc.y.toFixed(2)}`);
                    } else {
                         console.log(`[PDF Mon V7 DEBUG] Kein Seitenumbruch nötig.`);
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen ---
                    // Sicherstellen, dass der Font für den Tabelleninhalt korrekt ist
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT);
                    console.log(`[PDF Mon V7 DEBUG] Zeichne Zeile ${i+1} für Datum ${dayData.date} bei Y=${doc.y.toFixed(2)} (Font: ${doc._font?.name}, Size: ${doc._fontSize})...`);

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

                    doc.y = currentRowY + TABLE_ROW_HEIGHT; // Y-Position für nächste Zeile erhöhen
                    console.log(`[PDF Mon V7 DEBUG] Zeile ${i+1} gezeichnet. Neue Position Y=${doc.y.toFixed(2)}`);
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
                console.log(`[PDF Mon V7 DEBUG] Schleife für Tabellenzeilen beendet.`);
            }
            // *** Ende Schleife für Tabellenzeilen ***

            // *** Zusammenfassung und Signatur-Footer ***
            console.log(`[PDF Mon V7 DEBUG] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary (${SUMMARY_TOTAL_HEIGHT.toFixed(2)}px) + Footer (${FOOTER_TOTAL_HEIGHT.toFixed(2)}px).`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE; // Extra Platz
            console.log(`[PDF Mon V7 DEBUG] Platz benötigt: ${spaceNeededForSummaryAndFooter.toFixed(2)}. Verfügbar bis ${(doc.page.height - doc.page.margins.bottom).toFixed(2)}.`);

            // Prüfen, ob Zusammenfassung UND Footer noch auf die AKTUELLE Seite passen
            if (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF Mon V7 DEBUG] >>> Seitenumbruch NÖTIG vor Summary/Footer bei Y=${doc.y.toFixed(2)} <<<`);
                console.log(`[PDF Mon V7 DEBUG] Füge neue Seite für Summary/Footer hinzu...`);
                doc.addPage();
                currentPage++;
                console.log(`[PDF Mon V7 DEBUG] Seite ${currentPage} manuell für Summary/Footer hinzugefügt.`);
                drawPageNumber(doc, currentPage); // Seitenzahl zeichnen

                // Startposition oben auf der neuen Seite
                doc.y = doc.page.margins.top;
                console.log(`[PDF Mon V7 DEBUG] Neue Seite für Summary/Footer gestartet bei Y=${doc.y.toFixed(2)}.`);
            } else {
                 console.log(`[PDF Mon V7 DEBUG] Kein Seitenumbruch vor Summary/Footer nötig.`);
                 doc.y += V_SPACE.LARGE; // Platz vor Summary lassen
                 console.log(`[PDF Mon V7 DEBUG] Y nach V_SPACE.LARGE: ${doc.y.toFixed(2)}`);
            }

            // --- Zeichne Zusammenfassung ---
            const summaryStartY = doc.y;
            console.log(`[PDF Mon V7 DEBUG] Zeichne Summary auf Seite ${currentPage} bei Y=${summaryStartY.toFixed(2)}`);
            // Font für Summary setzen
            console.log(`[PDF Mon V7 DEBUG] Setze Font für Summary auf ${FONT_BOLD}, Size ${FONT_SIZE.SUMMARY}`);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
            const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
            const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
            const summaryLabelX = doc.page.margins.left;
            const summaryValueX = tableLayout.colPositions.actual;
            const summaryLineSpacing = 0.5; // Kleiner Zeilenabstand

            doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.text("Gesamt Soll-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text("Gesamt Ist-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            // Detailzeile mit FONT_NORMAL
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY); // Font für Detailzeile umschalten
            doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHours)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHours)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth -10});
            doc.moveDown(summaryLineSpacing+0.3);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY); // Font wieder auf BOLD für nächste Zeilen
            const totalDiff = (data.totalActual || 0) - (data.totalExpected || 0); doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

            // Y-Position nach der letzten Zeile der Zusammenfassung
            const summaryEndY = doc.y + doc.heightOfString("Neuer Übertrag...", {width: summaryLabelWidth}); // Höhe der letzten Zeile berücksichtigen
            console.log(`[PDF Mon V7 DEBUG] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);
            doc.y = summaryEndY; // doc.y explizit setzen

            // --- Zeichne Signatur-Footer ---
            const footerStartY = doc.y + V_SPACE.LARGE; // Abstand nach Summary
            console.log(`[PDF Mon V7 DEBUG] Zeichne Signatur-Footer auf Seite ${currentPage} bei Y=${footerStartY.toFixed(2)}`);
            drawSignatureFooter(doc, footerStartY); // Setzt intern Font etc.

            // --- PDF abschließen ---
            console.log("[PDF Mon V7 DEBUG] Finalisiere Dokument (rufe doc.end() auf)...");
            doc.end();
            console.log("[PDF Mon V7 DEBUG] doc.end() aufgerufen. Warten auf Stream-Ende.");

        } catch (err) {
             // *** Fehlerbehandlung ***
            console.error("[PDF Mon V7 DEBUG] !!!!! CATCH BLOCK REACHED !!!!!");
            console.error("Fehler Erstellen Monats-PDF V7:", err);
            if (doc && !doc.writableEnded && !res.headersSent) {
                 console.error("[PDF Mon V7 DEBUG] Catch-Block: Versuche Fehler-PDF zu senden.");
                 try {
                     if (currentPage === 0) { // Falls noch keine Seite existiert
                         console.error("[PDF Mon V7 DEBUG] Catch-Block: Keine Seite vorhanden, füge eine hinzu.");
                         doc.addPage(); currentPage++; drawPageNumber(doc, currentPage);
                     }
                     doc.font(FONT_NORMAL).fontSize(10); // Font für Fehlermeldung
                     doc.text(`Fehler beim Erstellen des PDFs: ${err.message}\n\nStack: ${err.stack}`, // Mehr Details im Fehlerfall
                              doc.page.margins.left, doc.page.margins.top, { width: usableWidth });
                     console.error("[PDF Mon V7 DEBUG] Catch-Block: Rufe doc.end() für Fehler-PDF auf.");
                     doc.end();
                 } catch (pdfErr) {
                     console.error("[PDF Mon V7 DEBUG] Catch-Block: Konnte nicht einmal Fehler-PDF generieren:", pdfErr);
                     if (!res.headersSent) {
                         console.error("[PDF Mon V7 DEBUG] Catch-Block: Sende 500er Status.");
                         res.status(500).send(`Interner Serverfehler beim PDF erstellen: ${err.message}`);
                     }
                 }
            } else if (!res.headersSent) {
                 console.error("[PDF Mon V7 DEBUG] Catch-Block: Keine Header gesendet, sende 500er Status.");
                res.status(500).send(`Fehler Erstellen Monats-PDF: ${err.message}`);
            } else {
                 console.error("[PDF Mon V7 DEBUG] Catch-Block: Header bereits gesendet, beende Stream, falls möglich.");
                 if (doc && !doc.writableEnded) {
                    console.error("[PDF Mon V7 DEBUG] Catch-Block: Rufe doc.end() für bestehenden Stream auf.");
                    doc.end();
                 }
            }
        }
    }); // Ende /create-monthly-pdf
    //-----------------------------------------------------

    // GET /create-period-pdf (V7 - Layout Fix)
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        console.log(`[PDF Per V7 DEBUG] Route /create-period-pdf START.`);
        let doc;
        let currentPage = 0;
         try {
            const { name, year, periodType, periodValue } = req.query;
            console.log(`[PDF Per V7 DEBUG] Query Params: name=${name}, year=${year}, periodType=${periodType}, periodValue=${periodValue}`);
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 console.error("[PDF Per V7 DEBUG] Ungültige Parameter empfangen (Name, Jahr, PeriodType).");
                return res.status(400).send("Parameter fehlen oder sind ungültig (Name, Jahr, PeriodType).");
            }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
                 console.error("[PDF Per V7 DEBUG] Ungültiger periodValue für Quartal.");
                 return res.status(400).send("Gültiger periodValue (1-4) für Quartal erforderlich.");
            }

            const parsedYear = parseInt(year, 10);
            const pTypeUpper = periodType.toUpperCase();
            const pValue = pTypeUpper === 'QUARTER' ? parseInt(periodValue) : null;

            console.log(`[PDF Per V7] Starte Generierung für ${name}, ${year}, Typ: ${pTypeUpper}, Wert: ${pValue}`);
            console.log(`[PDF Per V7 DEBUG] Rufe calculatePeriodData auf...`);
            const data = await calculatePeriodData(db, name, year, pTypeUpper, pValue);
            console.log(`[PDF Per V7 DEBUG] calculatePeriodData erfolgreich. ${data?.workEntriesPeriod?.length || 0} Arbeits- und ${data?.absenceEntriesPeriod?.length || 0} Abwesenheitseinträge gefunden.`);
            const employeeDataForPdf = data.employeeData;

            console.log(`[PDF Per V7 DEBUG] Erstelle PDFDocument...`);
            doc = new PDFDocument(PAGE_OPTIONS);
            console.log(`[PDF Per V7 DEBUG] Pipe PDF zu Response...`);
            doc.pipe(res);

            // --- Erste Seite ---
            console.log(`[PDF Per V7 DEBUG] Füge erste Seite hinzu...`);
            doc.addPage(); // Fügt Seite 1 hinzu
            currentPage++;
            console.log(`[PDF Per V7 DEBUG] Erste Seite (${currentPage}) hinzugefügt.`);
            drawPageNumber(doc, currentPage); // Zeichnet "Seite 1" unten auf Seite 1

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (pTypeUpper === 'QUARTER' ? `Q${pValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            console.log(`[PDF Per V7 DEBUG] Setze Header: Content-Type und Content-Disposition (Filename: ${filename})`);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            console.log(`[PDF Per V7 DEBUG] Usable Width: ${usableWidth.toFixed(2)}`);

            // Dokumentenkopf zeichnen (startet bei doc.page.margins.top)
            const title = pTypeUpper === 'QUARTER' ?
                `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}` : `Jahresnachweis ${parsedYear}`;
            console.log(`[PDF Per V7 DEBUG] Zeichne Dokumentenkopf auf Seite ${currentPage} mit Titel: ${title}...`);
            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);
            console.log(`[PDF Per V7 DEBUG] Dokumentenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

             // Tabellenkopf zeichnen (startet bei currentY, den drawDocumentHeader zurückgegeben hat)
            console.log(`[PDF Per V7 DEBUG] Zeichne Tabellenkopf auf Seite ${currentPage} bei Y=${currentY.toFixed(2)}...`);
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY; // Y-Position nach dem Tabellenkopf
            console.log(`[PDF Per V7 DEBUG] Tabellenkopf gezeichnet, Y=${currentY.toFixed(2)}`);

            // Font für Tabelleninhalt setzen (wichtig!)
             console.log(`[PDF Per V7 DEBUG] Setze Font für Tabelleninhalt auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
            doc.y = currentY; // Setze die aktuelle Zeichenposition

            // --- Kombinierte und sortierte Liste (Periode) ---
            console.log(`[PDF Per V7 DEBUG] Bereite kombinierte Tagesliste für Periode vor...`);
            const allDaysPeriod = [];
            // ... (Rest der Datenaufbereitung bleibt gleich)
            data.workEntriesPeriod.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDaysPeriod.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntriesPeriod.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDaysPeriod.some(d => d.date === dateStr)) { allDaysPeriod.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));
            console.log(`[PDF Per V7 DEBUG] ${allDaysPeriod.length} Einträge zu zeichnen.`);

            // --- Schleife zum Zeichnen der Tabellenzeilen (Periode) ---
            console.log(`[PDF Per V7 DEBUG] Starte Schleife zum Zeichnen der Tabellenzeilen bei Y=${doc.y.toFixed(2)}...`);
            if (allDaysPeriod.length === 0) {
                console.log(`[PDF Per V7 DEBUG] Keine Einträge vorhanden, zeichne Platzhaltertext.`);
                doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT); // Font sicherheitshalber setzen
                doc.text('Keine Buchungen/Abwesenheiten für diesen Zeitraum.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];
                    console.log(`[PDF Per V7 DEBUG] --- Schleife Iteration ${i+1}/${allDaysPeriod.length} für Datum ${dayData.date} ---`);
                    console.log(`[PDF Per V7 DEBUG] Aktuelle Position Y=${doc.y.toFixed(2)}, Seitenhöhe=${doc.page.height}, Unterer Rand=${doc.page.margins.bottom}`);

                    // === Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    const estimatedLineHeight = TABLE_ROW_HEIGHT; // Einfache Annahme
                    console.log(`[PDF Per V7 DEBUG] Prüfe Seitenumbruch: Y (${doc.y.toFixed(2)}) + RowHeight (${estimatedLineHeight}) > Limit (${(doc.page.height - doc.page.margins.bottom).toFixed(2)})?`);
                    if (doc.y + estimatedLineHeight > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Per V7 DEBUG] >>> Seitenumbruch NÖTIG vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)} <<<`);
                        console.log(`[PDF Per V7 DEBUG] Füge neue Seite hinzu...`);
                        doc.addPage(); // Fügt Seite (currentPage + 1) hinzu
                        currentPage++;
                        console.log(`[PDF Per V7 DEBUG] Seite ${currentPage} manuell hinzugefügt.`);
                        drawPageNumber(doc, currentPage); // Zeichnet Seitenzahl unten

                        // Tabellenkopf auf neuer Seite zeichnen
                        currentY = doc.page.margins.top; // Startet oben auf der neuen Seite
                        console.log(`[PDF Per V7 DEBUG] Rufe drawTableHeader auf Seite ${currentPage} auf bei Y=${currentY.toFixed(2)}.`);
                        tableLayout = drawTableHeader(doc, currentY, usableWidth); // Zeichnet Header, gibt Y danach zurück
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY; // Setzt aktuelle Zeichenposition

                        // Font für Tabelleninhalt auf neuer Seite setzen!
                        console.log(`[PDF Per V7 DEBUG] Setze Font für Tabelleninhalt auf neuer Seite auf ${FONT_NORMAL}, Size ${FONT_SIZE.TABLE_CONTENT}`);
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1.5);
                        console.log(`[PDF Per V7 DEBUG] Tabellenkopf auf neuer Seite gezeichnet, weiter bei Y=${doc.y.toFixed(2)}`);
                    } else {
                         console.log(`[PDF Per V7 DEBUG] Kein Seitenumbruch nötig.`);
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen ---
                    // Sicherstellen, dass der Font für den Tabelleninhalt korrekt ist
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT);
                    console.log(`[PDF Per V7 DEBUG] Zeichne Zeile ${i+1} für Datum ${dayData.date} bei Y=${doc.y.toFixed(2)} (Font: ${doc._font?.name}, Size: ${doc._fontSize})...`);

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

                    doc.y = currentRowY + TABLE_ROW_HEIGHT; // Y-Position für nächste Zeile erhöhen
                    console.log(`[PDF Per V7 DEBUG] Zeile ${i+1} gezeichnet. Neue Position Y=${doc.y.toFixed(2)}`);
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
                console.log(`[PDF Per V7 DEBUG] Schleife für Tabellenzeilen beendet.`);
            }
            // *** Ende Schleife für Tabellenzeilen (Periode) ***


             // *** Zusammenfassung und Signatur-Footer ***
            console.log(`[PDF Per V7 DEBUG] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary (${SUMMARY_TOTAL_HEIGHT.toFixed(2)}px) + Footer (${FOOTER_TOTAL_HEIGHT.toFixed(2)}px).`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE; // Extra Platz
            console.log(`[PDF Per V7 DEBUG] Platz benötigt: ${spaceNeededForSummaryAndFooter.toFixed(2)}. Verfügbar bis ${(doc.page.height - doc.page.margins.bottom).toFixed(2)}.`);

            // Prüfen, ob Zusammenfassung UND Footer noch auf die AKTUELLE Seite passen
            if (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF Per V7 DEBUG] >>> Seitenumbruch NÖTIG vor Summary/Footer bei Y=${doc.y.toFixed(2)} <<<`);
                console.log(`[PDF Per V7 DEBUG] Füge neue Seite für Summary/Footer hinzu...`);
                doc.addPage();
                currentPage++;
                console.log(`[PDF Per V7 DEBUG] Seite ${currentPage} manuell für Summary/Footer hinzugefügt.`);
                drawPageNumber(doc, currentPage); // Seitenzahl zeichnen

                // Startposition oben auf der neuen Seite
                doc.y = doc.page.margins.top;
                console.log(`[PDF Per V7 DEBUG] Neue Seite für Summary/Footer gestartet bei Y=${doc.y.toFixed(2)}.`);
            } else {
                 console.log(`[PDF Per V7 DEBUG] Kein Seitenumbruch vor Summary/Footer nötig.`);
                 doc.y += V_SPACE.LARGE; // Platz vor Summary lassen
                 console.log(`[PDF Per V7 DEBUG] Y nach V_SPACE.LARGE: ${doc.y.toFixed(2)}`);
            }

            // --- Zeichne Zusammenfassung (Periode) ---
            const summaryStartY = doc.y;
            console.log(`[PDF Per V7 DEBUG] Zeichne Summary auf Seite ${currentPage} bei Y=${summaryStartY.toFixed(2)}`);
             // Font für Summary setzen
            console.log(`[PDF Per V7 DEBUG] Setze Font für Summary auf ${FONT_BOLD}, Size ${FONT_SIZE.SUMMARY}`);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
            const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
            const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
            const summaryLabelX = doc.page.margins.left;
            const summaryValueX = tableLayout.colPositions.actual;
            const summaryLineSpacing = 0.5; // Kleiner Zeilenabstand
            const periodLabelSummary = data.periodIdentifier || pTypeUpper;

            doc.text("Übertrag Periodenbeginn (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.startingBalance || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.text(`Gesamt Soll-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.totalExpectedPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text(`Gesamt Ist-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.totalActualPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            // Detailzeile mit FONT_NORMAL
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY); // Font für Detailzeile umschalten
            doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHoursPeriod)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHoursPeriod)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth-10});
            doc.moveDown(summaryLineSpacing+0.3);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY); // Font wieder auf BOLD für nächste Zeilen
            doc.text(`Gesamt Mehr/Minderstunden (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth }); doc.text(decimalHoursToHHMM(data.periodDifference || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            doc.moveDown(summaryLineSpacing);
            doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth });
            doc.text(decimalHoursToHHMM(data.endingBalancePeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

            // Y-Position nach der letzten Zeile der Zusammenfassung
            const summaryEndY = doc.y + doc.heightOfString("Neuer Übertrag...", {width: summaryLabelWidth}); // Höhe der letzten Zeile berücksichtigen
            console.log(`[PDF Per V7 DEBUG] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);
            doc.y = summaryEndY; // doc.y explizit setzen

            // --- Zeichne Signatur-Footer ---
            const footerStartY = doc.y + V_SPACE.LARGE; // Abstand nach Summary
             // Font wird in drawSignatureFooter intern gesetzt (FONT_NORMAL, FONT_SIZE.FOOTER)
            console.log(`[PDF Per V7 DEBUG] Zeichne Signatur-Footer auf Seite ${currentPage} bei Y=${footerStartY.toFixed(2)}`);
            drawSignatureFooter(doc, footerStartY);

            // --- PDF abschließen ---
            console.log("[PDF Per V7 DEBUG] Finalisiere Dokument (rufe doc.end() auf)...");
            doc.end();
            console.log("[PDF Per V7 DEBUG] doc.end() aufgerufen. Warten auf Stream-Ende.");

        } catch (err) {
             // *** Fehlerbehandlung ***
            console.error("[PDF Per V7 DEBUG] !!!!! CATCH BLOCK REACHED !!!!!");
            console.error("Fehler Erstellen Perioden-PDF V7:", err);
            // Detailliertere Fehlermeldung im PDF
            if (doc && !doc.writableEnded && !res.headersSent) {
                 console.error("[PDF Per V7 DEBUG] Catch-Block: Versuche Fehler-PDF zu senden.");
                 try {
                    if (currentPage === 0) { // Falls noch keine Seite existiert
                        console.error("[PDF Per V7 DEBUG] Catch-Block: Keine Seite vorhanden, füge eine hinzu.");
                        doc.addPage(); currentPage++; drawPageNumber(doc, currentPage);
                    }
                    doc.font(FONT_NORMAL).fontSize(10); // Font für Fehlermeldung
                    doc.text(`Fehler beim Erstellen des PDFs: ${err.message}\n\nStack: ${err.stack}`, // Mehr Details im Fehlerfall
                             doc.page.margins.left, doc.page.margins.top, { width: usableWidth });
                    console.error("[PDF Per V7 DEBUG] Catch-Block: Rufe doc.end() für Fehler-PDF auf.");
                    doc.end();
                 } catch (pdfErr) {
                     console.error("[PDF Per V7 DEBUG] Catch-Block: Konnte nicht einmal Fehler-PDF generieren:", pdfErr);
                     if (!res.headersSent) {
                         console.error("[PDF Per V7 DEBUG] Catch-Block: Sende 500er Status.");
                         res.status(500).send(`Interner Serverfehler beim PDF erstellen: ${err.message}`);
                     }
                 }
            } else if (!res.headersSent) {
                 console.error("[PDF Per V7 DEBUG] Catch-Block: Keine Header gesendet, sende 500er Status.");
                 res.status(500).send(`Fehler Erstellen Perioden-PDF: ${err.message}`);
            } else {
                 console.error("[PDF Per V7 DEBUG] Catch-Block: Header bereits gesendet, beende Stream, falls möglich.");
                 if (doc && !doc.writableEnded) {
                    console.error("[PDF Per V7 DEBUG] Catch-Block: Rufe doc.end() für bestehenden Stream auf.");
                    doc.end();
                 }
            }
        } // Ende Catch-Block für die Route
    }); // Ende /create-period-pdf


    return router; // Router zurückgeben
}; // Ende module.exports
