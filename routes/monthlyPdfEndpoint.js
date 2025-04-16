// monthlyPdfEndpoint.js - ÜBERARBEITET für dynamische Paginierung + Test Route

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere BEIDE Berechnungsfunktionen
const { calculateMonthlyData, calculatePeriodData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const PAGE_OPTIONS = { size: 'A4', autoFirstPage: false, margins: { top: 25, bottom: 25, left: 40, right: 40 } }; // autoFirstPage: false
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { HEADER: 16, SUB_HEADER: 11, TABLE_HEADER: 9, TABLE_CONTENT: 9, SUMMARY: 8, FOOTER: 8 };

// *** WICHTIG: Höhenabschätzungen - Anpassen bei Bedarf! ***
const TABLE_ROW_HEIGHT = 11; // Etwas mehr Puffer als nur Schriftgröße
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL; // Höhe des Bestätigungstextes
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL; // Platz für Linie + "Datum, Unterschrift"
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM; // Geschätzte Gesamthöhe des Footers inkl. Abstände

// Höhe der Zusammenfassung (Beispiel, ggf. genauer berechnen/testen)
// Annahme: Ca. 6-7 Zeilen inkl. Leerzeilen/Padding
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

// Hilfsfunktion: Zeichnet den Dokumentenkopf (Logo, Titel, Name, Zeitraum)
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) {
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;
    let currentY = doc.page.margins.top;
    const headerStartY = currentY; // Merken für Rückgabewert

    // Logo (rechts oben)
    try {
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        const logoWidth = 70; // Etwas kleiner für mehr Platz
        const logoHeight = 70;
        const logoX = doc.page.width - pageRightMargin - logoWidth;
        doc.image(logoPath, logoX, currentY, { width: logoWidth, height: logoHeight });
        // Y-Position für Text neben Logo setzen (vertikal zentriert zum Logo?)
        currentY += V_SPACE.SMALL; // Kleiner Abstand
    } catch (errLogo) {
        console.warn("Logo Fehler:", errLogo);
        currentY += V_SPACE.SMALL; // Auch ohne Logo starten
    }

    // Titel (Zentriert, unterhalb Logo-Oberkante)
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
    doc.text(title, pageLeftMargin, headerStartY + V_SPACE.SMALL, { align: 'center', width: usableWidth }); // Zentriert auf der Seite

    // Name und Zeitraum (linksbündig, unter Titel)
    // Setze Y unter den Titel
    currentY = headerStartY + V_SPACE.SMALL + FONT_SIZE.HEADER + V_SPACE.LARGE;

    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE; // Abstand zum Tabellenkopf

    return currentY; // Gibt die Y-Position UNTERHALB des Headers zurück
}

// Hilfsfunktion: Zeichnet den Tabellenkopf
function drawTableHeader(doc, startY, usableWidth) {
    const pageLeftMargin = doc.page.margins.left;
    // Spaltenbreiten - leicht angepasst für bessere Lesbarkeit
    const colWidths = {
        date: 105, // Mehr Platz für Wochentag
        start: 65,
        end: 85, // Mehr Platz für "Urlaub"/"Krank"
        expected: 75,
        actual: 75,
        diff: usableWidth - 105 - 65 - 85 - 75 - 75 // Restbreite
    };
    // Spaltenpositionen neu berechnen
    const colPositions = {
        date: pageLeftMargin,
        start: pageLeftMargin + colWidths.date,
        end: pageLeftMargin + colWidths.date + colWidths.start,
        expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
        actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
        diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
    };

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);
    const headerTextY = startY + V_SPACE.TINY; // Weniger Abstand nach oben

    // Texte zentrierter für bessere Übereinstimmung mit Spalten
    doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' }); // Datum links
    doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
    doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
    doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
    doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
    doc.text("Mehr/Minder\nStd.(HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });

    // Linie unter dem Header
    const headerBottomY = headerTextY + (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.SMALL; // Y-Position der Linie
    doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke();

    // Gibt die Y-Position UNTERHALB der Linie zurück + kleiner Abstand
    return { headerBottomY: headerBottomY + V_SPACE.SMALL, colWidths, colPositions };
}

// Hilfsfunktion: Zeichnet den Footer (Bestätigungstext + Unterschriftsbereich)
function drawFooter(doc, startY) {
    const pageLeftMargin = doc.page.margins.left;
    const usableWidth = doc.page.width - pageLeftMargin - doc.page.margins.right;
    let currentY = startY;

    // Prüfe, ob überhaupt genug Platz für den Footer ist, notfalls neue Seite
    // Dies ist eine zusätzliche Sicherheit, falls der Footer alleine umbrechen muss
    const neededHeight = doc.heightOfString("Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.", { width: usableWidth })
                         + V_SPACE.SIGNATURE_GAP + V_SPACE.SMALL + FONT_SIZE.FOOTER + V_SPACE.SMALL; // Kalkulierte Höhe
    if (currentY + neededHeight > doc.page.height - doc.page.margins.bottom) {
        console.log(`[PDF Footer] Seitenumbruch nötig nur für Footer bei Y=${currentY.toFixed(2)}`);
        doc.addPage();
        currentY = doc.page.margins.top;
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
    // Kein Rückgabewert nötig, da dies das letzte Element ist
}

// Middleware: isAdmin (unverändert)
function isAdmin(req, res, next) {
    // Wichtig: Prüfe, ob die Session überhaupt existiert
    if (req.session && req.session.isAdmin === true) {
        next(); // Zugriff erlaubt
    } else {
        // Optional: Logge mehr Details bei fehlgeschlagenem Check
        console.warn(`isAdmin Check FAILED - Session ID: ${req.sessionID}, isAdmin Flag: ${req.session ? req.session.isAdmin : 'undefined'}, Path: ${req.originalUrl}`);
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.'); // Zugriff verweigert
    }
}


//-----------------------------------------------------
// PDF ROUTEN
//-----------------------------------------------------
module.exports = function (db) {

    // +++ NEUE TEST ROUTE +++
    router.get('/test', (req, res) => {
        console.log('*************************************');
        console.log('[PDF TEST ROUTE] /api/pdf/test wurde erreicht!');
        console.log('*************************************');
        // Optional: Prüfen ob Admin, falls nötig zum Testen
        // if (!req.session || req.session.isAdmin !== true) {
        //     return res.status(403).send('Admin erforderlich für Test');
        // }
        res.status(200).send('PDF Test Route OK');
    });
    // --- Ende Test-Route ---


    // GET /create-monthly-pdf (Angepasst für Paginierung)
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        let doc; // Definiere doc außerhalb für Catch-Block Zugriff
        try { // Start Try-Block für die Route
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
                return res.status(400).send("Parameter fehlen oder sind ungültig.");
            }
            const parsedYear = parseInt(year, 10);
            const parsedMonth = parseInt(month, 10);

            console.log(`[PDF Mon] Starte Generierung für ${name}, ${parsedMonth}/${parsedYear}`);
            const data = await calculateMonthlyData(db, name, year, month);
            const employeeDataForPdf = data.employeeData; // Für getExpectedHours

            doc = new PDFDocument(PAGE_OPTIONS); // autoFirstPage: false verwenden!
            doc.addPage(); // Erste Seite manuell hinzufügen

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

            // *** Erste Seite: Header und Tabellenkopf ***
            let currentY = drawDocumentHeader(doc,
                `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`,
                data.employeeName,
                new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)),
                new Date(Date.UTC(parsedYear, parsedMonth, 0)) // Letzter Tag des Monats
            );
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1); // LineGap für besseren Abstand
            doc.y = currentY; // Setze Startposition für Zeilen

            // Kombinierte und sortierte Liste aus Arbeit und Abwesenheit (unverändert)
            const allDays = [];
            data.workEntries.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDays.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntries.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDays.some(d => d.date === dateStr)) { allDays.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            console.log(`[PDF Mon] ${allDays.length} Einträge zu zeichnen.`);

            // *** Schleife zum Zeichnen der Tabellenzeilen ***
            if (allDays.length === 0) {
                doc.text('Keine Buchungen/Abwesenheiten für diesen Monat.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
                // currentY = doc.y; // Nicht mehr nötig, doc.y ist führend
            } else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];

                    // === NEUE Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    // Prüft, ob die NÄCHSTE Zeile noch auf die aktuelle Seite passt.
                    if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Mon] Seitenumbruch vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)}`);
                        doc.addPage();
                        currentY = doc.page.margins.top;

                        // KEINEN Dokumenten-Header hier, der ist nur auf Seite 1 (oder anpassen wenn nötig)

                        // Tabellen-Header auf neuer Seite zeichnen
                        tableLayout = drawTableHeader(doc, currentY, usableWidth);
                        currentY = tableLayout.headerBottomY; // Y-Position unter den neuen Header setzen
                        doc.y = currentY; // Sicherstellen, dass pdfkit die Position kennt

                        // Schriftart/Stil für Tabelleninhalt wiederherstellen
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1);
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen (Code fast unverändert) ---
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    // Stelle sicher, dass employeeDataForPdf existiert
                    const expectedHours = employeeDataForPdf ? getExpectedHours(employeeDataForPdf, dayData.date) : 0;
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--";
                    let endOverride = dayData.endTime || "--:--";
                    if (dayData.type !== 'WORK') {
                        startOverride = '--:--';
                        endOverride = dayData.comment || (dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag'));
                    }
                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours);
                    const diffStr = decimalHoursToHHMM(diffHours);

                    const currentRowY = doc.y; // Aktuelle Y-Position merken

                    // Zeichne die Zellen-Texte nebeneinander
                    // Nutze die neu berechneten colPositions und colWidths aus tableLayout
                    const { colPositions, colWidths } = tableLayout;
                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'center', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: 'center', lineBreak: false });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'center', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'center', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'center', lineBreak: false });

                    // Wichtig: Y-Position manuell erhöhen, da lineBreak: false verwendet wird
                    doc.y = currentRowY + TABLE_ROW_HEIGHT;
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen ***

            // *** Zusammenfassung und Footer NUR AM ENDE zeichnen ***
            console.log(`[PDF Mon] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary (${SUMMARY_TOTAL_HEIGHT.toFixed(2)}px) + Footer (${FOOTER_TOTAL_HEIGHT.toFixed(2)}px).`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE; // Platzbedarf inkl. Abstand

            // Prüfen, ob Zusammenfassung UND Footer noch auf die AKTUELLE Seite passen
            if (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF Mon] Seitenumbruch vor Summary/Footer bei Y=${doc.y.toFixed(2)}`);
                doc.addPage(); // Neue Seite NUR für Summary & Footer
                doc.y = doc.page.margins.top; // An den Seitenanfang
            } else {
                 // Etwas Abstand nach der Tabelle, nur wenn kein Seitenumbruch war
                 doc.y += V_SPACE.LARGE;
            }

            // --- Zeichne Zusammenfassung ---
            const summaryStartY = doc.y;
            console.log(`[PDF Mon] Zeichne Summary bei Y=${summaryStartY.toFixed(2)}`);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
            const summaryLabelWidth = tableLayout.colWidths.date + tableLayout.colWidths.start + tableLayout.colWidths.end + tableLayout.colWidths.expected - V_SPACE.SMALL;
            const summaryValueWidth = tableLayout.colWidths.actual + tableLayout.colWidths.diff;
            const summaryLabelX = doc.page.margins.left;
            const summaryValueX = tableLayout.colPositions.actual; // Nutze tableLayout
            const summaryLineSpacing = 0.5; // Etwas mehr Abstand

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

            const summaryEndY = doc.y; // Position nach der Zusammenfassung
            console.log(`[PDF Mon] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);

            // --- Zeichne Footer ---
            const footerStartY = summaryEndY + V_SPACE.LARGE; // Abstand nach der Summary
            console.log(`[PDF Mon] Zeichne Footer bei Y=${footerStartY.toFixed(2)}`);
            drawFooter(doc, footerStartY); // Funktion zeichnet Footer

            // --- PDF abschließen ---
            console.log("[PDF Mon] Finalisiere Dokument.");
            doc.end();

        } catch (err) { // Catch-Block für die Route
            console.error("Fehler Erstellen Monats-PDF:", err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler Erstellen Monats-PDF: ${err.message}`);
            } else {
                console.error("Monats-PDF Header bereits gesendet, versuche Stream zu beenden.");
                if (doc && !doc.writableEnded) {
                    doc.end(); // Versuche, den Stream sauber zu beenden
                }
            }
        } // Ende Catch-Block für die Route
    }); // Ende /create-monthly-pdf

    //-----------------------------------------------------

    // GET /create-period-pdf (Angepasst für Paginierung)
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        let doc; // Definiere doc außerhalb für Catch-Block Zugriff
         try { // Start Try-Block für die Route
            const { name, year, periodType, periodValue } = req.query;
            // Validierung (unverändert)
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                 return res.status(400).send("Parameter fehlen oder sind ungültig (Name, Jahr, PeriodType).");
            }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
                 return res.status(400).send("Gültiger periodValue (1-4) für Quartal erforderlich.");
            }
            const parsedYear = parseInt(year, 10);
            const pTypeUpper = periodType.toUpperCase();
            const pValue = periodType === 'QUARTER' ? parseInt(periodValue) : null;

            console.log(`[PDF Per] Starte Generierung für ${name}, ${year}, Typ: ${pTypeUpper}, Wert: ${pValue}`);
            const data = await calculatePeriodData(db, name, year, pTypeUpper, pValue);
            const employeeDataForPdf = data.employeeData; // Für getExpectedHours

            doc = new PDFDocument(PAGE_OPTIONS); // autoFirstPage: false
            doc.addPage(); // Erste Seite manuell

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (pTypeUpper === 'QUARTER' ? `Q${pValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

            // *** Erste Seite: Header und Tabellenkopf ***
            const title = pTypeUpper === 'QUARTER' ? `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}` : `Jahresnachweis ${parsedYear}`;
            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);
            let tableLayout = drawTableHeader(doc, currentY, usableWidth);
            currentY = tableLayout.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1);
            doc.y = currentY;

            // Kombinierte und sortierte Liste (Periode)
            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(entry => { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date); allDaysPeriod.push({ date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime, actualHours: parseFloat(entry.hours) || 0, comment: entry.comment }); });
            data.absenceEntriesPeriod.forEach(absence => { const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date); if (!allDaysPeriod.some(d => d.date === dateStr)) { allDaysPeriod.push({ date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--', actualHours: parseFloat(absence.hours) || 0, comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag') }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            console.log(`[PDF Per] ${allDaysPeriod.length} Einträge zu zeichnen.`);

            // *** Schleife zum Zeichnen der Tabellenzeilen (Periode) ***
            if (allDaysPeriod.length === 0) {
                doc.text('Keine Buchungen/Abwesenheiten für diesen Zeitraum.', doc.page.margins.left, doc.y, {width: usableWidth});
                doc.y += TABLE_ROW_HEIGHT;
                // currentY = doc.y; // Nicht nötig
            } else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];

                    // === NEUE Seitenumbruch-Prüfung VOR dem Zeichnen der Zeile ===
                    if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom) {
                        console.log(`[PDF Per] Seitenumbruch vor Zeile ${i+1} bei Y=${doc.y.toFixed(2)}`);
                        doc.addPage();
                        currentY = doc.page.margins.top;
                        // Tabellen-Header auf neuer Seite zeichnen
                        tableLayout = drawTableHeader(doc, currentY, usableWidth);
                        currentY = tableLayout.headerBottomY;
                        doc.y = currentY;
                        // Schriftart/Stil wiederherstellen
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(1);
                    }
                    // === Ende Seitenumbruch-Prüfung ===

                    // --- Zeile zeichnen (Code fast unverändert) ---
                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = employeeDataForPdf ? getExpectedHours(employeeDataForPdf, dayData.date) : 0;
                    const diffHours = actualHours - expectedHours;
                    let startOverride = dayData.startTime || "--:--";
                    let endOverride = dayData.endTime || "--:--";
                     if (dayData.type !== 'WORK') {
                        startOverride = '--:--';
                        endOverride = dayData.comment || (dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag'));
                    }
                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours);
                    const diffStr = decimalHoursToHHMM(diffHours);

                    const currentRowY = doc.y; // Aktuelle Y-Position merken
                    const { colPositions, colWidths } = tableLayout; // Verwende das aktuelle tableLayout

                    doc.text(dateFormatted, colPositions.date, currentRowY, { width: colWidths.date, align: 'left', lineBreak: false });
                    doc.text(startOverride, colPositions.start, currentRowY, { width: colWidths.start, align: 'center', lineBreak: false });
                    doc.text(endOverride, colPositions.end, currentRowY, { width: colWidths.end, align: 'center', lineBreak: false });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { width: colWidths.expected, align: 'center', lineBreak: false });
                    doc.text(actualStr, colPositions.actual, currentRowY, { width: colWidths.actual, align: 'center', lineBreak: false });
                    doc.text(diffStr, colPositions.diff, currentRowY, { width: colWidths.diff, align: 'center', lineBreak: false });

                    // Y-Position manuell erhöhen
                    doc.y = currentRowY + TABLE_ROW_HEIGHT;
                    // --- Ende Zeile zeichnen ---
                } // Ende der for-Schleife
            }
            // *** Ende Schleife für Tabellenzeilen (Periode) ***


             // *** Zusammenfassung und Footer NUR AM ENDE zeichnen (Periode) ***
            console.log(`[PDF Per] Ende Tabelle bei Y=${doc.y.toFixed(2)}. Prüfe Platz für Summary (${SUMMARY_TOTAL_HEIGHT.toFixed(2)}px) + Footer (${FOOTER_TOTAL_HEIGHT.toFixed(2)}px).`);
            const spaceNeededForSummaryAndFooter = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT + V_SPACE.LARGE;

            // Prüfen, ob Zusammenfassung UND Footer noch auf die AKTUELLE Seite passen
            if (doc.y + spaceNeededForSummaryAndFooter > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF Per] Seitenumbruch vor Summary/Footer bei Y=${doc.y.toFixed(2)}`);
                doc.addPage(); // Neue Seite NUR für Summary & Footer
                doc.y = doc.page.margins.top; // An den Seitenanfang
            } else {
                 // Etwas Abstand nach der Tabelle, nur wenn kein Seitenumbruch war
                 doc.y += V_SPACE.LARGE;
            }

            // --- Zeichne Zusammenfassung (Periode) ---
            const summaryStartY = doc.y;
            console.log(`[PDF Per] Zeichne Summary bei Y=${summaryStartY.toFixed(2)}`);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
            // Nutze Spaltenbreiten/Positionen vom letzten tableLayout
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

            const summaryEndY = doc.y; // Position nach der Zusammenfassung
            console.log(`[PDF Per] Ende Summary bei Y=${summaryEndY.toFixed(2)}`);

            // --- Zeichne Footer ---
            const footerStartY = summaryEndY + V_SPACE.LARGE; // Abstand nach der Summary
            console.log(`[PDF Per] Zeichne Footer bei Y=${footerStartY.toFixed(2)}`);
            drawFooter(doc, footerStartY); // Funktion zeichnet Footer

            // --- PDF abschließen ---
            console.log("[PDF Per] Finalisiere Dokument.");
            doc.end();

        } catch (err) { // Catch-Block für die Route
            console.error("Fehler Erstellen Perioden-PDF:", err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler Erstellen Perioden-PDF: ${err.message}`);
            } else {
                console.error("Perioden-PDF Header bereits gesendet, versuche Stream zu beenden.");
                if (doc && !doc.writableEnded) {
                    doc.end(); // Versuche, den Stream sauber zu beenden
                }
            }
        } // Ende Catch-Block für die Route
    }); // Ende /create-period-pdf


    return router; // Router zurückgeben
}; // Ende module.exports
