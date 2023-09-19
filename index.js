const baudrates = document.getElementById('baudrates');
const connectButton = document.getElementById('connectButton');
const deviceTypes = document.getElementsByName('deviceType');
const disconnectButton = document.getElementById('disconnectButton');
const resetButton = document.getElementById('resetButton');
const consoleStartButton = document.getElementById('consoleStartButton');
const consoleStopButton = document.getElementById('consoleStopButton');
const eraseButton = document.getElementById('eraseButton');
const programButton = document.getElementById('programButton');
const filesDiv = document.getElementById('files');
const terminal = document.getElementById('terminal');
const programDiv = document.getElementById('program');
const consoleDiv = document.getElementById('console');
const lblBaudrate = document.getElementById('lblBaudrate');
const lblConnTo = document.getElementById('lblConnTo');
const lblRelease = document.getElementById('lblRelease');
const release = document.getElementById('release');
const table = document.getElementById('fileTable');
const useLatest = document.getElementById('useLatest');
const alertDiv = document.getElementById('alertDiv');
const willowSettings = document.getElementById('willowSettings');

// import { Transport } from './cp210x-webusb.js'
import * as esptooljs from "./bundle.js";
const ESPLoader = esptooljs.ESPLoader;
const Transport = esptooljs.Transport;
const generateNvs = esptooljs.generateNvs;

let term = new Terminal({ cols: 120, rows: 40 });
term.open(terminal);

let device = null;
let transport;
let chip = null;
let esploader;
let file1 = null;
let connected = false;
let releases = {};

disconnectButton.style.display = 'none';
eraseButton.style.display = 'none';
consoleStopButton.style.display = 'none';
filesDiv.style.display = 'none';

// Attempt grab from local storage
const lsWifiName = localStorage.getItem('wifiName');
const lsWasUrl = localStorage.getItem('wasUrl');

// Get WAS URL Param (prefer local storage)
const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const wasURL = urlParams.get('wasURL')

if (lsWasUrl) {
  document.getElementById('wasUrl').setAttribute('value', lsWasUrl);
} else if (wasURL) {
  console.log(`Setting wasURL to ${wasURL} from URL param`)
  document.getElementById('wasUrl').setAttribute('value', wasURL);
}

if (lsWifiName) {
  document.getElementById('wifiName').setAttribute('value', lsWifiName);
}

async function getReleases() {
  const willowReleases = {'ESP32_S3_BOX': [], 'ESP32_S3_BOX_3': [], 'ESP32_S3_BOX_LITE': []};
  const ghReleasesUrl = 'https://worker.heywillow.io/releases';
  const response = await fetch(ghReleasesUrl);
  const jsonResponse = await response.json();

  for (const release of jsonResponse) {
    for (const asset of release['assets']) {
      if (asset['name'] == 'willow-dist-ESP32_S3_BOX.bin') {
        console.log("Adding", release['tag_name'], asset['browser_download_url']);
        willowReleases['ESP32_S3_BOX'].push({'version': release['tag_name'], 'url': asset['browser_download_url']});
      } else if (asset['name'] == 'willow-dist-ESP32_S3_BOX_3.bin') {
        console.log("Adding", release['tag_name'], asset['browser_download_url']);
        willowReleases['ESP32_S3_BOX_3'].push({'version': release['tag_name'], 'url': asset['browser_download_url']});
      } else if (asset['name'] == 'willow-dist-ESP32_S3_BOX_LITE.bin') {
        console.log("Adding", release['tag_name'], asset['browser_download_url']);
        willowReleases['ESP32_S3_BOX_LITE'].push({'version': release['tag_name'], 'url': asset['browser_download_url']});
      }
    }
  }
  console.debug(willowReleases);
  return willowReleases;
}

function getReleaseUrl() {
  let deviceType = document.querySelector('input[name="deviceType"]:checked').value;
  for (const r of releases[deviceType]) {
    if (r['version'] == release.value) {
      return r['url'];
    }
  }
}

function updateReleaseDropdown() {
  // clear releases first
  while (release.options.length > 0) {
    release.remove(0);
  }
  for (const r of releases[document.querySelector('input[name="deviceType"]:checked').value]) {
    const option = new Option(r['version']);
    release.add(option);
  }
}

function handleFileSelect(evt) {
  var file = evt.target.files[0];

  if (!file) return;

  var reader = new FileReader();

  reader.onload = (function (theFile) {
    return function (e) {
      file1 = e.target.result;
      evt.target.data = file1;
    };
  })(file);

  reader.readAsBinaryString(file);
}

let espLoaderTerminal = {
  clean() {
    term.clear();
  },
  writeLine(data) {
    term.writeln(data);
  },
  write(data) {
    term.write(data)
  }
}

connectButton.onclick = async () => {
  if (device === null) {
    device = await navigator.serial.requestPort({});
    transport = new Transport(device);
  }

  try {
    esploader = new ESPLoader(transport, baudrates.value, espLoaderTerminal);
    connected = true;

    chip = await esploader.main_fn();

    // Temporarily broken
    // await esploader.flash_id();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  }

  releases = await getReleases();
  updateReleaseDropdown();

  console.log('Settings done for :' + chip);
  lblBaudrate.style.display = 'none';
  lblConnTo.innerHTML = 'Connected to device: ' + chip;
  lblConnTo.style.display = 'block';
  baudrates.style.display = 'none';
  connectButton.style.display = 'none';
  disconnectButton.style.display = 'initial';
  eraseButton.style.display = 'initial';
  //filesDiv.style.display = 'initial'; XXX: disable all the normal file stuff
  consoleDiv.style.display = 'none';
  willowSettings.style.display = 'initial';
};

deviceTypes.forEach(function(radio) {
  radio.addEventListener("click", updateReleaseDropdown);
});

useLatest.onchange = async () => {
  if (useLatest.checked == true) {
    lblRelease.hidden = true;
    release.hidden = true;
  } else {
    lblRelease.hidden = false;
    release.hidden = false;
  }
};

function ui8ToBstr(u8Array) {
  let b_str = "";
  for (let i = 0; i < u8Array.length; i++) {
    b_str += String.fromCharCode(u8Array[i]);
  }
  return b_str;
}

willowSettings.onsubmit = async (event) => {
  event.preventDefault()
  term.writeln('Fetching your Willow release. Please wait...');
  const releaseUrl = getReleaseUrl();
  const workerUrl = `https://worker.heywillow.io/fetch?url=${releaseUrl}`
  const buffer = await (await fetch(workerUrl)).arrayBuffer()
  const firmware = new Uint8Array(buffer)

  const rows = [
    { key: "WIFI", type: "namespace" },
    { key: "PSK", type: "data", encoding: "string", value: event.target.wifiPass.value },
    { key: "SSID", type: "data", encoding: "string", value: event.target.wifiName.value },
    { key: "WAS", type: "namespace" },
    { key: "URL", type: "data", encoding: "string", value: event.target.wasUrl.value },
  ]

  // Save values to local storage
  localStorage.setItem('wifiName', event.target.wifiName.value);
  localStorage.setItem('wasUrl', event.target.wasUrl.value);

  try {
    const nvs = generateNvs(2, 0x24000, rows);
    firmware.set(nvs, 0x9000);
    term.writeln('Successfully injected Willow settings in image!');

    await esploader.write_flash(
      [{ data: ui8ToBstr(firmware), address: 0 }],
      'keep',
      undefined,
      undefined,
      false,
      true,
      (fileIndex, written, total) => { },
      (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
    );
    // Reset after flash
    term.writeln('Flash successful! Resetting your device.');
    await transport.setDTR(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.setDTR(true);
    
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  }
}

resetButton.onclick = async () => {
  if (device === null) {
    device = await navigator.serial.requestPort({});
    transport = new Transport(device);
  }

  await transport.setDTR(false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await transport.setDTR(true);
};

eraseButton.onclick = async () => {
  eraseButton.disabled = true;
  try {
    await esploader.erase_flash();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  } finally {
    eraseButton.disabled = false;
  }
};

addFile.onclick = () => {
  var rowCount = table.rows.length;
  var row = table.insertRow(rowCount);

  //Column 1 - Offset
  var cell1 = row.insertCell(0);
  var element1 = document.createElement('input');
  element1.type = 'text';
  element1.id = 'offset' + rowCount;
  element1.value = '0x1000';
  cell1.appendChild(element1);

  // Column 2 - File selector
  var cell2 = row.insertCell(1);
  var element2 = document.createElement('input');
  element2.type = 'file';
  element2.id = 'selectFile' + rowCount;
  element2.name = 'selected_File' + rowCount;
  element2.addEventListener('change', handleFileSelect, false);
  cell2.appendChild(element2);

  // Column 3  - Progress
  var cell3 = row.insertCell(2);
  cell3.classList.add('progress-cell');
  cell3.style.display = 'none';
  cell3.innerHTML = `<progress value="0" max="100"></progress>`;

  // Column 4  - Remove File
  var cell4 = row.insertCell(3);
  cell4.classList.add('action-cell');
  if (rowCount > 1) {
    var element4 = document.createElement('input');
    element4.type = 'button';
    var btnName = 'button' + rowCount;
    element4.name = btnName;
    element4.setAttribute('class', 'btn');
    element4.setAttribute('value', 'Remove'); // or element1.value = "button";
    element4.onclick = function () {
      removeRow(row);
    };
    cell4.appendChild(element4);
  }
};

function removeRow(row) {
  const rowIndex = Array.from(table.rows).indexOf(row);
  table.deleteRow(rowIndex);
}

// to be called on disconnect - remove any stale references of older connections if any
function cleanUp() {
  device = null;
  transport = null;
  chip = null;
}

disconnectButton.onclick = async () => {
  if (transport) await transport.disconnect();

  term.clear();
  connected = false;
  baudrates.style.display = 'initial';
  connectButton.style.display = 'initial';
  disconnectButton.style.display = 'none';
  eraseButton.style.display = 'none';
  lblConnTo.style.display = 'none';
  filesDiv.style.display = 'none';
  alertDiv.style.display = 'none';
  consoleDiv.style.display = 'initial';
  cleanUp();
};

let isConsoleClosed = false;
consoleStartButton.onclick = consoleRead;

async function consoleRead() {
  if (device === null) {
    device = await navigator.serial.requestPort({});
    transport = new Transport(device);
  }
  lblConsoleFor.style.display = 'block';

  consoleStartButton.style.display = 'none';
  consoleStopButton.style.display = 'initial';
  programDiv.style.display = 'none';

  await transport.connect();
  isConsoleClosed = false;

  while (true && !isConsoleClosed) {
    let val = await transport.rawRead();
    if (typeof val !== 'undefined') {
      term.write(val);
    } else {
      break;
    }
  }
  console.log('quitting console');
};

consoleStopButton.onclick = async () => {
  isConsoleClosed = true;
  await transport.disconnect();
  await transport.waitForUnlock(1500);
  term.clear();
  consoleStartButton.style.display = 'initial';
  consoleStopButton.style.display = 'none';
  programDiv.style.display = 'initial';
};

function validate_program_inputs() {
  let offsetArr = [];
  var rowCount = table.rows.length;
  var row;
  let offset = 0;
  let fileData = null;

  // check for mandatory fields
  for (let index = 1; index < rowCount; index++) {
    row = table.rows[index];

    //offset fields checks
    var offSetObj = row.cells[0].childNodes[0];
    offset = parseInt(offSetObj.value);

    // Non-numeric or blank offset
    if (Number.isNaN(offset)) return 'Offset field in row ' + index + ' is not a valid address!';
    // Repeated offset used
    else if (offsetArr.includes(offset)) return 'Offset field in row ' + index + ' is already in use!';
    else offsetArr.push(offset);

    var fileObj = row.cells[1].childNodes[0];
    fileData = fileObj.data;
    if (fileData == null) return 'No file selected for row ' + index + '!';
  }
  return 'success';
}

programButton.onclick = async () => {
  const alertMsg = document.getElementById('alertmsg');
  const err = validate_program_inputs();

  if (err != 'success') {
    alertMsg.innerHTML = '<strong>' + err + '</strong>';
    alertDiv.style.display = 'block';
    return;
  }

  // Hide error message
  alertDiv.style.display = 'none';

  const fileArray = [];
  const progressBars = [];


  for (let index = 1; index < table.rows.length; index++) {
    const row = table.rows[index];

    const offSetObj = row.cells[0].childNodes[0];
    const offset = parseInt(offSetObj.value);

    const fileObj = row.cells[1].childNodes[0];
    const progressBar = row.cells[2].childNodes[0];

    progressBar.value = 0;
    progressBars.push(progressBar);

    row.cells[2].style.display = 'initial';
    row.cells[3].style.display = 'none';

    fileArray.push({ data: fileObj.data, address: offset });
  }

  try {
    await esploader.write_flash(
      fileArray,
      'keep',
      undefined,
      undefined,
      false,
      true,
      (fileIndex, written, total) => {
        progressBars[fileIndex].value = (written / total) * 100;
      },
      (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
    );
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  } finally {
    // Hide progress bars and show erase buttons
    for (let index = 1; index < table.rows.length; index++) {
      table.rows[index].cells[2].style.display = 'none';
      table.rows[index].cells[3].style.display = 'initial';
    }
  }
};

addFile.onclick();
