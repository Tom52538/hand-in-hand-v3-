// --- NEU: utils/timeUtils.js erstellen (oder Inhalt hier einfügen) ---
/*
// Inhalt für utils/timeUtils.js (falls ausgelagert)

function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const startMinutes = parseTime(startTime);
  const endMinutes = parseTime(endTime);
  // Einfache Differenz, ignoriert Mitternacht aktuell
  const diffInMin = endMinutes - startMinutes;
  if (diffInMin < 0) {
      console.warn(`Negative Arbeitszeit berechnet (${startTime} - ${endTime}). Eventuell über Mitternacht?`);
      // Hier könnte man 24*60 Minuten addieren, wenn Datum berücksichtigt wird.
  }
  return diffInMin / 60;
}

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  const headers = ["Name", "Datum", "Arbeitsbeginn", "Arbeitsende", "Soll-Std", "Ist-Std", "Differenz", "Bemerkung"];
  csvRows.push(headers.join(','));

  for (const row of data) {
    let dateFormatted = "";
    if (row.date) {
      try {
        const dateObj = (row.date instanceof Date) ? row.date : new Date(row.date);
        const year = dateObj.getUTCFullYear();
        const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getUTCDate()).padStart(2, '0');
        dateFormatted = `${day}.${month}.${year}`;
      } catch (e) { dateFormatted = String(row.date); }
    }
    const startTimeFormatted = row.starttime || ""; // Kommt schon als HH:MI aus DB
    const endTimeFormatted = row.endtime || "";   // Kommt schon als HH:MI aus DB
    const istHours = row.hours || 0;
    let expected = 0;
    // getExpectedHours muss importiert werden, falls diese Datei separat ist
    // Annahme: getExpectedHours ist global verfügbar oder wird hier importiert
    // if (typeof getExpectedHours === 'function' && row.date) {
    //     try {
    //         const dateString = (row.date instanceof Date) ? row.date.toISOString().split('T')[0] : String(row.date).split('T')[0];
    //         expected = getExpectedHours(row, dateString); // Benötigt utils/calculationUtils
    //     } catch (e) { console.error("Fehler Soll-Std für CSV:", e); }
    // }
    const diff = istHours - expected;
    const commentFormatted = `"${(row.comment || '').replace(/"/g, '""')}"`;
    const values = [
      row.name, dateFormatted, startTimeFormatted, endTimeFormatted,
      expected.toFixed(2), istHours.toFixed(2), diff.toFixed(2), commentFormatted
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

module.exports = { parseTime, calculateWorkHours, convertToCSV };
*/
