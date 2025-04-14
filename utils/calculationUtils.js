      // Tabelleninhalt
      let currentY = doc.y;
      doc.font('Helvetica').fontSize(9).lineGap(-1);

      // Falls keine Einträge vorhanden
      if (!workEntries || workEntries.length === 0) {
        doc.text('Keine Buchungen in diesem Monat gefunden.', col1X, currentY);
        doc.moveDown(2);
      } else {
        for (let i = 0; i < workEntries.length; i++) {
          const entry = workEntries[i];
          const rowY = doc.y; // Aktuelle Y-Position

          // Datum formatieren (z.B. Mo., 03.03.2025)
          let dateFormatted = "n.a.";
          if (entry.date) {
            try {
              const dateObj = new Date(entry.date.toString().split('T')[0] + "T00:00:00Z");
              dateFormatted = dateObj.toLocaleDateString('de-DE', {
                weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
                timeZone: 'UTC'
              });
            } catch (e) {
              dateFormatted = entry.date;
            }
          }

          // Zeiten formatieren
          const startDisplay = entry.startTime || "";
          const endDisplay   = entry.endTime || "";
          const workedHours  = parseFloat(entry.hours) || 0;
          const expected     = parseFloat(entry.expectedHours) || 0;

          // In HH:MM umwandeln
          const expectedStr = decimalHoursToHHMM(expected);
          const workedStr   = decimalHoursToHHMM(workedHours);
          const diffStr     = decimalHoursToHHMM(workedHours - expected);

          // Zeile eintragen
          doc.text(dateFormatted,     col1X, rowY, { width: col1Width, align: 'left' });
          doc.text(startDisplay,      col2X, rowY, { width: col2Width, align: 'center' });
          doc.text(endDisplay,        col3X, rowY, { width: col3Width, align: 'center' });
          doc.text(expectedStr,       col4X, rowY, { width: col4Width, align: 'center' });
          doc.text(workedStr,         col5X, rowY, { width: col5Width, align: 'center' });
          doc.text(diffStr,           col6X, rowY, { width: col6Width, align: 'center' });

          // Zeilenabstand
          doc.moveDown(1);

          // Falls das Seitenende naht, neue Seite erstellen
          if (doc.y > bottomMarginPos - 50) {
            doc.addPage();
            // Kopfzeile wiederholen
            doc.font('Helvetica-Bold').fontSize(10);
            doc.text("Datum",         col1X, doc.y, { width: col1Width, align: 'left' });
            doc.text("Arbeitsbeginn", col2X, doc.y, { width: col2Width, align: 'center' });
            doc.text("Arbeitsende",   col3X, doc.y, { width: col3Width, align: 'center' });
            doc.text("Soll-Zeit\n(HH:MM)", col4X, doc.y, { width: col4Width, align: 'center' });
            doc.text("Ist-Zeit\n(HH:MM)",  col5X, doc.y, { width: col5Width, align: 'center' });
            doc.text("Mehr/Minder\nStd. (HH:MM)", col6X, doc.y, { width: col6Width, align: 'center' });
            doc.moveDown(2);

            doc.moveTo(col1X, doc.y).lineTo(col6X + col6Width, doc.y).lineWidth(0.5).stroke();
            doc.moveDown(0.5);

            doc.font('Helvetica').fontSize(9).lineGap(-1);
          }
        }
      }

      // Abstand vor der Zusammenfassung
      doc.moveDown(1.5);

      // ------------------------------
      // Zusammenfassung: 4 Zeilen
      // * Übertrag Vormonat (+/-)
      // * Gesamt Soll-Zeit
      // * Gesamt Ist-Zeit
      // * Gesamt Mehr/Minderstunden
      // Beschriftung in Spalte 1, Werte in Spalte 5 (wie gewünscht)
      // ------------------------------
      doc.fontSize(10).font('Helvetica-Bold');

      const summaryLabelWidth = col4X - col1X; // Damit wir links Platz haben
      const summaryValueX = col5X; // Werte in Spalte 5
      const summaryLineHeight = doc.y; // Start-Y

      const previousCarryStr = decimalHoursToHHMM(previousCarryOver || 0);
      const totalExpectedStr = decimalHoursToHHMM(totalExpected || 0);
      const totalActualStr   = decimalHoursToHHMM(totalActual || 0);
      // Falls totalDifference nicht direkt verfügbar, berechnen wir (totalActual - totalExpected)
      const diff = (typeof totalDifference === 'number')
        ? totalDifference
        : (totalActual - totalExpected);
      const totalDiffStr = decimalHoursToHHMM(diff);

      // Zeile 1: Übertrag Vormonat (+/-)
      doc.text("Übertrag Vormonat (+/-):", col1X, summaryLineHeight, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(previousCarryStr, summaryValueX, summaryLineHeight, {
        width: col5Width, align: 'right'
      });
      // Zeile 2
      doc.moveDown(1);
      doc.text("Gesamt Soll-Zeit:", col1X, doc.y, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(totalExpectedStr, summaryValueX, doc.y, {
        width: col5Width, align: 'right'
      });
      // Zeile 3
      doc.moveDown(1);
      doc.text("Gesamt Ist-Zeit:", col1X, doc.y, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(totalActualStr, summaryValueX, doc.y, {
        width: col5Width, align: 'right'
      });
      // Zeile 4
      doc.moveDown(1);
      doc.text("Gesamt Mehr/Minderstunden:", col1X, doc.y, {
        width: summaryLabelWidth, align: 'left'
      });
      doc.text(totalDiffStr, summaryValueX, doc.y, {
        width: col5Width, align: 'right'
      });

      // Platz für Bestätigungstext
      doc.moveDown(3);
      doc.fontSize(9).font('Helvetica');
      doc.text(
        "Ich bestätige hiermit, dass die oben genannten Arbeitsstunden erbracht " +
        "wurden und rechtmäßig in Rechnung gestellt werden.",
        { align: 'left' }
      );

      doc.moveDown(3);
      doc.text("Datum, Unterschrift", { align: 'left' });

      // PDF-Dokument beenden
      doc.end();

    } catch (err) {
      console.error("Fehler beim Erstellen des PDFs:", err);
      res.status(500).send('Fehler beim Erstellen des PDFs.');
    }
  });

  return router;
};
