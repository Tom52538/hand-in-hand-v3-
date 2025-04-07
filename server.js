<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/Hand-in-Hand-Logo-192x192.png" />
  <link rel="apple-touch-icon" sizes="192x192" href="/icons/Hand-in-Hand-Logo-192x192.png" />
  <link rel="shortcut icon" href="/icons/Hand-in-Hand-Logo-192x192.png" />
  <link rel="manifest" href="/icons/manifest.json" />
  <title>Arbeitszeiterfassung</title>
  <link rel="stylesheet" href="style.css" />
  <meta name="theme-color" content="#ffffff" />
  <style>
    /* Grundlegende Stile */
    .hidden {
      display: none;
    }
    form > div {
      margin-bottom: 1rem;
    }
    label {
      display: block;
      margin-bottom: 0.3rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
    }
    th, td {
      border: 1px solid #ccc;
      padding: 8px;
      vertical-align: middle;
      text-align: left;
    }
    td button {
      margin-right: 5px;
      padding: 5px 10px;
    }
    .table-wrapper {
        overflow-x: auto;
    }
    .container {
        max-width: 900px;
        margin: 20px auto;
        padding: 20px;
        background-color: #f9f9f9;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1, h2, h3 {
        color: #333;
    }
    button {
        padding: 10px 15px;
        cursor: pointer;
    }
    hr {
        margin: 2rem 0;
        border: 0;
        border-top: 1px solid #eee;
    }
    #monthlyBalanceFormContainer {
        margin-top: 1.5rem;
        padding-top: 1.5rem;
        border-top: 1px solid #eee;
    }
    input[readonly], input[disabled] { /* Kombiniert für Konsistenz */
      background-color: #e9e9e9;
      cursor: default;
    }
    #selectedEmployeeDisplay {
        font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Arbeitszeiterfassung</h1>

    <form id="workHoursForm">
      <div>
        <label for="employeeSelect">Mitarbeiter:</label>
        <select id="employeeSelect" name="employeeSelect" required>
          <option value="">Bitte auswählen</option>
          </select>
      </div>
      <div>
        <label for="selectedEmployeeDisplay">Ausgewählter Mitarbeiter:</label>
        <input type="text" id="selectedEmployeeDisplay" name="selectedEmployeeDisplay" readonly disabled
               value="Kein Mitarbeiter ausgewählt" />
      </div>
      <div>
        <button type="button" id="workTimeBtn">Arbeitszeit buchen</button>
      </div>
      <div>
        <button type="button" id="pauseBtn">Pausen buchen</button>
      </div>
      <div>
        <label for="date">Datum:</label>
        <input type="date" id="date" name="date" required readonly />
      </div>
      <div>
        <label for="startTime">Arbeitsbeginn:</label>
        <input type="time" id="startTime" name="startTime" required readonly />
      </div>
      <div>
        <label for="endTime">Arbeitsende:</label>
        <input type="time" id="endTime" name="endTime" required readonly />
      </div>
      <div>
        <label for="breakTime">Pause (Minuten):</label>
        <input type="number" id="breakTime" name="breakTime" min="0" step="1" value="0" required readonly />
      </div>
      <div>
        <label for="comment">Bemerkungen:</label>
        <input type="text" id="comment" name="comment" />
      </div>
      <button type="submit">Eintragen</button>
    </form>

    <hr>

    <h2>Gebuchte Arbeitszeiten</h2>
    <ul id="workHoursList"></ul>

    <h2>Gesamtarbeitszeit</h2>
    <p id="totalHours"></p>

    <hr>

    <h2>Admin Login</h2>
    <form id="adminLoginForm">
      <div>
          <label for="adminPassword">Passwort:</label>
          <input type="password" id="adminPassword" name="adminPassword" required />
      </div>
      <button type="submit">Anmelden</button>
    </form>

    <div id="adminPanel" class="hidden">
      <hr>

      <h2>Admin Panel: Alle Arbeitszeiten</h2>
      <div class="table-wrapper">
        <table id="workHoursTable">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Datum</th>
              <th>Arbeitszeit</th>
              <th>Stunden</th>
              <th>Pause(Std)</th>
              <th>Bemerkungen</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <br>
      <button id="adminDownloadCsv">Alle Arbeitszeiten als CSV herunterladen</button>
      <button id="adminDeleteData">Alle Arbeitszeiten löschen</button>

      <hr>

      <h2>Admin Panel: Datensatz bearbeiten</h2>
      <form id="editForm">
        <input type="hidden" id="editId" name="id" />
        <div>
          <label for="editName">Name:</label>
          <input type="text" id="editName" name="name" />
        </div>
        <div>
           <label for="editDate">Datum:</label>
          <input type="date" id="editDate" name="date" />
        </div>
        <div>
          <label for="editStartTime">Arbeitsbeginn:</label>
          <input type="time" id="editStartTime" name="startTime" required />
        </div>
        <div>
          <label for="editEndTime">Arbeitsende:</label>
          <input type="time" id="editEndTime" name="endTime" required />
        </div>
        <div>
          <label for="editBreakTime">Pause (Minuten):</label>
          <input type="number" id="editBreakTime" name="breakTime" min="0" step="1" value="0" />
        </div>
        <div>
          <label for="editComment">Bemerkungen:</label>
          <input type="text" id="editComment" name="comment" />
        </div>
        <button type="button" onclick="saveChanges()">Änderungen Speichern</button>
      </form>

      <hr>

      <div id="employeePanel">
        <h2>Mitarbeiterverwaltung</h2>

        <h3>Aktuelle Mitarbeiter</h3>
        <ul id="employeeList"></ul>

        <hr>

        <form id="addEmployeeForm">
           <h3>Neuen Mitarbeiter hinzufügen</h3>
          <div>
            <label for="employeeName">Name:</label>
            <input type="text" id="employeeName" name="employeeName" required />
          </div>
           <div>
            <label for="mo_hours">Montag (Soll-Std.):</label>
            <input type="number" id="mo_hours" name="mo_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="di_hours">Dienstag (Soll-Std.):</label>
            <input type="number" id="di_hours" name="di_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="mi_hours">Mittwoch (Soll-Std.):</label>
            <input type="number" id="mi_hours" name="mi_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="do_hours">Donnerstag (Soll-Std.):</label>
            <input type="number" id="do_hours" name="do_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="fr_hours">Freitag (Soll-Std.):</label>
            <input type="number" id="fr_hours" name="fr_hours" step="0.1" value="0" />
          </div>
          <button type="submit">Mitarbeiter hinzufügen</button>
        </form>

        <form id="editEmployeeForm" class="hidden">
           <hr>
           <h3>Mitarbeiter bearbeiten</h3>
          <input type="hidden" id="editEmployeeId" name="id" />
          <div>
            <label for="editEmployeeName">Name:</label>
            <input type="text" id="editEmployeeName" name="name" required />
          </div>
          <div>
            <label for="editMoHours">Montag (Soll-Std.):</label>
            <input type="number" id="editMoHours" name="mo_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="editDiHours">Dienstag (Soll-Std.):</label>
            <input type="number" id="editDiHours" name="di_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="editMiHours">Mittwoch (Soll-Std.):</label>
            <input type="number" id="editMiHours" name="mi_hours" step="0.1" value="0" />
          </div>
          <div>
            <label for="editDoHours">Donnerstag (Soll-Std.):</label>
            <input type="number" id="editDoHours" name="do_hours" step="0.1" value="0" />
          </div>
          <div>
             <label for="editFrHours">Freitag (Soll-Std.):</label>
            <input type="number" id="editFrHours" name="fr_hours" step="0.1" value="0" />
          </div>
          <button type="button" onclick="saveEmployeeChanges()">Mitarbeiter Speichern</button>
          <button type="button" onclick="cancelEdit()">Abbrechen</button>
        </form>
      </div> <hr> <div id="monthlyBalanceFormContainer">
         <h2>Monatsabschluss berechnen</h2>
         <form id="monthlyBalanceForm">
           <div>
             <label for="balanceName">Mitarbeitername:</label>
             <input type="text" id="balanceName" name="balanceName" placeholder="z.B. Birte" required />
           </div>
           <div>
             <label for="balanceYear">Jahr:</label>
             <input type="number" id="balanceYear" name="balanceYear" placeholder="z.B. 2025" required />
           </div>
           <div>
             <label for="balanceMonth">Monat:</label>
             <input type="number" id="balanceMonth" name="balanceMonth" placeholder="z.B. 4" required min="1" max="12" />
           </div>
           <button type="submit">Monatsabschluss berechnen</button>
         </form>
         <p id="monthlyBalanceResult"></p>
      </div>

    </div>
    </div> <script>
    // Hilfsfunktionen (unverändert)
    function formatDecimalHours(decimalHours) {
      if (typeof decimalHours !== 'number' || isNaN(decimalHours)) return "00:00";
      const hours = Math.floor(decimalHours);
      const minutes = Math.round((decimalHours - hours) * 60);
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    function formatDate(dateStr) {
      if (!dateStr) return "";
      try {
          const date = new Date(dateStr);
          if (isNaN(date.getTime())) return dateStr;
          return date.toLocaleDateString("de-DE", { year: 'numeric', month: '2-digit', day: '2-digit' });
      } catch (e) {
          console.error("Fehler beim Formatieren des Datums:", dateStr, e);
          return dateStr;
      }
    }
    function formatTime(timeStr) {
      if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return "";
      return timeStr.slice(0,5);
    }
    function dateToIsoFormat(dateStr) {
        if (!dateStr || typeof dateStr !== 'string' || !dateStr.includes('.')) return '';
        const parts = dateStr.split('.');
        if (parts.length === 3) {
            return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        return '';
    }

    // --- Globale Variablen --- (unverändert)
    const workTimeBtn = document.getElementById('workTimeBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const dateInput = document.getElementById('date');
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');
    const breakTimeInput = document.getElementById('breakTime');
    const employeeSelect = document.getElementById('employeeSelect');
    const selectedEmployeeDisplay = document.getElementById('selectedEmployeeDisplay');
    const workHoursList = document.getElementById('workHoursList');
    const totalHoursElement = document.getElementById('totalHours');
    const adminPanel = document.getElementById('adminPanel');
    const employeePanel = document.getElementById('employeePanel');
    const editEmployeeForm = document.getElementById('editEmployeeForm');
    const employeeList = document.getElementById('employeeList');
    const addEmployeeForm = document.getElementById('addEmployeeForm');

    // --- Event Listener --- (unverändert)
    window.addEventListener('load', loadEmployeeOptions);

    employeeSelect.addEventListener('change', function() {
        const selectedName = employeeSelect.value;
        if (selectedName) {
            selectedEmployeeDisplay.value = selectedName;
        } else {
            selectedEmployeeDisplay.value = "Kein Mitarbeiter ausgewählt";
        }
        loadWorkHours();
    });

    // Arbeitszeit-Button Logik (unverändert)
    let workTimeState = 0;
    workTimeBtn.addEventListener('click', function() { /* ... (Code unverändert) ... */ });

    // Pausen-Button Logik (unverändert)
    let pauseState = 0;
    let pauseStartTime = null;
    pauseBtn.addEventListener('click', function() { /* ... (Code unverändert) ... */ });

    // Formular zum Eintragen der Arbeitszeiten (unverändert)
    document.getElementById('workHoursForm').addEventListener('submit', async function(event) { /* ... (Code unverändert) ... */ });

    // Admin-Login (unverändert)
    document.getElementById('adminLoginForm').addEventListener('submit', async function(event) { /* ... (Code unverändert) ... */ });

    // CSV Download (Admin) (unverändert)
    document.getElementById('adminDownloadCsv').addEventListener('click', async function() { /* ... (Code unverändert) ... */ });

    // Alle Daten löschen (Admin) (unverändert)
    document.getElementById('adminDeleteData').addEventListener('click', async function() { /* ... (Code unverändert) ... */ });

    // Mitarbeiter Hinzufügen (Admin) (unverändert)
    document.getElementById('addEmployeeForm').addEventListener('submit', async function(event) { /* ... (Code unverändert) ... */ });

    // Monatsabschluss (Admin) (unverändert)
    document.getElementById('monthlyBalanceForm').addEventListener('submit', async function(event) { /* ... (Code unverändert) ... */ });


    // --- Asynchrone Ladefunktionen ---

    // loadEmployeeOptions (unverändert)
    async function loadEmployeeOptions() { /* ... (Code unverändert) ... */ }

    // loadWorkHours (unverändert)
    async function loadWorkHours() { /* ... (Code unverändert) ... */ }

    // loadAdminWorkHours (KORRIGIERTE VERSION)
    async function loadAdminWorkHours() {
       try {
        const response = await fetch('/admin-work-hours');
        if (!response.ok) throw new Error('Admin-Arbeitszeiten konnten nicht geladen werden.');
        const data = await response.json();
        const tableBody = document.querySelector('#workHoursTable tbody');
        tableBody.innerHTML = ''; // Vorhandene Zeilen löschen

        if (data && data.length > 0) {
            data.forEach(entry => {
                const row = tableBody.insertRow(); // Zeile sicher erstellen
                const hours = parseFloat(entry.hours);
                const breakHours = entry.break_time || 0; // Kommt als Stunden aus DB

                // Zellen sicher erstellen und befüllen
                row.insertCell().textContent = entry.id;
                row.insertCell().textContent = entry.name || 'N/A';
                row.insertCell().textContent = formatDate(entry.date);
                row.insertCell().textContent = `${formatTime(entry.startTime)} - ${formatTime(entry.endTime)}`;
                row.insertCell().textContent = formatDecimalHours(hours);
                row.insertCell().textContent = breakHours.toFixed(2); // Anzeige in Stunden
                row.insertCell().textContent = entry.comment || '';

                // Aktions-Zelle erstellen
                const actionCell = row.insertCell();

                // Bearbeiten-Button sicher erstellen und Event-Handler zuweisen
                const editBtn = document.createElement('button');
                editBtn.textContent = 'Bearbeiten';
                // Wichtig: Arrow Function verwenden, damit 'entry' korrekt übergeben wird
                editBtn.onclick = () => editEntry(entry);
                actionCell.appendChild(editBtn);

                // Löschen-Button sicher erstellen und Event-Handler zuweisen
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = 'Löschen';
                // Wichtig: Arrow Function verwenden, damit 'entry.id' korrekt übergeben wird
                deleteBtn.onclick = () => deleteEntry(entry.id);
                actionCell.appendChild(deleteBtn);

                // Kleinen Abstand zwischen Buttons hinzufügen (optional)
                deleteBtn.style.marginLeft = '5px';
            });
        } else {
             // Keine Daten vorhanden
             const row = tableBody.insertRow();
             const cell = row.insertCell();
             cell.colSpan = 8; // Spannt über alle Spalten
             cell.textContent = 'Keine Daten vorhanden.';
             cell.style.textAlign = 'center';
        }
      } catch (error) {
        // Fehlerbehandlung
        console.error("Fehler beim Laden der Admin-Arbeitszeiten:", error);
        const tableBody = document.querySelector('#workHoursTable tbody');
        tableBody.innerHTML = ''; // Evtl. alte Fehlerzeile entfernen
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 8;
        cell.textContent = `Fehler beim Laden: ${error.message}`;
        cell.style.color = 'red';
      }
     }

    // loadEmployees (unverändert)
    async function loadEmployees() { /* ... (Code unverändert) ... */ }


    // --- Bearbeitungs- und Löschfunktionen (Admin) ---

    // editEntry (unverändert)
    function editEntry(entry) {
        document.getElementById('editId').value = entry.id;
        document.getElementById('editName').value = entry.name || '';
        document.getElementById('editDate').value = entry.date ? entry.date.split('T')[0] : '';
        document.getElementById('editStartTime').value = formatTime(entry.startTime);
        document.getElementById('editEndTime').value = formatTime(entry.endTime);
        // Feld erwartet Minuten, DB hat Stunden
        document.getElementById('editBreakTime').value = Math.round((entry.break_time || 0) * 60);
        document.getElementById('editComment').value = entry.comment || '';
        document.getElementById('editForm').scrollIntoView({ behavior: 'smooth' });
    }

    // saveChanges (unverändert)
    async function saveChanges() { /* ... (Code unverändert) ... */ }

    // deleteEntry (unverändert)
    async function deleteEntry(id) { /* ... (Code unverändert) ... */ }

    // editEmployee (unverändert)
    function editEmployee(emp) { /* ... (Code unverändert) ... */ }

    // saveEmployeeChanges (unverändert)
    async function saveEmployeeChanges() { /* ... (Code unverändert) ... */ }

    // deleteEmployee (unverändert)
    async function deleteEmployee(id, name) { /* ... (Code unverändert) ... */ }

    // cancelEdit (unverändert)
    function cancelEdit() { /* ... (Code unverändert) ... */ }

    // --- Hilfsfunktionen für Formular-Reset ---

    // resetWorkTimeForm (unverändert)
    function resetWorkTimeForm() {
        document.getElementById('comment').value = '';
        workTimeBtn.textContent = "Arbeitszeit buchen";
        workTimeBtn.disabled = false;
        pauseBtn.textContent = "Pausen buchen";
        pauseBtn.disabled = true;
        document.getElementById('workHoursForm').querySelector('button[type="submit"]').disabled = true;
        workTimeState = 0;
        pauseState = 0;
        pauseStartTime = null;
        dateInput.value = '';
        startTimeInput.value = '';
        endTimeInput.value = '';
        breakTimeInput.value = '0';
        // WICHTIG: Das Employee-Select und das Display-Feld werden hier NICHT zurückgesetzt!
        // Das ist korrekt so, da der Mitarbeiter ausgewählt bleiben soll.
    }

    // Initialisierung beim Laden (unverändert)
    resetWorkTimeForm();

  </script>
</body>
</html>
