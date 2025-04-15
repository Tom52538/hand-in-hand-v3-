const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// Importiere die Berechnungsfunktion aus calculationUtils.js
const { calculateMonthlyData } = require('../utils/calculationUtils');

/**
 * Hilfsfunktion: Wandelt Dezimalstunden in ein HH:MM-Format um.
 */
function decimalHoursToHHMM(decimalHours) {
    if (isNaN(decimalHours) || decimalHours === null) {
        return "00:00";
    }
    const sign = decimalHours < 0 ? "-" : "";
    const absHours = Math.abs(decimalHours);
    const totalMinutes = Math.round(absHours * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Middleware: Prüft, ob eine Admin-Session vorliegt.
 */
function isAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        next();
    } else {
        console.warn(
            `PDF Route: isAdmin-Check fehlgeschlagen: Session ID: ${req.sessionID}, ` +
            `isAdmin: ${req.session ? req.session.isAdmin : 'keine Session'}`
        );
        res.status(403).send('Zugriff verweigert. Admin-Rechte erforderlich für PDF-Download.');
    }
}

module.exports = function (db) {
    /**
     * GET-Endpunkt /create-monthly-pdf:
     * Erzeugt eine PDF-Datei mit dem gewünschten Layout.
     */
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month) {
                return res.status(400).send("Name, Jahr und Monat erforderlich.");
            }

            // Monatsdaten berechnen
            const monthlyData = await calculateMonthlyData(db, name, year, month);
            const {
                employeeName,
                previousCarryOver,
                totalExpected,
                totalActual,
                newCarryOver,
                workEntries
            } = monthlyData;
            const parsedYear = parseInt(year, 10);
            const parsedMonth = parseInt(month, 10);

            // PDF-Dokument erstellen
            const doc = new PDFDocument({
                size: 'A4',
                margins: {
                    top: 25,
                    bottom: 25,
                    left: 40,
                    right: 40
                }
            });
            const safeName = (employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            const filename = `Ueberstundennachweis_${safeName}_${String(parsedMonth).padStart(2, '0')}_${parsedYear}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            doc.pipe(res);

            // --- Layout Konstanten ---
            const pageTopMargin = doc.page.margins.top;
            const pageLeftMargin = doc.page.margins.left;
            const pageRightMargin = doc.page.margins.right;
            const pageBottomMargin = doc.page.margins.bottom;
            const usableWidth = doc.page.width - pageLeftMargin - pageRightMargin;

            const fontNormal = 'Helvetica';
            const fontBold = 'Helvetica-Bold';

            const fontSizeHeader = 16;
            const fontSizeSubHeader = 11;
            const fontSizeTableHeader = 9;
            const fontSizeTableContent = 9;
            const fontSizeSummary = 8;
            const fontSizeFooter = 8;

            const vSpaceTiny = 1;
            const vSpaceSmall = 4;
            const vSpaceMedium = 10;
            const vSpaceLarge = 18;
            const vSpaceSignatureGap = 45;
            const tableRowHeight = 10; // *** ALLERLETZTE REDUZIERUNG DER ZEILENHÖHE ***

            //-------------------------------
            // Kopfzeile (Abstand nach Titel/Logo bereits minimal)
            //-------------------------------
            let currentY = pageTopMargin;
            const logoPath = path.join(process.cwd(), 'public', 'icons', 'Hand-in-Hand-Logo-192x192.png');
            const logoWidth = 95;
            const logoHeight = 95;
            const logoX = doc.page.width - pageRightMargin - logoWidth;
            const logoY = currentY;
            try { doc.image(logoPath, logoX, logoY, { width: logoWidth, height: logoHeight }); } catch (errLogo) { console.warn("Logo konnte nicht geladen werden:", errLogo); }
            doc.font(fontBold).fontSize(fontSizeHeader);
            doc.text("Überstundennachweis", pageLeftMargin, currentY + vSpaceTiny, { align: 'center', width: usableWidth });
            currentY = Math.max(currentY + fontSizeHeader + vSpaceTiny, logoY + logoHeight);
            // Kein zusätzlicher Abstand hier!
            doc.font(fontNormal).fontSize(fontSizeSubHeader);
            doc.text(`Name: ${employeeName}`, pageLeftMargin, currentY); // Startet direkt unter Logo/Titel
            currentY += fontSizeSubHeader + vSpaceSmall;
            const firstDay = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
            const lastDay = new Date(Date.UTC(parsedYear, parsedMonth, 0));
            const firstDayStr = firstDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
            const lastDayStr = lastDay.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
            doc.text(`Zeitraum: ${firstDayStr} - ${lastDayStr}`, pageLeftMargin, currentY);
            currentY += fontSizeSubHeader + vSpaceLarge;

            //-------------------------------
            // Tabelle
            //-------------------------------
            const tableStartY = currentY;
            const colWidths = { date: 115, start: 75, end: 75, expected: 85, actual: 85, diff: usableWidth - 115 - 75 - 75 - 85 - 85 };
            const colPositions = { date: pageLeftMargin, start: pageLeftMargin + colWidths.date, end: pageLeftMargin + colWidths.date + colWidths.start, expected: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end, actual: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected, diff: pageLeftMargin + colWidths.date + colWidths.start + colWidths.end + colWidths.expected + colWidths.actual };

            const drawTableHeader = (yPos) => {
                doc.font(fontBold).fontSize(fontSizeTableHeader);
                const headerTextY = yPos + vSpaceSmall / 2;
                doc.text("Datum", colPositions.date, headerTextY, { width: colWidths.date, align: 'left' });
                doc.text("Arbeits-\nbeginn", colPositions.start, headerTextY, { width: colWidths.start, align: 'center' });
                doc.text("Arbeits-\nende", colPositions.end, headerTextY, { width: colWidths.end, align: 'center' });
                doc.text("Soll-Zeit\n(HH:MM)", colPositions.expected, headerTextY, { width: colWidths.expected, align: 'center' });
                doc.text("Ist-Zeit\n(HH:MM)", colPositions.actual, headerTextY, { width: colWidths.actual, align: 'center' });
                doc.text("Mehr/Minder\nStd. (HH:MM)", colPositions.diff, headerTextY, { width: colWidths.diff, align: 'center' });
                const headerBottomY = yPos + (fontSizeTableHeader * 2) + vSpaceSmall;
                doc.moveTo(pageLeftMargin, headerBottomY).lineTo(pageLeftMargin + usableWidth, headerBottomY).lineWidth(0.5).stroke();
                return headerBottomY + vSpaceMedium - 2;
            };
            currentY = drawTableHeader(currentY);

            doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(-0.5);
            let contentStartY = currentY;
            doc.y = contentStartY;

            const summaryLineHeight = fontSizeSummary + vSpaceTiny;
            const summaryHeight = 5 * summaryLineHeight + vSpaceLarge;
            const footerHeight = fontSizeFooter + vSpaceSignatureGap + 1 + vSpaceSmall + fontSizeFooter;

            if (!workEntries || workEntries.length === 0) {
                doc.text('Keine Arbeitszeitbuchungen in diesem Monat gefunden.', pageLeftMargin, currentY, { width: usableWidth });
                currentY += tableRowHeight;
            } else {
                for (let i = 0; i < workEntries.length; i++) {
                    const entry = workEntries[i];
                    // *** HIER WIRD DIE NEUE tableRowHeight für die Prüfung verwendet ***
                    const spaceNeededForRest = tableRowHeight + summaryHeight + footerHeight;

                    if (doc.y + spaceNeededForRest > doc.page.height - pageBottomMargin && i > 0) {
                        doc.addPage(); currentY = pageTopMargin; currentY = drawTableHeader(currentY);
                        doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(-0.5); doc.y = currentY;
                    } else if (doc.y + tableRowHeight > doc.page.height - pageBottomMargin) {
                        doc.addPage(); currentY = pageTopMargin; currentY = drawTableHeader(currentY);
                        doc.font(fontNormal).fontSize(fontSizeTableContent).lineGap(-0.5); doc.y = currentY;
                    }
                    let dateFormatted = "Ungült. Datum";
                    if (entry.date) { try { const dateStr = (entry.date instanceof Date) ? entry.date.toISOString().split('T')[0] : String(entry.date).split('T')[0]; const dateObj = new Date(dateStr + "T00:00:00Z"); if (!isNaN(dateObj.getTime())) { dateFormatted = dateObj.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }); if (dateFormatted.includes(',') && !dateFormatted.includes('.,')) { dateFormatted = dateFormatted.replace(',', '.,'); } } } catch (e) { console.error("Fehler Datum:", entry.date, e); dateFormatted = String(entry.date); } }
                    const startDisplay = entry.startTime || "--:--"; const endDisplay = entry.endTime || "--:--";
                    const expected = parseFloat(entry.expectedHours) || 0; const worked = parseFloat(entry.hours) || 0; const diff = worked - expected;
                    const expectedStr = decimalHoursToHHMM(expected); const workedStr = decimalHoursToHHMM(worked); const diffStr = decimalHoursToHHMM(diff);
                    const currentRowY = doc.y; const textOptions = { width: colWidths.date, align: 'left', lineBreak: false };
                    doc.text(dateFormatted, colPositions.date, currentRowY, textOptions);
                    doc.text(startDisplay, colPositions.start, currentRowY, { ...textOptions, width: colWidths.start, align: 'center' });
                    doc.text(endDisplay, colPositions.end, currentRowY, { ...textOptions, width: colWidths.end, align: 'center' });
                    doc.text(expectedStr, colPositions.expected, currentRowY, { ...textOptions, width: colWidths.expected, align: 'center' });
                    doc.text(workedStr, colPositions.actual, currentRowY, { ...textOptions, width: colWidths.actual, align: 'center' });
                    doc.text(diffStr, colPositions.diff, currentRowY, { ...textOptions, width: colWidths.diff, align: 'center' });
                    // *** Y-Position mit minimaler Höhe erhöhen ***
                    doc.y += tableRowHeight;
                }
            }
            currentY = doc.y;
            currentY += vSpaceLarge;

            //-------------------------------
            // Zusammenfassung (unverändert)
            //-------------------------------
            if (currentY + summaryHeight + footerHeight > doc.page.height - pageBottomMargin) {
                doc.addPage(); currentY = pageTopMargin;
            }
            doc.y = currentY;
            doc.font(fontBold).fontSize(fontSizeSummary);
            const summaryLabelWidth = colWidths.date + colWidths.start + colWidths.end + colWidths.expected - vSpaceSmall;
            const summaryValueWidth = colWidths.actual + colWidths.diff;
            const summaryLabelX = pageLeftMargin; const summaryValueX = colPositions.actual;
            const summaryLineSpacing = 0.2;
            doc.text("Übertrag Vormonat (+/-):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
            doc.text(decimalHoursToHHMM(previousCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text("Gesamt Soll-Zeit:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
            doc.text(decimalHoursToHHMM(totalExpected || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.text("Gesamt Ist-Zeit:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
            doc.text(decimalHoursToHHMM(totalActual || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            const totalDiff = (totalActual || 0) - (totalExpected || 0);
            doc.text("Gesamt Mehr/Minderstunden:", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
            doc.text(decimalHoursToHHMM(totalDiff), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' }); doc.moveDown(summaryLineSpacing);
            doc.font(fontBold);
            doc.text("Neuer Übertrag (Saldo Ende):", summaryLabelX, doc.y, { width: summaryLabelWidth, align: 'left' });
            doc.text(decimalHoursToHHMM(newCarryOver || 0), summaryValueX, doc.y, { width: summaryValueWidth, align: 'right' });
            currentY = doc.y + vSpaceLarge;

            //-------------------------------
            // Fußzeile (unverändert)
            //-------------------------------
            if (currentY + footerHeight > doc.page.height - pageBottomMargin) {
                 doc.addPage();
                 currentY = pageTopMargin;
            }
            doc.y = currentY; // Setze doc.y auf die Startposition des Footers
            doc.font(fontNormal).fontSize(fontSizeFooter);
            doc.text(
                "Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht wurden und rechtmäßig in Rechnung gestellt werden.",
                pageLeftMargin,
                doc.y, // Aktuelle Position
                { align: 'left', width: usableWidth }
            );
            doc.y += vSpaceSignatureGap; // Vergrößerter Abstand HIER
            const lineY = doc.y; // Y-Position für die Linie
            const lineStartX = pageLeftMargin;
            const lineEndX = pageLeftMargin + 200; // Länge der Linie (ca. 7cm)
            doc.moveTo(lineStartX, lineY).lineTo(lineEndX, lineY).lineWidth(0.5).stroke();
            doc.y += vSpaceSmall; // Kleiner Abstand unter die Linie
            doc.text("Datum, Unterschrift", pageLeftMargin, doc.y); // Text unterhalb der Linie platzieren

            // PDF abschließen
            doc.end();

        } catch (err) {
            console.error("Fehler beim Erstellen des PDFs:", err);
            if (!res.headersSent) {
                res.status(500).send("Fehler beim Erstellen des PDFs.");
            } else {
                console.error("PDF Header bereits gesendet, Fehler konnte nicht an Client gesendet werden.");
                if (doc && !doc.writableEnded) {
                    doc.end();
                }
            }
        }
    });

    return router;
};
