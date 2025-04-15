const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere BEIDE Berechnungsfunktionen
const { calculateMonthlyData, calculatePeriodData } = require('../utils/calculationUtils'); // calculatePeriodData hinzugefügt

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const PAGE_OPTIONS = { size: 'A4', margins: { top: 25, bottom: 25, left: 40, right: 40 } };
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = { HEADER: 16, SUB_HEADER: 11, TABLE_HEADER: 9, TABLE_CONTENT: 9, SUMMARY: 8, FOOTER: 8 };
const TABLE_ROW_HEIGHT = 10; // Minimale Zeilenhöhe

/**
 * Hilfsfunktion: Wandelt Dezimalstunden in ein HH:MM-Format um.
 */
function decimalHoursToHHMM(decimalHours) {
    if (isNaN(decimalHours) || decimalHours === null) return "00:00";
    const sign = decimalHours < 0 ? "-" : "";
    const absHours = Math.abs(decimalHours);
    const totalMinutes = Math.round(absHours * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Formatiert ein Datum (YYYY-MM-DD oder Date-Objekt) zu DD.MM.YYYY (UTC).
 */
function formatDateGerman(dateInput) {
    if (!dateInput) return 'N/A';
    try {
        const dateStr = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
        const dateObj = new Date(dateStr + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) return String(dateInput); // Fallback
        return dateObj.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    } catch (e) {
        console.warn("Fehler beim Formatieren des Datums:", dateInput, e);
        return String(dateInput); // Fallback
    }
}
/**
 * Formatiert ein Datum (YYYY-MM-DD oder Date-Objekt) zu "Wochentag, DD.MM.YYYY" (UTC).
 */
function formatDateGermanWithWeekday(dateInput) {
     if (!dateInput) return 'N/A';
     try {
         const dateStr = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
         const dateObj = new Date(dateStr + "T00:00:00Z");
         if (isNaN(dateObj.getTime())) return String(dateInput);
         let formatted = dateObj.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
          // Korrigiert Formatierung wie "Sa,. 13.04.2024" zu "Sa., 13.04.2024"
          if (formatted.includes(',') && !formatted.includes('.,')) {
                formatted = formatted.replace(',', '.,');
          }
         return formatted;
     } catch (e) {
         console.warn("Fehler beim Formatieren des Datums mit Wochentag:", dateInput, e);
         return String(dateInput);
     }
 }


/**
 * Zeichnet den PDF-Header (Logo, Titel, Mitarbeiter, Zeitraum).
 */
function drawDocumentHeader(doc, title, employeeName, periodStartDate, periodEndDate) {
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;
    let currentY = doc.page.margins.top;

    // Logo (optional)
    try {
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        const logoWidth = 95; const logoHeight = 95;
        const logoX = doc.page.width - pageRightMargin - logoWidth;
        doc.image(logoPath, logoX, currentY, { width: logoWidth, height: logoHeight });
        currentY = Math.max(currentY + V_SPACE.TINY, currentY + logoHeight); // Y unter Logo/Titel
    } catch (errLogo) { console.warn("Logo konnte nicht geladen/gezeichnet werden:", errLogo); }

    // Titel
    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER);
    doc.text(title, pageLeftMargin, doc.page.margins.top + V_SPACE.TINY, { align: 'center', width: usableWidth });

    // Mitarbeiter & Zeitraum
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${employeeName || 'Unbekannt'}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(periodStartDate)} - ${formatDateGerman(periodEndDate)}`, pageLeftMargin, currentY);
    currentY += FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;

    return currentY; // Gibt die Y-Position nach dem Header zurück
}

/**
 * Zeichnet den Tabellenkopf.
 */
function drawTableHeader(doc, startY, usableWidth) {
    const pageLeftMargin = doc.page.margins.left;
    // Angepasste Spaltenbreiten (evtl. anpassen)
    const colWidths = { date: 115, start: 75, end: 75, expected: 85, actual: 85, diff: usableWidth - 115 - 75 - 75 - 85 - 85 };
    const colPositions = {
        date: pageLeftMargin,
        start: pageLeftMargin + colWidths.date,
        end: pageLeftMargin + colWidths.date + colWidths.start,
        expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end,
        actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected,
        diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual
    };

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER);
    const headerTextY = startY + V_SPACE.SMALL / 2;
    doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
    doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
    doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
    doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
    doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' }); // Ggf. "Ist/Gutschr."
    doc.text("Mehr/Minder\nStd. (HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });

    const headerBottomY = startY + (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.SMALL; // Höhe für 2 Zeilen
    doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke();

    return { headerBottomY: headerBottomY + V_SPACE.MEDIUM - 2, colWidths, colPositions }; // Gibt Y-Position nach Header & Layout zurück
}

/**
 * Zeichnet den Footer (Bestätigung, Unterschrift).
 */
 function drawFooter(doc, startY) {
    const pageLeftMargin = doc.page.margins.left;
    const pageRightMargin = doc.page.margins.right;
    const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;

    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER);
    doc.text(
        "Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.", // Text leicht angepasst
        pageLeftMargin, startY, { align: 'left', width: usableWidth }
    );
    const signatureY = startY + FONT_SIZE.FOOTER + V_SPACE.SIGNATURE_GAP;
    const lineStartX = pageLeftMargin;
    const lineEndX = pageLeftMargin + 200;
    doc.moveTo(lineStartX, signatureY).lineTo(lineEndX, signatureY).lineWidth(0.5).stroke();
    doc.text("Datum, Unterschrift", pageLeftMargin, signatureY + V_SPACE.SMALL);
}


/**
 * Middleware: Prüft, ob eine Admin-Session vorliegt.
 */
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        console.warn(`PDF Route: isAdmin-Check fehlgeschlagen.`);
        res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich.');
    }
}

//-----------------------------------------------------
// PDF ROUTEN
//-----------------------------------------------------
module.exports = function (db) {

    /**
     * GET /create-monthly-pdf
     * Erzeugt PDF für einen Monat (bestehende Route, leicht angepasst für Refactoring).
     */
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(parseInt(year)) || isNaN(parseInt(month)) || month < 1 || month > 12) {
                return res.status(400).send("Name, Jahr und Monat (1-12) erforderlich.");
            }
            const parsedYear = parseInt(year, 10);
            const parsedMonth = parseInt(month, 10);

            // Monatsdaten berechnen (nutzt jetzt aktualisierte Funktion mit Abwesenheitslogik)
            const data = await calculateMonthlyData(db, name, year, month);

            // PDF Dokument erstellen
            const doc = new PDFDocument(PAGE_OPTIONS);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            // --- Layout ---
            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            let currentY = drawDocumentHeader(doc,
                 `Monatsnachweis ${String(parsedMonth).padStart(2, '0')}/${parsedYear}`,
                 data.employeeName,
                 new Date(Date.UTC(parsedYear, parsedMonth - 1, 1)), // Monatsanfang
                 new Date(Date.UTC(parsedYear, parsedMonth, 0))     // Monatsende
            );

            const { headerBottomY, colWidths, colPositions } = drawTableHeader(doc, currentY, usableWidth);
            currentY = headerBottomY;

            // Tabelleninhalt
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5); // Kompakter
            doc.y = currentY; // Startposition für Inhalt setzen

            const footerHeight = FONT_SIZE.FOOTER + V_SPACE.SIGNATURE_GAP + 1 + V_SPACE.SMALL + FONT_SIZE.FOOTER; // Höhe für Footer
            const summaryHeight = 5 * (FONT_SIZE.SUMMARY + V_SPACE.TINY) + V_SPACE.LARGE; // Höhe für Zusammenfassung

            // Generiere die Zeilen basierend auf Arbeitstagen UND Abwesenheitstagen
             const allDays = [];
             // 1. Arbeitseinträge hinzufügen
             data.workEntries.forEach(entry => {
                 const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date);
                 allDays.push({
                     date: dateStr,
                     type: 'WORK',
                     startTime: entry.startTime,
                     endTime: entry.endTime,
                     actualHours: parseFloat(entry.hours) || 0,
                     comment: entry.comment
                 });
             });
              // 2. Abwesenheitseinträge hinzufügen (die noch nicht durch Arbeit abgedeckt sind)
             data.absenceEntries.forEach(absence => {
                  const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date);
                  if (!allDays.some(d => d.date === dateStr)) { // Nur hinzufügen, wenn kein Arbeitseintrag existiert
                       allDays.push({
                           date: dateStr,
                           type: absence.type, // 'VACATION', 'SICK', 'PUBLIC_HOLIDAY'
                           startTime: '--:--',
                           endTime: '--:--',
                           actualHours: parseFloat(absence.hours) || 0, // Gutgeschriebene Stunden
                           comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag')
                       });
                  }
             });
             // 3. Sortieren nach Datum
             allDays.sort((a, b) => new Date(a.date) - new Date(b.date));


            if (allDays.length === 0) {
                doc.text('Keine Buchungen oder Abwesenheiten in diesem Monat gefunden.', doc.page.margins.left, doc.y, { width: usableWidth });
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                for (let i = 0; i < allDays.length; i++) {
                    const dayData = allDays[i];
                    const dayDate = new Date(dayData.date + 'T00:00:00Z');
                    const dayOfWeek = dayDate.getUTCDay();

                    // Seitenumbruch prüfen
                    const spaceNeededForRest = TABLE_ROW_HEIGHT + summaryHeight + footerHeight;
                    if (doc.y + spaceNeededForRest > doc.page.height - doc.page.margins.bottom && i > 0) {
                        drawFooter(doc, doc.page.height - doc.page.margins.bottom - footerHeight + V_SPACE.MEDIUM); // Footer auf alter Seite
                        doc.addPage();
                        currentY = doc.page.margins.top; // Nur Header zeichnen
                        const tableLayout = drawTableHeader(doc, currentY, usableWidth);
                        currentY = tableLayout.headerBottomY;
                        doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5);
                        doc.y = currentY; // Y-Position für Inhalt auf neuer Seite setzen
                    } else if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - summaryHeight - footerHeight) {
                         // Fall: Nicht genug Platz für Zeile + Summary + Footer
                         drawFooter(doc, doc.page.height - doc.page.margins.bottom - footerHeight + V_SPACE.MEDIUM);
                         doc.addPage();
                         currentY = doc.page.margins.top;
                         const tableLayout = drawTableHeader(doc, currentY, usableWidth);
                         currentY = tableLayout.headerBottomY;
                         doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5);
                         doc.y = currentY;
                    }


                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const startDisplay = dayData.startTime || "--:--";
                    const endDisplay = dayData.endTime || "--:--";
                    const actualHours = dayData.actualHours || 0; // Ist (gearbeitet oder gutgeschrieben)

                    // Soll-Stunden für diesen Tag holen (ignorieren bei Abwesenheit, da Soll in Summe angepasst wurde)
                    const expectedHours = getExpectedHours(data, dayData.date); // Holt Standard-Soll
                     // Diff nur anzeigen, wenn gearbeitet wurde oder es ein Feiertag an einem Arbeitstag war? Oder immer? Hier: immer basierend auf Standard-Soll vs Ist/Gutschrift
                     const diffHours = actualHours - expectedHours;

                     // Überschreiben Anzeige bei Abwesenheit
                     let startOverride = startDisplay;
                     let endOverride = endDisplay;
                     if (dayData.type !== 'WORK') {
                         startOverride = '--:--';
                         endOverride = dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag');
                     }


                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours);
                    const diffStr = decimalHoursToHHMM(diffHours);

                    const currentRowY = doc.y;
                    const textOptions = { align: 'center', lineBreak: false }; // Standardmäßig zentriert

                    doc.text(dateFormatted, colPositions.date, currentRowY, { ...textOptions, width: colWidths.date, align: 'left' });
                    doc.text(startOverride, colPositions.start, currentRowY, { ...textOptions, width: colWidths.start });
                    doc.text(endOverride, colPositions.end, currentRowY, { ...textOptions, width: colWidths.end });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { ...textOptions, width: colWidths.expected });
                    doc.text(actualStr, colPositions.actual, currentRowY, { ...textOptions, width: colWidths.actual });
                    doc.text(diffStr, colPositions.diff, currentRowY, { ...textOptions, width: colWidths.diff });

                    doc.y += TABLE_ROW_HEIGHT; // Zeilenhöhe erhöhen
                }
            }
            currentY = doc.y + V_SPACE.LARGE; // Abstand nach Tabelle

            // Zusammenfassung
            // Prüfen, ob genug Platz für Zusammenfassung + Footer
             if (currentY + summaryHeight + footerHeight > doc.page.height - doc.page.margins.bottom) {
                 doc.addPage();
                 currentY = doc.page.margins.top;
             }
             doc.y = currentY; // Setze Y-Position für Zusammenfassung

             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
             const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - V_SPACE.SMALL;
             const summaryValueWidth = colWidths.actual + colWidths.diff;
             const summaryLabelX = doc.page.margins.left;
             const summaryValueX = colPositions.actual;
             const summaryLineSpacing = 0.2;

             doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);

             doc.text("Gesamt Soll-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);

             doc.text("Gesamt Ist-Zeit (Monat):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
              doc.font(FONT_NORMAL); // Kleinere Info: Gearbeitet/Abwesenheit
              doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHours)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHours)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth -10, align: 'left'});
              doc.moveDown(summaryLineSpacing+0.3); // Etwas mehr Platz danach
              doc.font(FONT_BOLD);

             const totalDiff = (data.totalActual || 0) - (data.totalExpected || 0);
             doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);

             doc.font(FONT_BOLD); // Fett für Saldo
             doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

             currentY = doc.y + V_SPACE.LARGE; // Y nach Zusammenfassung


            // Footer
            drawFooter(doc, currentY);

            // PDF abschließen
            doc.end();

        } catch (err) {
            console.error("Fehler beim Erstellen des Monats-PDFs:", err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler beim Erstellen des Monats-PDFs: ${err.message}`);
            } else {
                console.error("Monats-PDF Header bereits gesendet.");
                if (doc && !doc.writableEnded) doc.end();
            }
        }
    });


    /**
     * NEU: GET /create-period-pdf
     * Erzeugt PDF für ein Quartal oder Jahr.
     */
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, periodType, periodValue } = req.query;

            // Validierung
            if (!name || !year || isNaN(parseInt(year)) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) {
                return res.status(400).send("Name, Jahr und periodType ('QUARTER' oder 'YEAR') erforderlich.");
            }
            if (periodType.toUpperCase() === 'QUARTER' && (!periodValue || isNaN(parseInt(periodValue)) || periodValue < 1 || periodValue > 4)) {
                return res.status(400).send("Für periodType 'QUARTER' ist ein gültiger periodValue (1-4) erforderlich.");
            }
             const parsedYear = parseInt(year, 10);


            // Periodendaten berechnen (nutzt aktualisierte Funktion)
            const data = await calculatePeriodData(db, name, year, periodType.toUpperCase(), periodValue);

            // PDF Dokument erstellen
            const doc = new PDFDocument(PAGE_OPTIONS);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const periodLabelFile = data.periodIdentifier || (periodType === 'QUARTER' ? `Q${periodValue}` : 'Jahr');
            const filename = `Nachweis_${periodLabelFile}_${safeName}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            // --- Layout ---
            const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const title = periodType === 'QUARTER'
                ? `Quartalsnachweis ${data.periodIdentifier}/${parsedYear}`
                : `Jahresnachweis ${parsedYear}`;

            let currentY = drawDocumentHeader(doc, title, data.employeeName, data.periodStartDate, data.periodEndDate);

            const { headerBottomY, colWidths, colPositions } = drawTableHeader(doc, currentY, usableWidth);
            currentY = headerBottomY;

            // Tabelleninhalt
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5);
            doc.y = currentY;

            const footerHeight = FONT_SIZE.FOOTER + V_SPACE.SIGNATURE_GAP + 1 + V_SPACE.SMALL + FONT_SIZE.FOOTER;
             // Höhe für Zusammenfassung (Periodenversion)
            const summaryHeight = 5 * (FONT_SIZE.SUMMARY + V_SPACE.TINY) + V_SPACE.LARGE;


             // Generiere die Zeilen basierend auf Arbeitstagen UND Abwesenheitstagen für den Zeitraum
             const allDaysPeriod = [];
             // 1. Arbeitseinträge hinzufügen
             data.workEntriesPeriod.forEach(entry => {
                 const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date);
                 allDaysPeriod.push({
                     date: dateStr, type: 'WORK', startTime: entry.startTime, endTime: entry.endTime,
                     actualHours: parseFloat(entry.hours) || 0, comment: entry.comment
                 });
             });
              // 2. Abwesenheitseinträge hinzufügen
             data.absenceEntriesPeriod.forEach(absence => {
                  const dateStr = (absence.date instanceof Date) ? absence.date.toISOString().split('T')[0] : String(absence.date);
                  if (!allDaysPeriod.some(d => d.date === dateStr)) {
                       allDaysPeriod.push({
                           date: dateStr, type: absence.type, startTime: '--:--', endTime: '--:--',
                           actualHours: parseFloat(absence.hours) || 0,
                           comment: absence.type === 'VACATION' ? 'Urlaub' : (absence.type === 'SICK' ? 'Krank' : 'Feiertag')
                       });
                  }
             });
             // 3. Sortieren nach Datum
             allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            if (allDaysPeriod.length === 0) {
                doc.text('Keine Buchungen oder Abwesenheiten in diesem Zeitraum gefunden.', doc.page.margins.left, doc.y, { width: usableWidth });
                doc.y += TABLE_ROW_HEIGHT;
            } else {
                 for (let i = 0; i < allDaysPeriod.length; i++) {
                    const dayData = allDaysPeriod[i];
                    const dayDate = new Date(dayData.date + 'T00:00:00Z');
                    const dayOfWeek = dayDate.getUTCDay();

                    // Seitenumbruch prüfen (wie im Monats-PDF)
                    const spaceNeededForRest = TABLE_ROW_HEIGHT + summaryHeight + footerHeight;
                     if (doc.y + spaceNeededForRest > doc.page.height - doc.page.margins.bottom && i > 0) {
                         drawFooter(doc, doc.page.height - doc.page.margins.bottom - footerHeight + V_SPACE.MEDIUM);
                         doc.addPage();
                         currentY = doc.page.margins.top;
                         const tableLayout = drawTableHeader(doc, currentY, usableWidth);
                         currentY = tableLayout.headerBottomY;
                         doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5);
                         doc.y = currentY;
                     } else if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - summaryHeight - footerHeight) {
                          drawFooter(doc, doc.page.height - doc.page.margins.bottom - footerHeight + V_SPACE.MEDIUM);
                          doc.addPage();
                          currentY = doc.page.margins.top;
                          const tableLayout = drawTableHeader(doc, currentY, usableWidth);
                          currentY = tableLayout.headerBottomY;
                          doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).lineGap(-0.5);
                          doc.y = currentY;
                     }


                    const dateFormatted = formatDateGermanWithWeekday(dayData.date);
                    const actualHours = dayData.actualHours || 0;
                    const expectedHours = getExpectedHours(data, dayData.date); // Standard-Soll holen
                    const diffHours = actualHours - expectedHours;

                     let startOverride = dayData.startTime || "--:--";
                     let endOverride = dayData.endTime || "--:--";
                     if (dayData.type !== 'WORK') {
                         startOverride = '--:--';
                         endOverride = dayData.type === 'VACATION' ? 'Urlaub' : (dayData.type === 'SICK' ? 'Krank' : 'Feiertag');
                     }

                    const expectedStr = decimalHoursToHHMM(expectedHours);
                    const actualStr = decimalHoursToHHMM(actualHours);
                    const diffStr = decimalHoursToHHMM(diffHours);

                    const currentRowY = doc.y;
                    const textOptions = { align: 'center', lineBreak: false };

                    doc.text(dateFormatted, colPositions.date, currentRowY, { ...textOptions, width: colWidths.date, align: 'left' });
                    doc.text(startOverride, colPositions.start, currentRowY, { ...textOptions, width: colWidths.start });
                    doc.text(endOverride, colPositions.end, currentRowY, { ...textOptions, width: colWidths.end });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { ...textOptions, width: colWidths.expected });
                    doc.text(actualStr, colPositions.actual, currentRowY, { ...textOptions, width: colWidths.actual });
                    doc.text(diffStr, colPositions.diff, currentRowY, { ...textOptions, width: colWidths.diff });

                    doc.y += TABLE_ROW_HEIGHT;
                 }
            }
             currentY = doc.y + V_SPACE.LARGE;

            // Zusammenfassung (Periodenversion)
             if (currentY + summaryHeight + footerHeight > doc.page.height - doc.page.margins.bottom) {
                 doc.addPage();
                 currentY = doc.page.margins.top;
             }
             doc.y = currentY;

             doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY);
             const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - V_SPACE.SMALL;
             const summaryValueWidth = colWidths.actual + colWidths.diff;
             const summaryLabelX = doc.page.margins.left;
             const summaryValueX = colPositions.actual;
             const summaryLineSpacing = 0.2;
             const periodLabelSummary = data.periodIdentifier || periodType; // Z.B. 'Q2' oder 'Jahr'

             doc.text("Übertrag Periodenbeginn (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.startingBalance || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);

             doc.text(`Gesamt Soll-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.totalExpectedPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);

             doc.text(`Gesamt Ist-Zeit (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.totalActualPeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
              doc.font(FONT_NORMAL);
              doc.text(`(davon gearb.: ${decimalHoursToHHMM(data.workedHoursPeriod)}, Abwesenh.: ${decimalHoursToHHMM(data.absenceHoursPeriod)})`, summaryLabelX + 10, doc.y, {width: summaryLabelWidth-10, align: 'left'});
              doc.moveDown(summaryLineSpacing+0.3);
              doc.font(FONT_BOLD);

             doc.text(`Gesamt Mehr/Minderstunden (${periodLabelSummary}):`, summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.periodDifference || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);

             doc.font(FONT_BOLD);
             doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
             doc.text(decimalHoursToHHMM(data.endingBalancePeriod || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });

             currentY = doc.y + V_SPACE.LARGE;


            // Footer
            drawFooter(doc, currentY);

            // PDF abschließen
            doc.end();

        } catch (err) {
            console.error("Fehler beim Erstellen des Perioden-PDFs:", err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler beim Erstellen des Perioden-PDFs: ${err.message}`);
            } else {
                console.error("Perioden-PDF Header bereits gesendet.");
                 if (doc && !doc.writableEnded) doc.end();
            }
        }
    });


    return router;
};
