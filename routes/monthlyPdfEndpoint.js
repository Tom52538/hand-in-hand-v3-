const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();

router.get('/create-monthly-pdf', async (req, res) => {
  // Parameter aus der URL
  const { name, year, month } = req.query;

  // Beispiel: Abrufen der Berechnungsdaten (Datenbank oder Logik)
  const monthlyData = await calculateMonthlyData({ name, year, month });
  // monthlyData sollte enthalten:
  // - vorigerUebertrag
  // - tagesbuchungen (Array von Objekten mit Datum, Arbeitszeiten, etc.)
  // - neuerUebertrag

  // PDF-Dokument erstellen
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=Monatsabschluss_' + name + '_' + month + '_' + year + '.pdf');
  doc.pipe(res);

  // Header
  doc.fontSize(16).text(`Monatsabschluss für ${name}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Monat: ${month} / Jahr: ${year}`, { align: 'center' });
  doc.moveDown();

  // Übertrag aus Vormonat
  doc.fontSize(14).text(`Übertrag aus Vormonat: ${monthlyData.vorigerUebertrag}`, { underline: true });
  doc.moveDown();

  // Tabelle mit Tagesbuchungen
  doc.fontSize(12).text('Tagesbuchungen:', { underline: true });
  monthlyData.tagesbuchungen.forEach((buchung) => {
    doc.text(`${buchung.datum} - Beginn: ${buchung.startTime}, Ende: ${buchung.endTime}, Stunden: ${buchung.hours}`);
  });
  doc.moveDown();

  // Neuer Übertrag
  doc.fontSize(14).text(`Neuer Übertrag: ${monthlyData.neuerUebertrag}`, { underline: true });
  doc.end();
});

module.exports = router;
