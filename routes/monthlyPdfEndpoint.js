// monthlyPdfEndpoint.js - V14: Vollständig mit Layout-Optimierung
// *** KORREKTUR SCHRITT 1: Leere erste Seite verhindern ***
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
  autoFirstPage: false, // Wichtig: PDFKit soll nicht automatisch die erste Seite erstellen
  margins: { top: 25, bottom: 35, left: 40, right: 40 }
};
const V_SPACE = { TINY: 1, SMALL: 4, MEDIUM: 10, LARGE: 18, SIGNATURE_GAP: 45 };
const FONT_SIZE = {
  HEADER: 16, SUB_HEADER: 11,
  TABLE_HEADER: 9, TABLE_CONTENT: 9,
  SUMMARY: 8, FOOTER: 8, PAGE_NUMBER: 8
};
const TABLE_ROW_HEIGHT = 12; // Höhe einer Tabellenzeile (Anpassbar)
const FOOTER_CONTENT_HEIGHT = FONT_SIZE.FOOTER + V_SPACE.SMALL;
const SIGNATURE_AREA_HEIGHT = V_SPACE.SIGNATURE_GAP + FONT_SIZE.FOOTER + V_SPACE.SMALL;
// Geschätzte Gesamthöhe des Footers inkl. Bestätigungstext und Signatur
const FOOTER_TOTAL_HEIGHT = FOOTER_CONTENT_HEIGHT + SIGNATURE_AREA_HEIGHT + V_SPACE.MEDIUM;
const SUMMARY_LINE_HEIGHT = FONT_SIZE.SUMMARY + V_SPACE.TINY + 0.5; // Höhe einer Zeile in der Zusammenfassung
// Geschätzte Gesamthöhe der Zusammenfassung (Anzahl Zeilen * Zeilenhöhe + Abstand)
const SUMMARY_TOTAL_HEIGHT = (7 * SUMMARY_LINE_HEIGHT) + V_SPACE.LARGE; // Annahme: 7 Zeilen für die Zusammenfassung

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
  // Sicherstellen, dass wir einen String im Format YYYY-MM-DD haben
  const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
  // Als UTC-Datum parsen, um Zeitzonenprobleme bei der Formatierung zu vermeiden
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

// Formatiert Datum zu Wochentag., DD.MM.YYYY (UTC)
function formatDateGermanWithWeekday(dateInput) {
  if (!dateInput) return 'N/A';
  const str = (dateInput instanceof Date) ? dateInput.toISOString().split('T')[0] : String(dateInput).split('T')[0];
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d) ? String(dateInput) : d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
}

// Zeichnet den Dokumentenkopf (Titel, Name, Zeitraum, Logo)
function drawDocumentHeader(doc, title, name, startDate, endDate) {
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const width = doc.page.width - left - right;
  let y = doc.page.margins.top; // Startet am oberen Rand

  // Logo rechts oben platzieren (ignoriert Fehler, falls Logo nicht da)
  try {
    const logoPath = path.join(process.cwd(),'public','icons','Hand-in-Hand-Logo-192x192.png');
    // Logo-Größe festlegen
    doc.image(logoPath, doc.page.width - right - 70, y, { width:70, height:70 });
  } catch (e) {
      console.warn("Logo konnte nicht geladen/gezeichnet werden:", e.message);
  }

  // Titel zentriert
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.HEADER).fillColor('black');
  doc.text(title, left, y + V_SPACE.SMALL, { align:'center', width });
  y += V_SPACE.SMALL + doc.heightOfString(title, { width, align:'center' }) + V_SPACE.LARGE; // Vertikaler Abstand nach Titel

  // Sub-Header (Name, Zeitraum) linksbündig
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.SUB_HEADER);
  doc.text(`Name: ${name||'Unbekannt'}`, left, y);
  y += FONT_SIZE.SUB_HEADER + V_SPACE.SMALL; // Vertikaler Abstand
  doc.text(`Zeitraum: ${formatDateGerman(startDate)} - ${formatDateGerman(endDate)}`, left, y);

  // Gibt die Y-Position NACH dem Header zurück für den nächsten Inhalt
  return y + FONT_SIZE.SUB_HEADER + V_SPACE.LARGE;
}

// Zeichnet den Tabellenkopf
function drawTableHeader(doc, startY, usableWidth) {
  const left = doc.page.margins.left;

  // Spaltenbreiten definieren (können angepasst werden)
  const cols = { date:105, start:65, end:85, expected:75, actual:75 };
  // Die letzte Spalte ('diff') nimmt den Restplatz ein, aber mindestens 30 breit
  cols.diff = Math.max(30, usableWidth - Object.values(cols).reduce((a,b)=>a+b,0));

  // X-Positionen der Spalten berechnen
  const pos = { date:left };
  pos.start    = pos.date + cols.date;
  pos.end      = pos.start + cols.start;
  pos.expected = pos.end + cols.end;
  pos.actual   = pos.expected + cols.expected;
  pos.diff     = pos.actual + cols.actual;

  // Höhe des Headers berechnen (2 Zeilen Text + Abstände)
  const headerHeight = (FONT_SIZE.TABLE_HEADER*2) + V_SPACE.TINY + V_SPACE.SMALL;

  // Hintergrundfarbe für Header
  doc.save()
     .fillColor('#eeeeee') // Hellgrau
     .rect(left, startY, usableWidth, headerHeight)
     .fill()
     .restore();

  // Linien für Header
  doc.save().lineWidth(0.5).strokeColor('#cccccc'); // Hellgraue Linien
  // Obere und untere Linie des Headers
  doc.moveTo(left,startY).lineTo(left+usableWidth,startY).stroke();
  doc.moveTo(left,startY+headerHeight).lineTo(left+usableWidth,startY+headerHeight).stroke();
  // Vertikale Trennlinien
  Object.values(pos).forEach(x=> doc.moveTo(x,startY).lineTo(x,startY+headerHeight).stroke());
  doc.restore();

  // Text für Header
  doc.font(FONT_BOLD).fontSize(FONT_SIZE.TABLE_HEADER).fillColor('black');
  const yText = startY + V_SPACE.TINY; // Y-Position für den Text im Header
  // Texte mit Zeilenumbruch (\n) und Zentrierung wo nötig
  doc.text('Datum',     pos.date,     yText, { width:cols.date }); // Links ausgerichtet
  doc.text('Arbeits-\nbeginn', pos.start,    yText, { width:cols.start,align:'center' });
  doc.text('Arbeits-\nende',  pos.end,      yText, { width:cols.end,  align:'center' });
  doc.text('Soll-Zeit', pos.expected, yText, { width:cols.expected,align:'center' }); // TODO: Ggf. (HH:MM) hinzufügen
  doc.text('Ist-Zeit',  pos.actual,   yText, { width:cols.actual, align:'center' }); // TODO: Ggf. (HH:MM) hinzufügen
  doc.text('Diff',      pos.diff,     yText, { width:cols.diff,   align:'center' }); // TODO: Ggf. anpassen zu 'Mehr/Minder Std.(HH:MM)'

  // Gibt relevante Infos zurück: Y-Position nach dem Header, Spaltenbreiten/-positionen
  return {
    headerBottomY: startY + headerHeight + V_SPACE.SMALL, // Wo der nächste Inhalt beginnt
    colWidths: cols,
    colPositions: pos,
    headerHeight: headerHeight
  };
}

// Zeichnet die Seitennummer unten zentriert
function drawPageNumber(doc, pageNum) {
  const left = doc.page.margins.left;
  // Positioniert die Seitenzahl etwas über dem unteren Rand
  const bottomY = doc.page.height - doc.page.margins.bottom + V_SPACE.MEDIUM;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.PAGE_NUMBER).fillColor('black')
     .text(`Seite ${pageNum}`, left, bottomY, { width, align:'center' });
}

// Zeichnet den Fußzeilenbereich mit Bestätigungstext und Unterschriftslinie
function drawSignatureFooter(doc, startY) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font(FONT_NORMAL).fontSize(FONT_SIZE.FOOTER).fillColor('black');

  // Bestätigungstext (TODO: Ggf. Text an Ziel.pdf anpassen)
  const text = 'Ich bestätige hiermit, dass die oben genannten Arbeits-/Gutschriftstunden erbracht wurden.';
  doc.text(text, left, startY, { width });

  // Y-Position für die Unterschriftslinie
  let y = startY + doc.heightOfString(text, { width }) + V_SPACE.SIGNATURE_GAP;
  // Linie zeichnen
  doc.moveTo(left,y).lineTo(left+200,y).stroke();
  // Text unter der Linie
  doc.text('Datum, Unterschrift', left, y + V_SPACE.SMALL);
}

// Middleware zur Prüfung von Admin-Rechten (aus server.js kopiert/angepasst für Konsistenz)
function isAdmin(req,res,next){
  // Prüft, ob die Session existiert und isAdmin gesetzt ist
  if(req.session && req.session.isAdmin === true) {
      next(); // Zugriff erlaubt
  } else {
      res.status(403).send('Zugriff verweigert. Admin-Login erforderlich.'); // Zugriff verweigert
  }
}


module.exports = function(db) {

  // Test-Route (optional)
  router.get('/test', (req,res) => res.send('PDF Route Test OK'));

  // Hauptroute zur Erstellung des Monats-PDFs
  router.get('/create-monthly-pdf', isAdmin, async (req,res) => {
    try {
      const { name, year, month } = req.query;
      // Eingabeprüfung
      if (!name || !year || !month || isNaN(+year)||isNaN(+month)||month<1||month>12) {
        return res.status(400).send('Parameter fehlen oder ungültig (name, year, month erforderlich).');
      }
      const y = +year; const m = +month;

      console.log(`[PDF] Anforderung für ${name}, ${String(m).padStart(2,'0')}/${y}`);
      // Daten aus der Datenbank holen und berechnen lassen
      const data = await calculateMonthlyData(db, name, y, m);
      if (!data) {
          console.error(`[PDF] Keine Daten für ${name}, ${String(m).padStart(2,'0')}/${y} gefunden.`);
          throw new Error('Daten für PDF konnten nicht abgerufen werden.');
      }
      console.log(`[PDF] Daten für ${name} erhalten. Beginne PDF-Generierung.`);

      // PDF-Dokument initialisieren
      const doc = new PDFDocument(PAGE_OPTIONS);

      // PDF an den Response streamen
      doc.pipe(res);

      // Dateiname für den Download festlegen
      const safeName = (data.employeeName||'Unbekannt').replace(/[^a-z0-9_\-]/gi,'_');
      const filename = `Monatsnachweis_${safeName}_${String(m).padStart(2,'0')}_${y}.pdf`;
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);

      // *** KORREKTUR SCHRITT 1: ***
      // Die erste Seite wird nicht mehr explizit hier hinzugefügt.
      // PDFKit fügt sie implizit hinzu, wenn der erste Inhalt gezeichnet wird,
      // da autoFirstPage: false gesetzt ist.
      // let page = 0; // Initialisierung bleibt
      // // page++; doc.addPage(); // <--- DIESE ZEILE WURDE ENTFERNT/AUSKOMMENTIERT

      const uW = doc.page.width - doc.page.margins.left - doc.page.margins.right; // Nutzbare Breite
      let page = 0; // Zählvariable für Seitennummer

      // === SEITE 1 (oder nächste Seite nach Umbruch) ===

      // Dokumenten-Header zeichnen (wird auf die erste Seite gezeichnet)
      let yPos = drawDocumentHeader(doc,
                                   `Monatsnachweis ${String(m).padStart(2,'0')}/${y}`,
                                   data.employeeName,
                                   new Date(Date.UTC(y,m-1,1)), // Erster Tag des Monats (UTC)
                                   new Date(Date.UTC(y,m,0))    // Letzter Tag des Monats (UTC)
                                  );
      page = 1; // Nachdem der Header auf Seite 1 ist, setzen wir den Zähler

      // Seitennummer zeichnen (TODO: In Schritt 3 entfernen, falls gewünscht)
      // drawPageNumber(doc, page);

      // Tabellen-Header zeichnen
      const table = drawTableHeader(doc, yPos, uW);
      yPos = table.headerBottomY; // Y-Position nach dem Tabellen-Header
      doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black').lineGap(1.5); // Schrift für Tabelleninhalt
      doc.y = yPos; // Setze die Startposition für die erste Zeile

      // Daten für die Tabelle vorbereiten und sortieren
      const allDays = [];
      // Arbeitseinträge hinzufügen
      data.workEntries.forEach(e => allDays.push({date:e.date,type:'WORK',start:e.startTime,end:e.endTime,actual:+e.hours||0}));
      // Abwesenheitseinträge hinzufügen (nur wenn kein Arbeitseintrag am selben Tag)
      data.absenceEntries.forEach(a => {
          if(!allDays.find(d=>d.date===a.date)) { // Verhindert doppelte Tage
             allDays.push({date:a.date,type:a.type,actual:+a.hours||0,comment:a.comment});
          }
      });
      // Nach Datum sortieren
      allDays.sort((a,b)=>new Date(a.date)-new Date(b.date));

      const left = doc.page.margins.left; // Linker Rand für Linien

      // Tabellenzeilen zeichnen
      allDays.forEach((d,i) => {
        // Prüfen, ob ein Seitenumbruch nötig ist, BEVOR die Zeile gezeichnet wird
        // Berücksichtigt Platz für die Zeile selbst, die Zusammenfassung und die Fußzeile
        if (doc.y + TABLE_ROW_HEIGHT > doc.page.height - doc.page.margins.bottom - FOOTER_TOTAL_HEIGHT - SUMMARY_TOTAL_HEIGHT) {
          console.log(`[PDF] Seitenumbruch vor Zeile ${i+1} (Datum: ${d.date}) bei Y=${doc.y}`);
          page++;
          doc.addPage(); // Neue Seite hinzufügen
          // drawPageNumber(doc,page); // Seitennummer für neue Seite (TODO: In Schritt 3 entfernen)
          // Tabellenkopf auf neuer Seite wiederholen
          const nextTable = drawTableHeader(doc, doc.page.margins.top, uW);
          doc.y = nextTable.headerBottomY; // Y-Position auf neuer Seite setzen
          doc.font(FONT_NORMAL).fontSize(FONT_SIZE.TABLE_CONTENT).fillColor('black').lineGap(1.5); // Schrift zurücksetzen
        }

        // Werte für die aktuelle Zeile berechnen/formatieren
        const expH = getExpectedHours(data.employeeData, d.date); // Soll-Stunden holen
        const actH = d.actual; // Ist-Stunden (aus Arbeit oder Abwesenheit)
        const diffH= actH-expH; // Differenz berechnen

        const sDate = formatDateGermanWithWeekday(d.date);
        // Start/Ende nur bei Arbeit anzeigen, sonst "--:--" (TODO: An Ziel.pdf anpassen für Abwesenheitstypen)
        const sStart= d.type==='WORK'?d.start:'--:--';
        const sEnd  = d.type==='WORK'?d.end:'--:--'; // Hier könnte man d.type (Urlaub, Krank) anzeigen
        const sExp  = decimalHoursToHHMM(expH);
        const sAct  = decimalHoursToHHMM(actH);
        const sDiff = decimalHoursToHHMM(diffH);

        const p = table.colPositions; // Spaltenpositionen
        const w = table.colWidths;   // Spaltenbreiten

        // *** KORREKTUR SCHRITT 2 (Platzhalter - noch nicht implementiert): ***
        // const currentLineY = doc.y; // Y-Position für diese Zeile speichern
        // doc.text(sDate,p.date,currentLineY,{width:w.date}); // Gespeicherte Y-Pos verwenden
        // doc.text(sStart,p.start,currentLineY,{width:w.start,align:'right'}); // Gespeicherte Y-Pos verwenden
        // ... etc. für alle Zellen ...
        // doc.y = currentLineY + TABLE_ROW_HEIGHT; // Y-Position für nächste Zeile setzen

        // *** Aktueller Code (führt zu vertikaler Verteilung - wird in Schritt 2 korrigiert): ***
        doc.text(sDate,p.date,doc.y,{width:w.date});
        doc.text(sStart,p.start,doc.y,{width:w.start,align:'right'});
        doc.text(sEnd,p.end,doc.y,{width:w.end,align:d.type==='WORK'?'right':'left'});
        doc.text(sExp,p.expected,doc.y,{width:w.expected,align:'right'});
        doc.text(sAct,p.actual,doc.y,{width:w.actual,align:'right'});
        doc.text(sDiff,p.diff,doc.y,{width:w.diff,align:'right'});
        // Aktueller Code erhöht y nach jedem Text. Nur die letzte Zeile braucht y explizit zu erhöhen
        // doc.y += TABLE_ROW_HEIGHT; // Diese Zeile wird in Schritt 2 angepasst/verschoben

        // Horizontale Trennlinie nach jeder Zeile
        doc.save().lineWidth(0.25).strokeColor('#dddddd')
           .moveTo(left, doc.y-1).lineTo(left+uW, doc.y-1).stroke().restore();
      });

      // Rahmen um den gesamten Tabelleninhalt zeichnen
      const tableTopY = table.headerBottomY - table.headerHeight - V_SPACE.SMALL; // Y-Pos des Tabellenkopfes
      const tableBottomY = doc.y; // Y-Pos nach der letzten Zeile
      doc.save().lineWidth(0.5).strokeColor('#999999') // Dunkelgrauer Rahmen
         .rect(left, tableTopY, uW, tableBottomY-tableTopY).stroke().restore();

      // Zusammenfassung & Footer zeichnen
      // Prüfen, ob ein Seitenumbruch VOR der Zusammenfassung nötig ist
       if (doc.y + SUMMARY_TOTAL_HEIGHT + FOOTER_TOTAL_HEIGHT > doc.page.height - doc.page.margins.bottom) {
           console.log(`[PDF] Seitenumbruch vor Zusammenfassung bei Y=${doc.y}`);
           page++;
           doc.addPage();
           // drawPageNumber(doc,page); // Seitennummer (TODO: In Schritt 3 entfernen)
           doc.y = doc.page.margins.top; // Y-Position auf neuer Seite oben setzen
       } else {
           // Wenn kein Umbruch, etwas Abstand nach der Tabelle
           doc.y += V_SPACE.LARGE;
       }

      // Zusammenfassung zeichnen
      doc.font(FONT_BOLD).fontSize(FONT_SIZE.SUMMARY).fillColor('black');
      // Breite für die Labels (passt ungefähr bis zur Soll-Zeit Spalte)
      const lblW = table.colWidths.date + table.colWidths.start + table.colWidths.end + table.colWidths.expected - V_SPACE.SMALL;
      // X-Position für die Werte (beginnt bei der Ist-Zeit Spalte)
      const valX = table.colPositions.actual;
      const valW = table.colWidths.actual+table.colWidths.diff; // Breite für Werte (Ist + Diff Spalte)

      // TODO: Labels anpassen an Ziel.pdf, fehlende Zeilen hinzufügen

      doc.text('Übertrag Vormonat:', left, doc.y, {width:lblW});
      doc.text(decimalHoursToHHMM(data.previousCarryOver), valX, doc.y, { width: valW, align:'right' });
      doc.moveDown(0.5); // Kleiner Abstand

      doc.text('Gesamt Soll (Monat):', left, doc.y, {width:lblW});
      doc.text(decimalHoursToHHMM(data.totalExpected), valX, doc.y, { width: valW, align:'right' });
      doc.moveDown(0.5);

      doc.text('Gesamt Ist (Monat):', left, doc.y, {width:lblW});
      // TODO: Hier fehlt die Detail-Info "(davon gearb...)"
      doc.text(decimalHoursToHHMM(data.totalActual), valX, doc.y, { width: valW, align:'right' });
      doc.moveDown(0.5);

      doc.text('Differenz:', left, doc.y, {width:lblW}); // TODO: Anpassen zu "Mehr/Minderstunden:"?
      doc.text(decimalHoursToHHMM(data.totalActual-data.totalExpected), valX, doc.y, { width: valW, align:'right' });
      doc.moveDown(0.5);

      // TODO: Hier fehlt die Zeile "Neuer Übertrag (Saldo Ende):"

      // Signatur-Footer zeichnen (mit Abstand zur Zusammenfassung)
      drawSignatureFooter(doc, doc.y + V_SPACE.LARGE);

      // PDF abschließen und Stream beenden
      doc.end();
      console.log(`[PDF] Generierung für ${name} abgeschlossen und gesendet.`);

    } catch (err) {
      console.error('[PDF] Kritischer Fehler bei PDF-Erstellung:', err);
      // Sicherstellen, dass kein halbfertiges PDF gesendet wird
      if (!res.headersSent) {
        res.status(500).send('Fehler bei der PDF-Erstellung auf dem Server.');
      }
    }
  });

  return router;
};
