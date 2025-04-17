// ======================================================
// ROUTER DEFINITION
// ======================================================
module.exports = function(db) {

    // --- Route für Monats-PDF ---
    router.get('/create-monthly-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, month } = req.query;
            if (!name || !year || !month || isNaN(+year) || isNaN(+month) || month < 1 || month > 12) { return res.status(400).send('Parameter fehlen oder ungültig.'); }

            const y = +year; const m = +month;
            const data = await calculateMonthlyData(db, name, y, m);
            if (!data) throw new Error('Daten für PDF konnten nicht abgerufen werden.');

            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');

            const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2, '0')}_${y}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0; page++; doc.addPage();
            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const bottomMarginY = doc.page.height - doc.page.margins.bottom; // NEU: Unteren Rand berechnen

            let yPos = drawDocumentHeader(doc, `Monatsnachweis ${String(m).padStart(2, '0')}/${y}`, data.employeeName, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0)));
            // drawPageNumber(doc, page); // Seitennummerierung ggf. aktivieren

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDays = [];
            data.workEntries.forEach(e => allDays.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
            data.absenceEntries.forEach(a => { if (!allDays.find(d => d.date === a.date)) { allDays.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment }); } });
            allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Tägliche Tabelle zeichnen
            allDays.forEach((d, i) => {
                // GEÄNDERT: Seitenumbruch-Prüfung berücksichtigt NICHT mehr den Footer vorab
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > bottomMarginY)) {
                    page++;
                    doc.addPage();
                    // drawPageNumber(doc, page); // Seitennummerierung ggf. aktivieren
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                }
                const currentLineY = doc.y;

                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--'; let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center';
                let actualAlign = 'center'; let diffAlign = 'center';
                if (d.type === 'WORK') { sStart = d.start || '--:--'; sEnd = d.end || '--:--'; endAlign = 'center'; }
                else { sEnd = translateAbsenceType(d.type); }
                const sExp = decimalHoursToHHMM(expH);
                const sAct = decimalHoursToHHMM(actH); const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;

                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });
                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Horizontale Linie
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                    .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });


            // --- NEU: Verbesserte Platzierung von Zusammenfassung & Footer ---
            const requiredFinalHeight = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT;
            let finalBlockStartY = doc.y + V_SPACE.LARGE; // Potentielle Start-Y mit Abstand
            let needsNewPageForFinalBlock = false;

            if (finalBlockStartY + requiredFinalHeight > bottomMarginY) {
               needsNewPageForFinalBlock = true;
               page++;
               doc.addPage();
               // drawPageNumber(doc, page); // Seitennummerierung ggf. aktivieren
               finalBlockStartY = doc.page.margins.top;
               doc.y = finalBlockStartY; // Wichtig: Aktuelle Y-Position auf neue Seite setzen
            } else {
               doc.y = finalBlockStartY; // Genug Platz, Y-Position mit Abstand setzen
            }

            // NEU: Optionaler Puffer, wenn neue Seite fast leer wäre
            const availableSpaceOnPage = bottomMarginY - doc.y;
            if (needsNewPageForFinalBlock && availableSpaceOnPage > requiredFinalHeight * 1.5) { // Heuristik: Deutlich mehr Platz als nötig?
                 doc.moveDown(1); // Fügt etwas vertikalen Abstand hinzu
            }
            // --- Ende der neuen Platzierungslogik ---


            // --- Zusammenfassung zeichnen (beginnt jetzt an der berechneten Position doc.y) ---
            // const summaryYStart = doc.y; // Nicht mehr nötig, doc.y ist korrekt
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
            const gearbStdM = decimalHoursToHHMM(data.workedHours); const abwesStdM = decimalHoursToHHMM(data.absenceHours);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY_DETAIL).fillColor('black');
            doc.text(`(davon gearb.: ${gearbStdM}, Abwesenh.: ${abwesStdM})`, left + V_SPACE.MEDIUM, doc.y, { width: lblW });
            doc.moveDown(0.5);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            doc.text('Gesamt Mehr/Minderstunden:', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.totalDifference), valX, doc.y, { width: valW, align: 'right' });
            doc.moveDown(0.5);
            doc.text('Neuer Übertrag (Saldo Ende):', left, doc.y, { width: lblW });
            doc.text(decimalHoursToHHMM(data.newCarryOver), valX, doc.y, { width: valW, align: 'right' });

            // Footer zeichnen (startet relativ zum Ende der Zusammenfassung)
            // Der V_SPACE.LARGE Abstand wird *vor* dem Footer durch doc.y berücksichtigt
            drawSignatureFooter(doc, doc.y + V_SPACE.LARGE); // V_SPACE.LARGE hier beibehalten für Abstand nach Zusammenfassung

            doc.end();
            console.log(`[PDF Monthly] Generierung für ${name} abgeschlossen und gesendet.`);
        } catch (err) { /* Fehlerbehandlung */ console.error('[PDF Monthly] Kritischer Fehler:', err);
            if (!res.headersSent) { res.status(500).send(`Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`); }
        }
    });


    // --- Route für Perioden-PDF (Quartal/Jahr) MIT TABELLE ---
    router.get('/create-period-pdf', isAdmin, async (req, res) => {
        try {
            const { name, year, periodType, periodValue } = req.query;
            if (!name || !year || isNaN(+year) || !periodType || !['QUARTER', 'YEAR'].includes(periodType.toUpperCase())) { return res.status(400).send('Parameter fehlen oder ungültig.'); }
            const y = +year; const pType = periodType.toUpperCase(); let pValue = periodValue ? parseInt(periodValue) : null;
            if (pType === 'QUARTER' && (isNaN(pValue) || pValue < 1 || pValue > 4)) { return res.status(400).send('Ungültiger periodValue (1-4) für QUARTER erforderlich.'); }
            const data = await calculatePeriodData(db, name, y, pType, pValue);
            if (!data) throw new Error('Daten für Perioden-PDF konnten nicht abgerufen werden.');

            const doc = new PDFDocument(PAGE_OPTIONS);
            doc.pipe(res);
            const safeName = (data.employeeName || 'Unbekannt').replace(/[^a-z0-9_\-]/gi, '_');
            let periodDesc = ''; let titleDesc = '';
            if (pType === 'QUARTER') { periodDesc = `Q${pValue}_${y}`; titleDesc = `Quartalsübersicht ${data.periodIdentifier}/${y}`; }
            else { periodDesc = `Jahr_${y}`; titleDesc = `Jahresübersicht ${y}`; }
            const filename = `Bericht_${periodDesc}_${safeName}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            let page = 0; page++; doc.addPage();
            const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;
            const bottomMarginY = doc.page.height - doc.page.margins.bottom; // NEU: Unteren Rand berechnen

            let yPos = drawDocumentHeader(doc, titleDesc, data.employeeName, new Date(data.periodStartDate + 'T00:00:00Z'), new Date(data.periodEndDate + 'T00:00:00Z'));
            // drawPageNumber(doc, page); // Seitennummerierung ggf. aktivieren

            const table = drawTableHeader(doc, yPos, uW);
            yPos = table.headerBottomY;
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
            doc.y = yPos;

            const allDaysPeriod = [];
            data.workEntriesPeriod.forEach(e => allDaysPeriod.push({ date: e.date, type: 'WORK', start: e.startTime, end: e.endTime, actual: +e.hours || 0 }));
            data.absenceEntriesPeriod.forEach(a => { if (!allDaysPeriod.find(d => d.date === a.date)) { allDaysPeriod.push({ date: a.date, type: a.type, actual: +a.hours || 0, comment: a.comment }); } });
            allDaysPeriod.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Tägliche Tabelle zeichnen
            allDaysPeriod.forEach((d, i) => {
                 // GEÄNDERT: Seitenumbruch-Prüfung berücksichtigt NICHT mehr den Footer vorab
                if (i > 0 && (doc.y + TABLE_ROW_HEIGHT > bottomMarginY)) {
                    page++;
                    doc.addPage();
                    // drawPageNumber(doc, page); // Seitennummerierung ggf. aktivieren
                    const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
                    doc.y = nextTable.headerBottomY;
                    doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black');
                 }
                const currentLineY = doc.y;

                const expH = getExpectedHours(data.employeeData, d.date);
                const actH = d.actual;
                const diffH = actH - expH;
                const sDate = formatDateGermanWithWeekday(d.date);
                let sStart = '--:--'; let sEnd = '--:--';
                let endAlign = 'left'; let startAlign = 'center';
                let expectedAlign = 'center';
                let actualAlign = 'center'; let diffAlign = 'center';
                if (d.type === 'WORK') { sStart = d.start || '--:--'; sEnd = d.end || '--:--'; endAlign = 'center'; }
                else { sEnd = translateAbsenceType(d.type); }
                const sExp = decimalHoursToHHMM(expH);
                const sAct = decimalHoursToHHMM(actH); const sDiff = decimalHoursToHHMM(diffH);
                const p = table.colPositions; const w = table.colWidths;

                doc.fillColor('black');
                doc.text(sDate,    p.date,     currentLineY, { width: w.date });
                doc.text(sStart,   p.start,    currentLineY, { width: w.start,    align: startAlign });
                doc.text(sEnd,     p.end,      currentLineY, { width: w.end,      align: endAlign });
                doc.text(sExp,     p.expected, currentLineY, { width: w.expected, align: expectedAlign });
                doc.text(sAct,     p.actual,   currentLineY, { width: w.actual,   align: actualAlign });
                doc.text(sDiff,    p.diff,     currentLineY, { width: w.diff,     align: diffAlign });
                doc.y = currentLineY + TABLE_ROW_HEIGHT;

                // Horizontale Linie
                doc.save().lineWidth(0.25).strokeColor('#dddddd')
                   .moveTo(left, doc.y - V_SPACE.SMALL).lineTo(left + uW, doc.y - V_SPACE.SMALL).stroke().restore();
            });


             // --- NEU: Verbesserte Platzierung von Zusammenfassung & Footer ---
             const requiredFinalHeight = SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT; // Ggf. anpassen, falls Perioden-Zusammenfassung andere Höhe hat (hier vereinfacht angenommen)
             let finalBlockStartY = doc.y + V_SPACE.LARGE; // Potentielle Start-Y mit Abstand
             let needsNewPageForFinalBlock = false;

             if (finalBlockStartY + requiredFinalHeight > bottomMarginY) {
                needsNewPageForFinalBlock = true;
                page++;
                doc.addPage();
                // drawPageNumber(doc, page); // Seitennummerierung ggf. aktivieren
                finalBlockStartY = doc.page.margins.top;
                doc.y = finalBlockStartY; // Wichtig: Aktuelle Y-Position auf neue Seite setzen
             } else {
                doc.y = finalBlockStartY; // Genug Platz, Y-Position mit Abstand setzen
             }

             // NEU: Optionaler Puffer, wenn neue Seite fast leer wäre
             const availableSpaceOnPage = bottomMarginY - doc.y;
             // Prüfen, ob die Zusammenfassung selbst schon eine Mindesthöhe hat (hier Annahme SUMMARY_TITLE Höhe)
             const periodSummaryTitleHeight = FONT_SIZE.SUMMARY_TITLE + (1.5 * doc.currentLineHeight()); // Abschätzung
             const effectiveRequiredHeight = Math.max(requiredFinalHeight, periodSummaryTitleHeight + FOOTER_TOTAL_HEIGHT); // Mindesthöhe berücksichtigen

             if (needsNewPageForFinalBlock && availableSpaceOnPage > effectiveRequiredHeight * 1.5) { // Heuristik: Deutlich mehr Platz als nötig?
                  doc.moveDown(1); // Fügt etwas vertikalen Abstand hinzu
             }
            // --- Ende der neuen Platzierungslogik ---


            // --- Zusammenfassung zeichnen (beginnt jetzt an der berechneten Position doc.y) ---
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY_TITLE).fillColor('black');
            doc.text(`Zusammenfassung für ${data.periodIdentifier} ${y}`, left, doc.y, { align: 'left' });
            doc.moveDown(1.5); // Abstand nach Titel
            const periodLblW = 250;
            const periodValX = left + periodLblW + V_SPACE.MEDIUM; const periodValW = uW - periodLblW - V_SPACE.MEDIUM;
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
            const gearbStdP = decimalHoursToHHMM(data.workedHoursPeriod); const abwesStdP = decimalHoursToHHMM(data.absenceHoursPeriod);
            doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUMMARY_DETAIL).fillColor('black');
            doc.text(`(davon gearb.: ${gearbStdP}, Abwesenh.: ${abwesStdP})`, left + V_SPACE.MEDIUM, doc.y, { width: periodLblW });
            doc.moveDown(0.7);
            doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
            doc.text(`Differenz (${data.periodIdentifier}):`, left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.periodDifference), periodValX, doc.y, { width: periodValW, align: 'right' });
            doc.moveDown(0.7);
            doc.text('Neuer Übertrag (Saldo Periodenende):', left, doc.y, { width: periodLblW });
            doc.text(decimalHoursToHHMM(data.endingBalancePeriod), periodValX, doc.y, { width: periodValW, align: 'right' });

            // Footer zeichnen (startet relativ zum Ende der Zusammenfassung)
             // Der V_SPACE.XLARGE Abstand wird *vor* dem Footer durch doc.y berücksichtigt
            drawSignatureFooter(doc, doc.y + V_SPACE.XLARGE); // V_SPACE.XLARGE hier beibehalten für größeren Abstand nach Perioden-Zusammenfassung

            doc.end();
            console.log(`[PDF Period] Generierung für ${name} abgeschlossen und gesendet.`);
        } catch (err) { /* Fehlerbehandlung */ console.error('[PDF Period] Kritischer Fehler:', err);
            if (!res.headersSent) { res.status(500).send(`Fehler bei der PDF-Erstellung auf dem Server. (${err.message || 'Unbekannter interner Fehler'})`); }
        }
    });

    return router;
};
