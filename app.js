/* ============================================================
   Crown Connect — app.js  v2.0
   Goboult Crown R Pro 2 BLE Companion App
   Features: auto-reconnect, keep-alive, custom watch face
   ============================================================ */

'use strict';

// ── State ──────────────────────────────────────────────────
let bleDevice         = null;
let gattServer        = null;
let heartRateChar     = null;
let batteryChar       = null;
let notifyActive      = new Map();
let reconnectAttempts = 0;
let isManualDisconnect= false;
let keepAliveTimer    = null;
let reconnectTimer    = null;

const MAX_RECONNECT   = 8;
const KEEPALIVE_MS    = 8000;   // ping every 8 s to prevent idle timeout

// Live data store (shared with watch face)
const liveData = {
  bpm:     null,
  battery: null,
  spo2:    null,
  steps:   null,
};

// Standard GATT lookup tables
const GATT_SERVICES = {
  '00001800-0000-1000-8000-00805f9b34fb': 'Generic Access',
  '00001801-0000-1000-8000-00805f9b34fb': 'Generic Attribute',
  '0000180d-0000-1000-8000-00805f9b34fb': 'Heart Rate',
  '0000180f-0000-1000-8000-00805f9b34fb': 'Battery Service',
  '00001805-0000-1000-8000-00805f9b34fb': 'Current Time',
  '00001816-0000-1000-8000-00805f9b34fb': 'Cycling Speed and Cadence',
  '0000180a-0000-1000-8000-00805f9b34fb': 'Device Information',
  '00001810-0000-1000-8000-00805f9b34fb': 'Blood Pressure',
  '00001809-0000-1000-8000-00805f9b34fb': 'Health Thermometer',
  '00001818-0000-1000-8000-00805f9b34fb': 'Cycling Power',
  '00001814-0000-1000-8000-00805f9b34fb': 'Running Speed and Cadence',
  '00001802-0000-1000-8000-00805f9b34fb': 'Immediate Alert',
  '00001803-0000-1000-8000-00805f9b34fb': 'Link Loss',
  '0000180e-0000-1000-8000-00805f9b34fb': 'Phone Alert Status',
  '00001811-0000-1000-8000-00805f9b34fb': 'Alert Notification',
  '0000fee0-0000-1000-8000-00805f9b34fb': 'Fitness Activity (Proprietary)',
  '0000fee1-0000-1000-8000-00805f9b34fb': 'Fitness Data (Proprietary)',
};

const GATT_CHARACTERISTICS = {
  '00002a37-0000-1000-8000-00805f9b34fb': 'Heart Rate Measurement',
  '00002a38-0000-1000-8000-00805f9b34fb': 'Body Sensor Location',
  '00002a19-0000-1000-8000-00805f9b34fb': 'Battery Level',
  '00002a2b-0000-1000-8000-00805f9b34fb': 'Current Time',
  '00002a00-0000-1000-8000-00805f9b34fb': 'Device Name',
  '00002a01-0000-1000-8000-00805f9b34fb': 'Appearance',
  '00002a04-0000-1000-8000-00805f9b34fb': 'Peripheral Preferred Connection Parameters',
  '00002a24-0000-1000-8000-00805f9b34fb': 'Model Number String',
  '00002a25-0000-1000-8000-00805f9b34fb': 'Serial Number String',
  '00002a26-0000-1000-8000-00805f9b34fb': 'Firmware Revision String',
  '00002a27-0000-1000-8000-00805f9b34fb': 'Hardware Revision String',
  '00002a28-0000-1000-8000-00805f9b34fb': 'Software Revision String',
  '00002a29-0000-1000-8000-00805f9b34fb': 'Manufacturer Name String',
};

// ── DOM Helpers ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

function setStatusUI(state) {
  const dot  = $('statusDot');
  const text = $('statusText');
  dot.className = 'status-dot ' + state;
  const labels = { connected: 'Connected', connecting: 'Connecting…',
                   reconnecting: 'Reconnecting…', disconnected: 'Disconnected' };
  text.textContent = labels[state] || state;
}

function showToast(msg, duration = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function rawLog(type, msg) {
  const out  = $('rawOutput');
  const line = document.createElement('div');
  line.className = 'log-line log-' + type;
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  line.innerHTML = `<span class="log-time">[${ts}]</span>${escapeHtml(msg)}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Browser Check ───────────────────────────────────────────
function checkBrowser() {
  if (!navigator.bluetooth) {
    $('browserWarning').style.display = 'flex';
    $('connectBtn').disabled = true;
    return false;
  }
  return true;
}

// ── Clock & Watch Face ──────────────────────────────────────
function updateClock() {
  const now  = new Date();
  const h    = String(now.getHours()).padStart(2, '0');
  const m    = String(now.getMinutes()).padStart(2, '0');
  const s    = String(now.getSeconds()).padStart(2, '0');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Hero watch display
  if ($('watchTimeDisplay')) {
    $('watchTimeDisplay').textContent = `${h}:${m}`;
    $('watchDateDisplay').textContent = `${days[now.getDay()].slice(0,3)} ${now.getDate()} ${mons[now.getMonth()]}`;
  }

  // Custom watch face canvas
  drawWatchFace(now);
}

setInterval(updateClock, 1000);
updateClock();

// ── Custom Watch Face (Canvas) ──────────────────────────────
function drawWatchFace(now) {
  const canvas = $('watchFaceCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const R  = Math.min(W, H) / 2 - 4;

  ctx.clearRect(0, 0, W, H);

  // ── Background circle ──
  const bgGrad = ctx.createRadialGradient(cx, cy - R * 0.3, 0, cx, cy, R);
  bgGrad.addColorStop(0, '#0d1f3c');
  bgGrad.addColorStop(1, '#050b1a');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = bgGrad;
  ctx.fill();

  // ── Outer ring ──
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#1e3a8a';
  ctx.lineWidth = 3;
  ctx.stroke();

  // ── Tick marks ──
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const isMajor = i % 5 === 0;
    const len = isMajor ? 10 : 5;
    const r1 = R - 3;
    const r2 = r1 - len;
    ctx.beginPath();
    ctx.moveTo(cx + r1 * Math.cos(angle), cy + r1 * Math.sin(angle));
    ctx.lineTo(cx + r2 * Math.cos(angle), cy + r2 * Math.sin(angle));
    ctx.strokeStyle = isMajor ? '#3b82f6' : '#1e3a8a';
    ctx.lineWidth   = isMajor ? 2 : 1;
    ctx.stroke();
  }

  // ── Hour numbers ──
  ctx.font = `bold ${R * 0.13}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const nr = R - 28;
    ctx.fillStyle = '#60a5fa';
    ctx.fillText(i, cx + nr * Math.cos(angle), cy + nr * Math.sin(angle));
  }

  // ── Time values ──
  const hh = now.getHours() % 12 + now.getMinutes() / 60;
  const mm = now.getMinutes() + now.getSeconds() / 60;
  const ss = now.getSeconds();

  // Hour hand
  drawHand(ctx, cx, cy, (hh / 12) * Math.PI * 2 - Math.PI / 2,
           R * 0.48, 5, '#93c5fd', '#1d4ed8');

  // Minute hand
  drawHand(ctx, cx, cy, (mm / 60) * Math.PI * 2 - Math.PI / 2,
           R * 0.65, 3, '#bfdbfe', '#3b82f6');

  // Second hand
  const sAngle = (ss / 60) * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(sAngle) * R * 0.2, cy - Math.sin(sAngle) * R * 0.2);
  ctx.lineTo(cx + Math.cos(sAngle) * R * 0.72, cy + Math.sin(sAngle) * R * 0.72);
  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#f43f5e';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // ── Date chip ──
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dateStr = `${days[now.getDay()]} ${now.getDate()} ${mons[now.getMonth()]}`;

  ctx.fillStyle = 'rgba(30,58,138,0.6)';
  const dW = R * 0.72, dH = 20, dX = cx - dW/2, dY = cy + R * 0.35;
  roundRect(ctx, dX, dY, dW, dH, 4);
  ctx.fill();
  ctx.font = `600 ${R * 0.095}px Inter, sans-serif`;
  ctx.fillStyle = '#93c5fd';
  ctx.fillText(dateStr, cx, dY + dH / 2);

  // ── BPM chip (bottom-left arc area) ──
  if (liveData.bpm !== null) {
    ctx.font = `bold ${R * 0.14}px Inter, sans-serif`;
    ctx.fillStyle = '#fb7185';
    ctx.fillText(`♥ ${liveData.bpm}`, cx - R * 0.3, cy + R * 0.62);
    ctx.font = `${R * 0.08}px Inter, sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('BPM', cx - R * 0.3, cy + R * 0.73);
  }

  // ── Battery chip (bottom-right arc area) ──
  if (liveData.battery !== null) {
    ctx.font = `bold ${R * 0.14}px Inter, sans-serif`;
    const battColor = liveData.battery > 50 ? '#34d399' : liveData.battery > 20 ? '#fbbf24' : '#f43f5e';
    ctx.fillStyle = battColor;
    ctx.fillText(`⚡${liveData.battery}%`, cx + R * 0.3, cy + R * 0.62);
    ctx.font = `${R * 0.08}px Inter, sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('BATT', cx + R * 0.3, cy + R * 0.73);
  }

  // ── Brand name ──
  ctx.font = `500 ${R * 0.085}px Inter, sans-serif`;
  ctx.fillStyle = 'rgba(148,163,184,0.5)';
  ctx.fillText('CROWN R PRO 2', cx, cy - R * 0.42);
}

function drawHand(ctx, cx, cy, angle, length, width, colorTip, colorBase) {
  const grad = ctx.createLinearGradient(
    cx, cy,
    cx + length * Math.cos(angle), cy + length * Math.sin(angle)
  );
  grad.addColorStop(0, colorBase);
  grad.addColorStop(1, colorTip);
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(angle) * width * 2, cy - Math.sin(angle) * width * 2);
  ctx.lineTo(cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
  ctx.strokeStyle = grad;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Watch face theme switcher
let currentTheme = 0;
const themes = ['default', 'minimal', 'retro'];
function cycleTheme() {
  currentTheme = (currentTheme + 1) % themes.length;
  showToast(`Watch face: ${themes[currentTheme]}`);
}

// ── Keep-Alive Mechanism ────────────────────────────────────
// Periodically reads battery level to keep BLE connection alive.
// Most watches drop idle connections after 10-30 s.
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(async () => {
    if (!gattServer || !gattServer.connected) {
      stopKeepAlive();
      return;
    }
    try {
      if (batteryChar) {
        await batteryChar.readValue();
      } else {
        // Fallback: reconnect GATT ping
        await gattServer.getPrimaryServices();
      }
    } catch (e) {
      rawLog('warning', `Keep-alive failed: ${e.message}`);
    }
  }, KEEPALIVE_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// ── Page Visibility — reconnect when tab returns to focus ───
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && bleDevice && !bleDevice.gatt.connected && !isManualDisconnect) {
    rawLog('info', 'Tab visible again — attempting reconnect…');
    attemptReconnect();
  }
});

// ── Connect ─────────────────────────────────────────────────
async function connectToWatch() {
  if (!checkBrowser()) return;
  isManualDisconnect = false;
  reconnectAttempts  = 0;

  const btn = $('connectBtn');
  btn.disabled = true;
  $('connectBtnText').textContent = 'Scanning…';
  setStatusUI('connecting');

  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        'battery_service', 'heart_rate', 'current_time', 'device_information',
        '0000180d-0000-1000-8000-00805f9b34fb',
        '0000180f-0000-1000-8000-00805f9b34fb',
        '00001805-0000-1000-8000-00805f9b34fb',
        '0000180a-0000-1000-8000-00805f9b34fb',
        '0000fee0-0000-1000-8000-00805f9b34fb',
        '0000fee1-0000-1000-8000-00805f9b34fb',
        '0000ffd0-0000-1000-8000-00805f9b34fb',
        '0000ffd5-0000-1000-8000-00805f9b34fb',
        '00001530-1212-efde-1523-785feabcd123',
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
      ]
    });

    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
    await doConnect();

  } catch (err) {
    if (err.name !== 'NotFoundError') {
      rawLog('error', `Scan failed: ${err.message}`);
      showToast('❌ ' + err.message, 4000);
    } else {
      rawLog('warning', 'Device selection cancelled.');
    }
    resetConnectUI();
  }
}

async function doConnect() {
  setStatusUI('connecting');
  $('connectBtnText').textContent = 'Connecting…';

  gattServer = await bleDevice.gatt.connect();
  reconnectAttempts = 0;
  notifyActive.clear();

  setStatusUI('connected');
  showToast(`✓ Connected to ${bleDevice.name || 'Unknown Device'}`);
  rawLog('success', `Connected to "${bleDevice.name || 'Unknown Device'}"`);

  // Show UI
  $('heroSection').style.display     = 'none';
  $('dashboard').style.display       = 'flex';
  $('dashboard').style.flexDirection = 'column';
  $('watchFaceSection').style.display= 'flex';
  $('disconnectBtn').style.display   = 'inline-flex';

  $('deviceName').textContent = bleDevice.name || 'Unknown Device';
  $('gattStatus').textContent = 'Connected';

  // Start keep-alive first
  startKeepAlive();

  // Load data
  await discoverAndRenderServices();
  await readBattery();
  await startHeartRate();
}

// ── Auto-Reconnect ──────────────────────────────────────────
function onDisconnected() {
  stopKeepAlive();
  gattServer    = null;
  heartRateChar = null;
  batteryChar   = null;

  if (isManualDisconnect) {
    rawLog('info', 'Disconnected (manual).');
    showToast('Disconnected');
    fullReset();
    return;
  }

  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT) {
    rawLog('error', `Reconnect failed after ${MAX_RECONNECT} attempts. Giving up.`);
    showToast('❌ Could not reconnect. Tap "Scan & Connect" to retry.', 5000);
    fullReset();
    return;
  }

  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), 15000);
  setStatusUI('reconnecting');
  $('statusText').textContent = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT})…`;
  showToast(`⚡ Reconnecting in ${Math.round(delay / 1000)}s…`);
  rawLog('warning', `Disconnected. Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT} in ${Math.round(delay/1000)}s…`);

  reconnectTimer = setTimeout(async () => {
    if (isManualDisconnect || !bleDevice) return;
    try {
      await doConnect();
    } catch (e) {
      rawLog('error', `Reconnect attempt ${reconnectAttempts} failed: ${e.message}`);
      onDisconnected(); // trigger next attempt with backoff
    }
  }, delay);
}

function fullReset() {
  notifyActive.clear();
  bleDevice    = null;
  gattServer   = null;
  heartRateChar= null;
  batteryChar  = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  $('heroSection').style.display     = 'grid';
  $('dashboard').style.display       = 'none';
  $('watchFaceSection').style.display= 'none';
  setStatusUI('disconnected');
  resetConnectUI();
}

// ── Manual Disconnect ───────────────────────────────────────
function disconnectWatch() {
  isManualDisconnect = true;
  stopKeepAlive();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
  fullReset();
  showToast('Disconnected');
  rawLog('info', 'Manually disconnected.');
}

function resetConnectUI() {
  $('connectBtn').disabled        = false;
  $('connectBtnText').textContent = 'Scan & Connect';
  $('disconnectBtn').style.display= 'none';
}

// ── Service Discovery ───────────────────────────────────────
async function discoverAndRenderServices() {
  const container = $('servicesContainer');
  container.innerHTML = `<div class="services-loading"><div class="spinner"></div><span>Discovering services…</span></div>`;

  try {
    const services = await gattServer.getPrimaryServices();
    $('servicesCount').textContent = services.length + ' found';
    container.innerHTML = '';

    for (const svc of services) {
      const uuid  = svc.uuid;
      const known = GATT_SERVICES[uuid];
      const isStd = !!known;
      const name  = known || 'Proprietary Service';

      const svcDiv = document.createElement('div');
      svcDiv.className = 'service-item';

      const hdr = document.createElement('div');
      hdr.className = 'service-header';
      hdr.innerHTML = `
        <span class="service-tag ${isStd ? 'standard' : 'proprietary'}">${isStd ? 'STD' : 'OEM'}</span>
        <span class="service-name">${escapeHtml(name)}</span>
        <span class="service-uuid">${uuid}</span>
        <svg class="service-toggle" viewBox="0 0 24 24" fill="none" width="16" height="16">
          <polyline points="9 18 15 12 9 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

      const charsDiv = document.createElement('div');
      charsDiv.className = 'service-chars';
      charsDiv.style.display = 'none';

      hdr.addEventListener('click', async () => {
        const tog = hdr.querySelector('.service-toggle');
        if (charsDiv.style.display === 'none') {
          charsDiv.style.display = 'flex';
          tog.classList.add('open');
          if (!charsDiv.dataset.loaded) {
            charsDiv.innerHTML = `<div class="services-loading"><div class="spinner"></div><span>Loading characteristics…</span></div>`;
            try {
              const chars = await svc.getCharacteristics();
              charsDiv.innerHTML = '';
              charsDiv.dataset.loaded = '1';
              for (const ch of chars) charsDiv.appendChild(buildCharRow(ch));
              if (chars.length === 0)
                charsDiv.innerHTML = `<div style="font-size:0.8rem;color:var(--text-muted);padding:6px 0;">No characteristics found.</div>`;
            } catch (e) {
              charsDiv.innerHTML = `<div class="log-line log-error">Failed: ${escapeHtml(e.message)}</div>`;
            }
          }
        } else {
          charsDiv.style.display = 'none';
          tog.classList.remove('open');
        }
      });

      svcDiv.appendChild(hdr);
      svcDiv.appendChild(charsDiv);
      container.appendChild(svcDiv);
    }

    if (services.length === 0)
      container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:16px 0;">No services found.</div>`;

  } catch (err) {
    container.innerHTML = `<div class="log-line log-error">Discovery failed: ${escapeHtml(err.message)}</div>`;
    rawLog('error', 'Service discovery error: ' + err.message);
  }
}

function buildCharRow(char) {
  const uuid  = char.uuid;
  const known = GATT_CHARACTERISTICS[uuid] || 'Unknown Characteristic';
  const props = char.properties;

  const propList = [];
  if (props.read)     propList.push('<span class="char-prop prop-read">READ</span>');
  if (props.write || props.writeWithoutResponse)
                      propList.push('<span class="char-prop prop-write">WRITE</span>');
  if (props.notify)   propList.push('<span class="char-prop prop-notify">NOTIFY</span>');
  if (props.indicate) propList.push('<span class="char-prop prop-indicate">INDICATE</span>');

  const row = document.createElement('div');
  row.className = 'char-row';
  row.innerHTML = `
    <span class="char-name">${escapeHtml(known)}</span>
    <span class="char-uuid">${uuid}</span>
    <div class="char-props">${propList.join('')}</div>
    ${props.read ? `<button class="char-read-btn" data-uuid="${uuid}">Read</button>` : ''}
    <span class="char-value" id="charVal-${uuid.replace(/-/g,'')}"></span>`;

  if (props.read) {
    row.querySelector('.char-read-btn').addEventListener('click', async () => {
      try {
        const val  = await char.readValue();
        const hex  = Array.from(new Uint8Array(val.buffer)).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
        const text = tryDecodeText(val);
        const display = text ? `${text}  [${hex}]` : `[${hex}]`;
        const el = $('charVal-' + uuid.replace(/-/g,''));
        if (el) el.textContent = display;
        rawLog('data', `Read ${known}: ${display}`);
      } catch (e) {
        rawLog('error', `Read "${known}" failed: ${e.message}`);
      }
    });
  }

  return row;
}

function tryDecodeText(dataView) {
  try {
    const bytes = new Uint8Array(dataView.buffer);
    const str   = new TextDecoder('utf-8').decode(bytes);
    if (/^[\x20-\x7E\s]*$/.test(str) && str.trim().length > 0) return str.trim();
    if (bytes.length === 1) return `${bytes[0]}`;
    return null;
  } catch { return null; }
}

async function refreshServices() {
  if (!gattServer) return showToast('Not connected');
  await discoverAndRenderServices();
}

// ── Heart Rate ──────────────────────────────────────────────
async function startHeartRate() {
  $('hrStatus').textContent = 'Connecting…';
  try {
    const svc  = await gattServer.getPrimaryService('heart_rate');
    heartRateChar = await svc.getCharacteristic('heart_rate_measurement');
    await heartRateChar.startNotifications();
    heartRateChar.addEventListener('characteristicvaluechanged', onHeartRate);
    $('hrStatus').textContent = 'Live';
    rawLog('success', 'Heart rate notifications started.');
    notifyActive.set(heartRateChar.uuid, heartRateChar);
  } catch (e) {
    $('hrStatus').textContent      = 'N/A';
    $('heartRateValue').textContent = '—';
    rawLog('warning', 'Heart rate service not available: ' + e.message);
  }
}

function onHeartRate(event) {
  const value = event.target.value;
  const flags = value.getUint8(0);
  const bpm   = (flags & 0x01) ? value.getUint16(1, true) : value.getUint8(1);
  liveData.bpm = bpm;
  $('heartRateValue').textContent = bpm;
  $('wfBpm').textContent = bpm;
  updateHeartbeatCanvas(bpm);
  rawLog('data', `Heart rate: ${bpm} BPM`);
}

// ── Heartbeat Canvas ─────────────────────────────────────────
let hbPoints = new Array(100).fill(0);

function updateHeartbeatCanvas(bpm) {
  const canvas = $('heartbeatCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const seg = [0, 0, 0.15, -0.1, 1, -0.35, 0.15, 0.05, 0, 0];
  hbPoints.push(...seg);
  if (hbPoints.length > W) hbPoints = hbPoints.slice(-W);

  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,   'rgba(251,113,133,0)');
  grad.addColorStop(0.5, 'rgba(251,113,133,0.8)');
  grad.addColorStop(1,   'rgba(251,113,133,1)');

  ctx.beginPath();
  ctx.strokeStyle = grad;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  for (let i = 0; i < hbPoints.length; i++) {
    const x = i * (W / hbPoints.length);
    const y = H / 2 - hbPoints[i] * (H / 2 - 4);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

(function initCanvas() {
  const canvas = $('heartbeatCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(251,113,133,0.2)';
  ctx.lineWidth   = 1;
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
})();

// ── Battery ─────────────────────────────────────────────────
async function readBattery() {
  $('battStatus').textContent = 'Reading…';
  try {
    const svc  = await gattServer.getPrimaryService('battery_service');
    batteryChar = await svc.getCharacteristic('battery_level');

    const updateBatt = (lvl) => {
      liveData.battery = lvl;
      $('batteryValue').textContent = lvl;
      $('wfBattery').textContent    = lvl + '%';
      $('battStatus').textContent   = lvl >= 20 ? 'Good' : 'Low!';
      $('batteryFill').style.width  = lvl + '%';
      const fill = $('batteryFill');
      fill.style.background = lvl <= 20
        ? 'linear-gradient(90deg,#be123c,#f43f5e)'
        : lvl <= 50
          ? 'linear-gradient(90deg,#b45309,#f59e0b)'
          : 'linear-gradient(90deg,#059669,#10b981,#34d399)';
      $('batteryFooter').textContent = lvl >= 20
        ? `Battery at ${lvl}% — Good to go`
        : `Low battery — please charge soon`;
    };

    const val = await batteryChar.readValue();
    updateBatt(val.getUint8(0));
    rawLog('success', `Battery: ${val.getUint8(0)}%`);

    try {
      await batteryChar.startNotifications();
      batteryChar.addEventListener('characteristicvaluechanged', e => {
        updateBatt(e.target.value.getUint8(0));
      });
      notifyActive.set(batteryChar.uuid, batteryChar);
    } catch (_) {}

  } catch (e) {
    $('battStatus').textContent     = 'N/A';
    $('batteryValue').textContent   = '—';
    $('batteryFooter').textContent  = 'Battery service not available';
    rawLog('warning', 'Battery service N/A: ' + e.message);
  }
}

// ── SpO2 ─────────────────────────────────────────────────────
function setSpO2(val) {
  liveData.spo2 = val;
  $('spo2Value').textContent = val;
  const arc = $('gaugeArc');
  if (arc) arc.style.strokeDashoffset = 141 - (141 * (val / 100));
  const footer = $('spo2Footer');
  footer.textContent = val >= 95 ? 'Normal SpO₂ (≥95%)' : val >= 90 ? 'Slightly low SpO₂' : '⚠ Low SpO₂ — check again';
}
$('spo2Status').textContent = 'No std. GATT';
$('spo2Footer').textContent = 'SpO₂ via proprietary channel';
$('stepsStatus').textContent = 'No std. GATT';
$('stepsFooter').textContent  = 'Steps via proprietary channel';

// ── Raw Tool ─────────────────────────────────────────────────
async function readRawChar() {
  if (!gattServer) { rawLog('error', 'Not connected.'); return; }
  const svcUUID  = $('rawServiceUUID').value.trim().toLowerCase();
  const charUUID = $('rawCharUUID').value.trim().toLowerCase();
  if (!svcUUID || !charUUID) { rawLog('error', 'Enter both UUIDs.'); return; }
  rawLog('info', `Reading svc=${svcUUID} char=${charUUID}…`);
  try {
    const svc  = await gattServer.getPrimaryService(svcUUID);
    const char = await svc.getCharacteristic(charUUID);
    const val  = await char.readValue();
    const bytes = new Uint8Array(val.buffer);
    const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
    const dec   = Array.from(bytes).join(', ');
    const text  = tryDecodeText(val) || '';
    rawLog('data', `HEX:  ${hex}`);
    rawLog('data', `DEC:  [${dec}]`);
    if (text) rawLog('data', `TEXT: "${text}"`);
  } catch (e) {
    rawLog('error', `Read failed: ${e.message}`);
  }
}

async function writeRawChar() {
  if (!gattServer) { rawLog('error', 'Not connected.'); return; }
  const svcUUID  = $('rawServiceUUID').value.trim().toLowerCase();
  const charUUID = $('rawCharUUID').value.trim().toLowerCase();
  const hexStr   = $('rawWriteData').value.trim();
  if (!svcUUID || !charUUID) { rawLog('error', 'Enter both UUIDs.'); return; }
  if (!hexStr) { rawLog('error', 'Enter hex bytes to write.'); return; }
  let bytes;
  try {
    bytes = new Uint8Array(hexStr.split(/\s+/).map(h => parseInt(h, 16)));
  } catch { rawLog('error', 'Invalid hex format.'); return; }
  rawLog('info', `Writing [${hexStr}] to char=${charUUID}…`);
  try {
    const svc  = await gattServer.getPrimaryService(svcUUID);
    const char = await svc.getCharacteristic(charUUID);
    char.properties.write
      ? await char.writeValue(bytes)
      : await char.writeValueWithoutResponse(bytes);
    rawLog('success', 'Write successful!');
  } catch (e) { rawLog('error', `Write failed: ${e.message}`); }
}

async function subscribeRawChar() {
  if (!gattServer) { rawLog('error', 'Not connected.'); return; }
  const svcUUID  = $('rawServiceUUID').value.trim().toLowerCase();
  const charUUID = $('rawCharUUID').value.trim().toLowerCase();
  if (!svcUUID || !charUUID) { rawLog('error', 'Enter both UUIDs.'); return; }

  if (notifyActive.has(charUUID)) {
    try {
      await notifyActive.get(charUUID).stopNotifications();
      notifyActive.delete(charUUID);
      rawLog('warning', `Unsubscribed from ${charUUID}`);
    } catch (e) { rawLog('error', `Unsubscribe failed: ${e.message}`); }
    return;
  }

  rawLog('info', `Subscribing to ${charUUID}…`);
  try {
    const svc  = await gattServer.getPrimaryService(svcUUID);
    const char = await svc.getCharacteristic(charUUID);
    await char.startNotifications();
    notifyActive.set(charUUID, char);
    char.addEventListener('characteristicvaluechanged', e => {
      const bytes = new Uint8Array(e.target.value.buffer);
      const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      rawLog('data', `NOTIFY → HEX: ${hex}  DEC: [${Array.from(bytes).join(', ')}]`);
      if (bytes.length >= 1 && bytes[0] >= 80 && bytes[0] <= 100) {
        setSpO2(bytes[0]); $('spo2Status').textContent = 'Live';
      }
      if (bytes.length >= 4) {
        const steps = new DataView(bytes.buffer).getUint32(0, true);
        if (steps > 0 && steps < 100000) {
          liveData.steps = steps;
          $('stepsValue').textContent = steps.toLocaleString('en-IN');
          const pct = Math.min((steps / 10000) * 100, 100);
          $('stepsFill').style.width = pct + '%';
          $('stepsStatus').textContent = 'Live';
          $('stepsFooter').textContent = `${Math.round(pct)}% of 10,000 goal`;
        }
      }
    });
    rawLog('success', 'Subscribed! Click again to stop.');
  } catch (e) { rawLog('error', `Subscribe failed: ${e.message}`); }
}

function clearRawLog() {
  $('rawOutput').innerHTML = '<div class="log-line log-info">Log cleared.</div>';
}

// ── Init ─────────────────────────────────────────────────────
checkBrowser();
rawLog('info', 'Crown Connect v2.0 ready — BLE auto-reconnect + keep-alive enabled.');
rawLog('info', 'Click "Scan & Connect" to begin.');
