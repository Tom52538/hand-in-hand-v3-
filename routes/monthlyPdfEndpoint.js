// monthlyPdfEndpoint.js - V16: Mehr Zeilenabstand + Zentrierte Ausrichtung
// *** KORREKTUR SCHRITT 2: Vertikale Datenverteilung in Tabelle korrigiert (OK) ***
// *** OPTIMIERUNG: Look & Feel näher an Ziel.pdf angepasst (OK) ***
// *** FEATURE: Korrekte Darstellung von Abwesenheiten (OK) ***
// *** NEU: Zeilenabstand erhöht und Zeit/Diff-Spalten zentriert ***
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Berechnungsfunktionen importieren
const { calculateMonthlyData, getExpectedHours } = require('../utils/calculationUtils');

// --- Konstanten & Hilfsfunktionen ---
const FONT_NORMAL = 'Times-Roman';
const FONT_BOLD   = 'Times-Bold';
const PAGE_OPTIONS = {
  size: 'A4',
  autoFirstPage: false,
  margins: { top: 25, bottom: 35, left: 40, right: 40 }
};
const V_SPACE = { TINY: 0.5, SMALL: 3, MEDIUM: 8, LARGE: 15, SIGNATURE_GAP: 35 };
const FONT_SIZE = {
  HEADER: 16, SUB_HEADER: 11,
  TABLE_HEADER: 8.5, TABLE_CONTENT: 8.5,
  SUMMARY: 8.5, SUMMARY_DETAIL: 7.5, FOOTER: 8, PAGE_NUMBER: 8
};
// Zeilenhöhe wieder etwas erhöht für mehr Abstand
const TABLE_ROW_HEIGHT = 13; // Erhöht von 11 auf 13
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL;
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL;
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM;
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5;
const SUMMARY_DETAIL_LINE_HEIGHT = FONT_SIZE.SUMMARY_DETAIL + V_SPACE.TINY;
const SUMMARY_TOTAL_HEIGHT = (5 * SUMMARY_LINE_HEIGHT) + SUMMARY_DETAIL_LINE_HEIGHT + V_SPACE.MEDIUM + V_SPACE.SMALL;

// Hilfsfunktion zur Übersetzung von Abwesenheitstypen
function translateAbsenceType(type) {
    switch (type) {
        case 'VACATION': return 'Urlaub';
        case 'SICK': return 'Krank';
        case 'PUBLIC_HOLIDAY': return 'Feiertag';
        default: return type;
    }
}

// Konvertiert Dezimalstunden in HH:MM Format
function decimalHoursToHHMM(decimalHours) {
  if (isNaN(decimalHours) || decimalHours === null) return '00:00';
  const sign = decimalHours < 0 ? '-' : '';
  const absH = Math.abs(decimalHours);
  const totalMin = Math.round(absH * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// Formatiert Datum zu DD.MM.YYYY (UTC)
function formatDateGerman(dateInput) {
    if (!dateInput) return 'N/A';
    const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
    const d = new Date(str + 'T00:00:00Z');
    return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

// Formatiert Datum zu Wochentag., DD.MM.YYYY (UTC)
function formatDateGermanWithWeekday(dateInput) {
    if (!dateInput) return 'N/A';
    const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
    const d = new Date(str + 'T00:00:00Z');
    return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).replace(/.$/, '.');
}

// Zeichnet den Dokumentenkopf (Titel, Name, Zeitraum, Logo)
function drawDocumentHeader(doc, title, name, startDate, endDate) {
    const left = doc.page.margins.left;
    const right = doc.page.margins.right;
    const width = doc.page.width - left - right;
    let y = doc.page.margins.top;

    try {
        const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
        doc.image(logoPath, doc.page.width - right - 70, y, { width: 70, height: 70 });
    } catch (e) {
        console.warn("Logo konnte nicht geladen/gezeichnet werden:", e.message);
    }

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).fillColor('black');
    doc.text(title, left, y + V_SPACE.SMALL, { align: 'center', width });
    y += V_SPACE.SMALL + doc.heightOfString(title, { width, align: 'center' }) + V_SPACE.LARGE;

    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
    doc.text(`Name: ${name || 'Unbekannt'}`, left, y);
    y += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL;
    doc.text(`Zeitraum: ${formatDateGerman(startDate)} - ${formatDateGerman(endDate)}`, left, y);

    return y + FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
}

// Zeichnet den Tabellenkopf
function drawTableHeader(doc, startY, usableWidth) {
    const left = doc.page.margins.left;
    const cols = { date: 95, start: 60, end: 75, expected: 70, actual: 70 };
    cols.diff = Math.max(40, usableWidth - Object.values(cols).reduce((a, b) => a + b, 0));
    const pos = { date: left };
    pos.start    = pos.date + cols.date;
    pos.end      = pos.start + cols.start;
    pos.expected = pos.end + cols.end;
    pos.actual   = pos.expected + cols.expected;
    pos.diff     = pos.actual + cols.actual;
    const headerHeight = (FONT_SIZE.TABLE_HEADER * 2) + V_SPACE.TINY + V_SPACE.SMALL;

    doc.save().fillColor('#eeeeee').rect(left, startY, usableWidth, headerHeight).fill().restore();
    doc.save().lineWidth(0.5).strokeColor('#cccccc');
    doc.moveTo(left, startY).lineTo(left + usableWidth, startY).stroke();
    doc.moveTo(left, startY + headerHeight).lineTo(left + usableWidth, startY + headerHeight).stroke();
    Object.values(pos).forEach(x => doc.moveTo(x, startY).lineTo(x, startY + headerHeight).stroke());
    doc.restore();

    doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER).fillColor('black');
    const yText = startY + V_SPACE.TINY;
    doc.text('Datum',             pos.date,     yText, { width: cols.date });
    doc.text('Arbeits-\nbeginn',    pos.start,    yText, { width: cols.start, align: 'center' }); // Header bleiben zentriert
    doc.text('Arbeits-\nende',     pos.end,      yText, { width: cols.end, align: 'center' });   // Header bleiben zentriert
    doc.text('Soll-Zeit\n(HH:MM)', pos.expected, yText, { width: cols.expected, align: 'center' }); // Header bleiben zentriert
    doc.text('Ist-Zeit\n(HH:MM)',  pos.actual,   yText, { width: cols.actual, align: 'center' });   // Header bleiben zentriert
    doc.text('Mehr/Minder\nStd.(HH:MM)', pos.diff, yText, { width: cols.diff, align: 'center' });   // Header bleiben zentriert

    return {
        headerBottomY: startY + headerHeight + V_SPACE.SMALL,
        colWidths: cols,
        colPositions: pos,
        headerHeight: headerHeight
    };
}

// Zeichnet die Seitennummer unten zentriert
function drawPageNumber(doc, pageNum) {
    const left = doc.page.margins.left;
    const bottomY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
        .text(`Seite ${pageNum}`, left, bottomY, { width, align: 'center' });
}

// Zeichnet den Fußzeilenbereich
function drawSignatureFooter(doc, startY) {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).fillColor('black');
    const text = 'Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden und rechtmäßig berücksichtigt werden.';
    doc.text(text, left, startY, { width });
    let y = startY + doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP;
    doc.moveTo(left, y).lineTo(left + 200, y).stroke();
    doc.text('Datum, Unterschrift', left, y + V_SPACE.SMALL);
}

// Middleware zur Prüfung von Admin-Rechten
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.');
    }
}

module.exports = function(db) {

    router.get('/test', (req, res) => res.send('PDF Route Test OK'));

    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(+year) || isNaN(+month) || month < 1 || month > 12) {
                return res.status(400).send('Parameter fehlen oder ungültig (name, year, month erforderlich).');
            }
            const y = +year; const m = +month;

            console.log(`[PDF] Anforderung für ${name}, ${String(m).padStart(2, '0')}/${y}`);
            const data = await calculateMonthlyData(db, name, y, m);
            if (!data) {
                console.error(`[PDF] Keine Daten für ${name}, ${String(m).padStart(2, '0')}/${y} gefunden.`);
                throw new Error('Daten für PDF konnten nicht abgerufen werden.');
            }
            console.log(`[PDF] Daten für ${name} erhalten. Beginne PDF-Generierung.`);

            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);

            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2, '0')}_${y}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0;
            page++;
            doc.addPage();

            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

            let yPos = drawDocumentHeader(doc,
                `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`,
                data.employeeName,
                new Date(Date.UTC(y, m - 1, 1)),
                new Date(Date.UTC(y, m, 0))
            );
            // drawPageNumber(doc, page);

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            // Schrift für Tabelleninhalt, lineGap entfernt für Standardabstand
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black'); // .lineGap(0.5) entfernt
            doc.y = yPos;

            const allDays = [];
            data.workEntries.forEach(e => allDays.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
            data.absenceEntries.forEach(a => {
                if (!allDays.find(d => d.date === a.date)) {
                    allDays.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment });
                }
            });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            const left = doc.page.margins.left;

            allDays.forEach((d, i) => {
                // Seitenumbruch-Logik
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - FOOTER_TOTAL_HEIGHT - SUMMARY_TOTAL_HEIGHT)) {
                    console.log(`[PDF] Seitenumbruch vor Zeile ${i + 1} (Datum: ${d.date}) bei Y=${doc.y}`);
                    page++;
                    doc.addPage();
                    // drawPageNumber(doc, page);
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black'); // Schrift zurücksetzen
                }

                // Werte für die aktuelle Zeile
                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--';
                let sEnd = '--:--';
                let endAlign = 'left'; // Standard für Abwesenheit
                // *** NEU: Ausrichtung für Zeitspalten standardmäßig auf 'center' ***
                let startAlign = 'center';
                let expectedAlign = 'center';
                let actualAlign = 'center';
                let diffAlign = 'center';

                if (d.type === 'WORK') {
                    sStart = d.start || '--:--';
                    sEnd = d.end || '--:--';
                    endAlign = 'center'; // Zeiten zentriert
                } else {
                    sEnd = translateAbsenceType(d.type);
                    // Bei Abwesenheit bleiben Soll/Ist/Diff zentriert, Start bleibt '----'
                }

                const sExp = decimalHoursToHHMM(expH);
                const sAct = decimalHoursToHHMM(actH);
                const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions;
                const w = table.colWidths;
                const currentLineY = doc.y;

                // *** Zellen zeichnen mit ZENTRIERTER Ausrichtung für Zeit/Diff-Spalten ***
                doc.text(sDate,    p.date,     currentLineY, { width: w.date }); // Datum bleibt linksbündig
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign }); // Zentriert
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });   // Zentriert (Zeit) oder Links (Abwesenheitstyp)
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign }); // Zentriert
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });   // Zentriert
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });     // Zentriert

                // Y-Position für die nächste Zeile setzen (berücksichtigt erhöhte TABLE_ROW_HEIGHT)
                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Horizontale Trennlinie
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                    .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore(); // Linie mit etwas mehr Abstand nach oben
            });

            // Rahmen um Tabelle
            const tableTopY = table.headerBottomY - table.headerHeight - V_SPACE.SMALL;
            const tableBottomY = doc.y - V_SPACE.SMALL; // Endet bei der letzten Linie
            doc.save().lineWidth(0.5).strokeColor('#999999')
                .rect(left, tableTopY, uW, tableBottomY - tableTopY).stroke().restore();

            // Zusammenfassung & Footer
            if (doc.y + SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT > doc.page.height - doc.page.margins.bottom) {
                console.log(`[PDF] Seitenumbruch vor Zusammenfassung bei Y=${doc.y}`);
                page++;
                doc.addPage();
                // drawPageNumber(doc, page);
                doc.y = doc.page.margins.top;
            } else {
                doc.y += V_SPACE.LARGE;
            }

            // Zusammenfassung
            const summaryYStart = doc.y;
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - V_SPACE.SMALL;
            const valX = table.colPositions.actual;
            const valW = table.colWidths.actual + table.colWidths.diff;

            doc.text('Übertrag Vormonat (+/-):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.previousCarryOver), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Gesamt Soll-Zeit (Monat):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalExpected), valX, doc.y, { width: valW, align: 'right' });
            const yAfterSoll = doc.y;
            doc.moveDown(0.5);
            doc.text('Gesamt Ist-Zeit (Monat):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalActual), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.1);
            const gearbStd = decimalHoursToHHMM(data.workedHours);
            const abwesStd = decimalHoursToHHMM(data.absenceHours);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY_DETAIL).fillColor('black');
            doc.text(`(davon gearb.: ${gearbStd}, Abwesenh.: ${abwesStd})`, left + V_SPACE.MEDIUM, doc.y, { width: lblW });
            doc.moveDown(0.5);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            doc.text('Gesamt Mehr/Minderstunden:', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalDifference), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Neuer Übertrag (Saldo Ende):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.newCarryOver), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);

            // Signatur-Footer
            drawSignatureFooter(doc, doc.y + V_SPACE.LARGE);

            doc.end();
            console.log(`[PDF] Generierung für ${name} abgeschlossen und gesendet.`);

        } catch (err) {
            console.error('[PDF] Kritischer Fehler bei PDF-Erstellung:', err);
            if (!res.headersSent) {
                res.status(500).send(`Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`);
            }
        }
    });

    return router;
};
