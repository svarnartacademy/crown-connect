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
        'battery_service', 'heart_rate', 'current_time', 'device_information', 'immediate_alert',
        '0000180d-0000-1000-8000-00805f9b34fb',
        '0000180f-0000-1000-8000-00805f9b34fb',
        '00001805-0000-1000-8000-00805f9b34fb',
        '0000180a-0000-1000-8000-00805f9b34fb',
        '00001802-0000-1000-8000-00805f9b34fb',
        '0000fee0-0000-1000-8000-00805f9b34fb',
        '0000fee1-0000-1000-8000-00805f9b34fb',
        '0000ffd0-0000-1000-8000-00805f9b34fb',
        '0000ffd5-0000-1000-8000-00805f9b34fb',
        '00001530-1212-efde-1523-785feabcd123',
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        '0000feea-0000-1000-8000-00805f9b34fb',
        '0000feeb-0000-1000-8000-00805f9b34fb',
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
  await startCustomDataNotifications();

  // Start reminders/scheduler check
  startReminderChecker();
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

  // Log to database if logging is active
  if (isLogging) {
    logCurrentDataPoint('BPM Update');
  }
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

      // Log update if active
      if (isLogging) {
        logCurrentDataPoint('Battery Update');
      }
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

// ── Physical Watch Face Flasher Logic ───────────────────────
let selectedFlashFile = null;
let isFlashing = false;

// Toggle Advanced settings accordion
$('flasherSettingsToggle').addEventListener('click', () => {
  const form = $('flasherAdvancedForm');
  const icon = $('flasherSettingsToggle').querySelector('.toggle-icon');
  if (form.style.display === 'none') {
    form.style.display = 'flex';
    icon.classList.add('open');
  } else {
    form.style.display = 'none';
    icon.classList.remove('open');
  }
});

// Toggle Snoop Guide accordion
$('snoopGuideToggle').addEventListener('click', () => {
  const content = $('snoopGuideContent');
  const icon = $('snoopGuideToggle').querySelector('.toggle-icon');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    icon.classList.add('open');
  } else {
    content.style.display = 'none';
    icon.classList.remove('open');
  }
});

// Dropzone Event Listeners
const dropzone = $('flasherDropzone');
const fileInput = $('flasherFileInput');

dropzone.addEventListener('click', (e) => {
  // Prevent click from bubbling if clicking remove button
  if (e.target.closest('.btn-remove-file')) return;
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleSelectedFile(e.target.files[0]);
  }
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleSelectedFile(e.dataTransfer.files[0]);
  }
});

function handleSelectedFile(file) {
  if (!file.name.endsWith('.bin')) {
    showToast('❌ Only .bin watch face files are supported.');
    return;
  }
  selectedFlashFile = file;
  $('flasherFileName').textContent = file.name;
  
  // Format file size
  const kb = file.size / 1024;
  $('flasherFileSize').textContent = kb >= 1024 
    ? (kb / 1024).toFixed(2) + ' MB' 
    : kb.toFixed(1) + ' KB';
    
  $('flasherFileInfo').style.display = 'flex';
  $('startFlashBtn').classList.remove('disabled');
  showToast('✓ Watch face file loaded');
  rawLog('info', `File loaded: ${file.name} (${file.size} bytes)`);
}

function removeFlasherFile(event) {
  if (event) event.stopPropagation();
  selectedFlashFile = null;
  fileInput.value = '';
  $('flasherFileInfo').style.display = 'none';
  $('startFlashBtn').classList.add('disabled');
  $('flashProgressPanel').style.display = 'none';
  
  // Reset preset gallery highlights
  const cards = document.querySelectorAll('.gallery-card');
  cards.forEach(c => c.classList.remove('selected'));
  
  showToast('File removed');
}

// Helper function to sleep
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startWatchFaceFlash() {
  if (isFlashing) return;
  if (!selectedFlashFile) {
    showToast('❌ Please select a watch face file first.');
    return;
  }
  if (!gattServer || !gattServer.connected) {
    showToast('❌ Watch is not connected.');
    return;
  }

  isFlashing = true;
  const startBtn = $('startFlashBtn');
  startBtn.classList.add('flashing');
  startBtn.disabled = true;
  $('flashProgressPanel').style.display = 'block';
  
  // Update status UI
  $('flashStatusText').textContent = 'Initializing DFU service…';
  $('flashProgressPct').textContent = '0%';
  $('flashProgressFill').style.width = '0%';
  $('flashSpeedVal').textContent = '0 KB/s';
  $('flashTimeRemaining').textContent = '--:-- remaining';

  rawLog('info', 'Starting watch face DFU flashing sequence…');

  let notificationChar = null;
  try {
    // 1. Get DFU service details from UI inputs
    const serviceUUID = $('dfuServiceUUID').value.trim().toLowerCase();
    const cmdCharUUID = $('dfuCmdUUID').value.trim().toLowerCase();
    const dataCharUUID = $('dfuDataUUID').value.trim().toLowerCase();

    rawLog('info', `Connecting to DFU Service: ${serviceUUID}`);
    const service = await gattServer.getPrimaryService(serviceUUID);

    // 2. Get characteristics
    rawLog('info', `Fetching DFU Command Char (${cmdCharUUID}) and Data Char (${dataCharUUID})`);
    const cmdChar = await service.getCharacteristic(cmdCharUUID);
    const dataChar = await service.getCharacteristic(dataCharUUID);

    // 3. Subscribe to notifications on status/command response characteristic if possible
    // Note: Standard Moyoung status char is 0xFEE3. We fallback to command char notification if 0xFEE3 is not specified.
    const statusUUID = serviceUUID.includes('feea') 
      ? '0000fee3-0000-1000-8000-00805f9b34fb' 
      : cmdCharUUID;

    try {
      rawLog('info', `Subscribing to notifications on ${statusUUID}…`);
      notificationChar = await service.getCharacteristic(statusUUID);
      await notificationChar.startNotifications();
      notificationChar.addEventListener('characteristicvaluechanged', (e) => {
        const val = new Uint8Array(e.target.value.buffer);
        const hex = Array.from(val).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
        rawLog('data', `DFU Notification → [${hex}]`);
      });
      rawLog('success', 'DFU notifications subscribed.');
    } catch (e) {
      rawLog('warning', `Could not subscribe to DFU notifications: ${e.message}. Proceeding anyway.`);
    }

    // 4. Read file into buffer
    $('flashStatusText').textContent = 'Reading watch face binary…';
    const fileBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(selectedFlashFile);
    });

    const fileBytes = new Uint8Array(fileBuffer);
    const fileSize = fileBytes.length;
    rawLog('info', `File loaded into memory. Size: ${fileSize} bytes.`);

    // 5. Send DFU Start Command to FEE2
    // Command format: [0x01, size_byte0, size_byte1, size_byte2, size_byte3]
    const startPayload = new Uint8Array(5);
    startPayload[0] = 0x01; // Start command ID
    startPayload[1] = fileSize & 0xFF;
    startPayload[2] = (fileSize >> 8) & 0xFF;
    startPayload[3] = (fileSize >> 16) & 0xFF;
    startPayload[4] = (fileSize >> 24) & 0xFF;

    rawLog('info', `Writing DFU Start Command: [01 ${Array.from(startPayload.slice(1)).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}]`);
    await cmdChar.writeValue(startPayload);
    rawLog('success', 'DFU Start Command accepted.');

    // Wait for watch to process/allocate flash memory
    $('flashStatusText').textContent = 'Watch ready. Initializing transfer…';
    await sleep(1000);

    // 6. Loop and send chunks of 256 bytes to FEE5
    const CHUNK_SIZE = 256;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    let bytesSent = 0;
    const startTime = Date.now();

    rawLog('info', `Uploading ${totalChunks} data blocks…`);
    
    // Temporarily pause keep-alive pinging during flashing to avoid interference
    stopKeepAlive();

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (!gattServer || !gattServer.connected) {
        throw new Error('Bluetooth connection lost during flashing!');
      }

      const offset = chunkIdx * CHUNK_SIZE;
      const length = Math.min(CHUNK_SIZE, fileSize - offset);
      const chunk = fileBytes.slice(offset, offset + length);

      // Write block
      // Web Bluetooth: writeValueWithoutResponse is significantly faster and doesn't wait for link ack
      await dataChar.writeValueWithoutResponse(chunk);
      bytesSent += length;

      // Calculate stats
      const percent = Math.round((bytesSent / fileSize) * 100);
      const elapsedMs = Date.now() - startTime;
      const speedKbps = elapsedMs > 0 ? (bytesSent / 1024) / (elapsedMs / 1000) : 0;
      
      const remainingBytes = fileSize - bytesSent;
      const remainingSeconds = speedKbps > 0 ? (remainingBytes / 1024) / speedKbps : 0;
      const remMin = Math.floor(remainingSeconds / 60);
      const remSec = Math.floor(remainingSeconds % 60);

      // Update UI
      $('flashStatusText').textContent = `Uploading block ${chunkIdx + 1} of ${totalChunks}…`;
      $('flashProgressPct').textContent = `${percent}%`;
      $('flashProgressFill').style.width = `${percent}%`;
      $('flashSpeedVal').textContent = `${speedKbps.toFixed(1)} KB/s`;
      $('flashTimeRemaining').textContent = `${remMin}:${String(remSec).padStart(2,'0')} remaining`;

      // Throttle packet flow slightly to avoid overloading Bluetooth Tx buffers (30ms sleep per block)
      await sleep(30);
    }

    // 7. Send DFU Complete/Checksum Command to FEE2
    // Command format: [0x02] (signal completion/verify/reboot)
    $('flashStatusText').textContent = 'Verifying watch face flash…';
    rawLog('info', 'Sending DFU Finish Command [02]…');
    const finishPayload = new Uint8Array([0x02]);
    await cmdChar.writeValue(finishPayload);
    rawLog('success', 'DFU Finish Command sent.');

    // 8. Finalize UI
    $('flashStatusText').textContent = 'Flash Complete!';
    $('flashProgressPct').textContent = '100%';
    $('flashProgressFill').style.width = '100%';
    showToast('✓ Watch face flashed successfully!');
    rawLog('success', `Completed flashing ${fileSize} bytes in ${((Date.now() - startTime)/1000).toFixed(1)}s.`);
    
    // Wait a brief moment and clean up file input
    await sleep(2000);
    removeFlasherFile();

  } catch (err) {
    rawLog('error', `Flashing failed: ${err.message}`);
    showToast('❌ Flashing failed: ' + err.message, 5000);
    $('flashStatusText').textContent = 'Failed: ' + err.message;
  } finally {
    isFlashing = false;
    startBtn.classList.remove('flashing');
    startBtn.disabled = false;
    
    // Clean up notifications if active
    if (notificationChar) {
      try {
        await notificationChar.stopNotifications();
      } catch (_) {}
    }
    
    // Restart keep-alive pinging
    startKeepAlive();
  }
}

async function selectPresetWatchFace(presetName, filePath, cardElement) {
  try {
    // 1. Highlight selected card
    const cards = document.querySelectorAll('.gallery-card');
    cards.forEach(c => c.classList.remove('selected'));
    if (cardElement) {
      cardElement.classList.add('selected');
    }

    rawLog('info', `Loading preset watch face: ${presetName} from ${filePath}…`);
    showToast(`Loading ${presetName}…`);

    // 2. Fetch the file via HTTP
    const res = await fetch(filePath);
    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }
    const blob = await res.blob();

    // 3. Create a File object from blob (so it works like user-uploaded file)
    selectedFlashFile = new File([blob], `${presetName.toLowerCase().replace(/\s+/g, '_')}.bin`, { type: 'application/octet-stream' });
    
    // 4. Update uploader UI
    $('flasherFileName').textContent = selectedFlashFile.name;
    const kb = selectedFlashFile.size / 1024;
    $('flasherFileSize').textContent = kb >= 1024 
      ? (kb / 1024).toFixed(2) + ' MB' 
      : kb.toFixed(1) + ' KB';
      
    $('flasherFileInfo').style.display = 'flex';
    $('startFlashBtn').classList.remove('disabled');
    
    showToast(`✓ Loaded ${presetName}`);
    rawLog('success', `Preset "${presetName}" loaded successfully (${selectedFlashFile.size} bytes).`);
  } catch (err) {
    rawLog('error', `Failed to load preset "${presetName}": ${err.message}`);
    showToast(`❌ Failed to load preset: ${err.message}`);
  }
}

// Helper to flash the alarms section UI
function flashAlarmsUI() {
  const section = document.querySelector('.alarms-section');
  if (section) {
    section.classList.remove('ui-flash-active');
    // Force reflow
    void section.offsetWidth;
    section.classList.add('ui-flash-active');
  }
}

// Helper to play browser audio chime
function playBrowserChime() {
  try {
    initAudioContext();
    if (audioCtx) {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const now = audioCtx.currentTime;
      // Play a triple beep chime
      playNote(880, 'sine', 0.1, now);
      playNote(880, 'sine', 0.1, now + 0.15);
      playNote(880, 'sine', 0.15, now + 0.3);
      rawLog('info', '🔊 Played browser audio chime fallback.');
    } else {
      rawLog('warning', 'Audio Context not initialized. Browser chime skipped.');
    }
  } catch (err) {
    rawLog('error', `Failed to play browser chime: ${err.message}`);
  }
}

// Helper to try custom MoYoung haptic command
async function tryMoYoungVibration(level) {
  try {
    rawLog('info', 'Watch haptic profile (0x1802) unsupported. Trying custom Fitness Channel (0xFEE0) fallback…');
    const service = await gattServer.getPrimaryService('0000fee0-0000-1000-8000-00805f9b34fb');
    let char;
    try {
      char = await service.getCharacteristic('0000fee2-0000-1000-8000-00805f9b34fb');
    } catch (_) {
      char = await service.getCharacteristic('0000fee1-0000-1000-8000-00805f9b34fb');
    }
    const cmd = level > 0 ? 0x01 : 0x00;
    const value = new Uint8Array([0x05, cmd]);
    rawLog('info', `Writing custom command [05 ${cmd.toString(16).padStart(2,'0').toUpperCase()}] to characteristic ${char.uuid}…`);
    await char.writeValue(value);
    rawLog('success', 'Custom MoYoung vibration command written successfully.');
    return true;
  } catch (err) {
    rawLog('warning', `Custom Fitness Channel haptic command failed: ${err.message}`);
    return false;
  }
}

// ── Vibration Alerts & Alarms ────────────────────────────────
async function triggerWatchVibration() {
  if (!gattServer || !gattServer.connected) {
    showToast('❌ Watch is not connected.');
    return;
  }
  const levelSelect = $('vibrationLevel');
  const level = parseInt(levelSelect.value, 10);
  
  let success = false;
  try {
    rawLog('info', 'Resolving Immediate Alert service (0x1802)…');
    const service = await gattServer.getPrimaryService('immediate_alert');
    const char = await service.getCharacteristic('00002a06-0000-1000-8000-00805f9b34fb');
    
    rawLog('info', `Writing Alert Level = ${level} to Immediate Alert characteristic…`);
    const value = new Uint8Array([level]);
    await char.writeValue(value);
    success = true;
    
    if (level === 0) {
      showToast('✓ Vibration stopped');
      rawLog('success', 'Vibration command sent: Alert Level 0 (Off)');
    } else {
      showToast('✓ Vibration triggered');
      rawLog('success', `Vibration command sent: Alert Level ${level}`);
    }
  } catch (err) {
    rawLog('warning', `Standard Immediate Alert (0x1802) failed: ${err.message}`);
    
    // Attempt fallback MoYoung command
    success = await tryMoYoungVibration(level);
    
    if (success) {
      if (level === 0) {
        showToast('✓ Vibration stopped via fallback');
      } else {
        showToast('✓ Vibration triggered via fallback');
      }
    } else {
      // Complete fallback: Web UI flash + browser audio chime
      rawLog('warning', 'Watch haptic profiles unsupported or write failed. Falling back to browser alert/chime.');
      showToast('🔔 Watch vibration failed. Triggering browser chime & flash.');
      flashAlarmsUI();
      if (level > 0) {
        playBrowserChime();
      }
    }
  }
}

let reminders = [];
let reminderCheckerInterval = null;

function addReminder() {
  const labelInput = $('reminderLabel');
  const timeInput = $('reminderTime');
  const label = labelInput.value.trim() || 'Reminder';
  const timeVal = timeInput.value;
  
  if (!timeVal) {
    showToast('❌ Please select a time.');
    return;
  }
  
  const id = Date.now().toString();
  reminders.push({ id, label, time: timeVal, triggered: false });
  labelInput.value = '';
  timeInput.value = '';
  
  updateRemindersUI();
  saveRemindersToStorage();
  showToast('✓ Reminder scheduled');
  rawLog('info', `Scheduled reminder "${label}" for ${timeVal}`);
}

function deleteReminder(id) {
  reminders = reminders.filter(r => r.id !== id);
  updateRemindersUI();
  saveRemindersToStorage();
  showToast('Reminder deleted');
}

function updateRemindersUI() {
  const list = $('remindersList');
  list.innerHTML = '';
  
  if (reminders.length === 0) {
    list.innerHTML = '<li class="reminder-empty">No active reminders. Schedule one above.</li>';
    return;
  }
  
  reminders.sort((a, b) => a.time.localeCompare(b.time));
  
  reminders.forEach(r => {
    const li = document.createElement('li');
    li.className = `reminder-item ${r.triggered ? 'triggered' : ''}`;
    li.innerHTML = `
      <div class="reminder-info">
        <span class="reminder-time-tag">${r.time}</span>
        <span class="reminder-text">${escapeHtml(r.label)}</span>
        ${r.triggered ? '<small style="color:var(--emerald);margin-left:6px;">(Sent)</small>' : ''}
      </div>
      <button class="btn-delete-reminder" onclick="deleteReminder('${r.id}')" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    `;
    list.appendChild(li);
  });
}

function saveRemindersToStorage() {
  localStorage.setItem('ble_reminders', JSON.stringify(reminders));
}

function loadRemindersFromStorage() {
  try {
    const stored = localStorage.getItem('ble_reminders');
    if (stored) {
      reminders = JSON.parse(stored);
      reminders.forEach(r => r.triggered = false);
      updateRemindersUI();
    }
  } catch (e) {
    console.error('Failed to load reminders:', e);
  }
}

function startReminderChecker() {
  if (reminderCheckerInterval) clearInterval(reminderCheckerInterval);
  reminderCheckerInterval = setInterval(() => {
    const now = new Date();
    const currentH = String(now.getHours()).padStart(2, '0');
    const currentM = String(now.getMinutes()).padStart(2, '0');
    const timeStr = `${currentH}:${currentM}`;
    
    reminders.forEach(async (r) => {
      if (r.time === timeStr && !r.triggered) {
        r.triggered = true;
        updateRemindersUI();
        rawLog('info', `⏰ Reminder triggered: "${r.label}" at ${r.time}`);
        showToast(`⏰ Reminder: ${r.label}`);
        
        let success = false;
        if (gattServer && gattServer.connected) {
          try {
            const service = await gattServer.getPrimaryService('immediate_alert');
            const char = await service.getCharacteristic('00002a06-0000-1000-8000-00805f9b34fb');
            await char.writeValue(new Uint8Array([2]));
            rawLog('success', `Vibration triggered on watch for reminder: "${r.label}"`);
            success = true;
            
            setTimeout(async () => {
              if (gattServer && gattServer.connected) {
                try {
                  await char.writeValue(new Uint8Array([0]));
                  rawLog('info', 'Auto-stopped reminder vibration.');
                } catch (_) {}
              }
            }, 4000);
          } catch (err) {
            rawLog('warning', `Standard vibration failed for reminder: ${err.message}`);
            // Try MoYoung custom vibration fallback
            success = await tryMoYoungVibration(2);
            if (success) {
              setTimeout(async () => {
                if (gattServer && gattServer.connected) {
                  await tryMoYoungVibration(0);
                  rawLog('info', 'Auto-stopped fallback vibration.');
                }
              }, 4000);
            }
          }
        }
        
        if (!success) {
          rawLog('warning', `Watch haptic fails for reminder "${r.label}". Falling back to browser chime & flash.`);
          flashAlarmsUI();
          playBrowserChime();
        }
      }
      
      if (r.time !== timeStr && r.triggered) {
        r.triggered = false;
        updateRemindersUI();
      }
    });
  }, 10000);
}

// ── Media Player & Watch Remote Mapping ─────────────────────
let audioCtx = null;
let synthInterval = null;
let isMediaPlaying = false;
let mediaDuration = 90; 
let mediaCurrentTime = 0;
let mediaProgressTimer = null;
let mediaVolume = 70; 
let mediaVolumeNode = null;

const trackList = [
  { title: 'BLE Synthwave Wavefront', artist: 'Companion Synthesizer', duration: 90 },
  { title: 'GATT Protocol Chillout', artist: 'HCI Snoop Log feat. BLE', duration: 120 },
  { title: 'Heartbeat Frequency', artist: 'Live BPM Ensemble', duration: 75 }
];
let currentTrackIdx = 0;

function initAudioContext() {
  if (audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();
  mediaVolumeNode = audioCtx.createGain();
  mediaVolumeNode.gain.value = mediaVolume / 100;
  mediaVolumeNode.connect(audioCtx.destination);
}

function playNote(freq, type, duration, time) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  
  gainNode.gain.setValueAtTime(0, time);
  gainNode.gain.linearRampToValueAtTime(0.18 * (mediaVolume / 100), time + 0.05);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  
  osc.connect(gainNode);
  gainNode.connect(mediaVolumeNode);
  
  osc.start(time);
  osc.stop(time + duration);
}

function playKick(time) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(mediaVolumeNode);
  
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.15);
  
  gain.gain.setValueAtTime(0.4 * (mediaVolume / 100), time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
  
  osc.start(time);
  osc.stop(time + 0.15);
}

function playSnare(time) {
  if (!audioCtx) return;
  const bufferSize = audioCtx.sampleRate * 0.15;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  
  const noiseNode = audioCtx.createBufferSource();
  noiseNode.buffer = buffer;
  
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.setValueAtTime(1000, time);
  
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.12 * (mediaVolume / 100), time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + 0.15);
  
  noiseNode.connect(filter);
  filter.connect(gain);
  gain.connect(mediaVolumeNode);
  
  noiseNode.start(time);
  noiseNode.stop(time + 0.15);
}

function startSynthPlayback() {
  initAudioContext();
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  
  isMediaPlaying = true;
  $('mediaPlayBtn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" id="pauseIconSvg"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>`;
  $('albumArtDisk').classList.add('playing');
  
  let step = 0;
  const bassNotes = [110, 110, 130, 130, 146, 146, 165, 165]; 
  const leadNotes = [440, 494, 523, 587, 659, 587, 523, 494, 0, 440, 0, 523, 659, 784, 0, 659];
  
  const tempo = 125; 
  const stepTime = 60 / tempo / 2; 
  
  let nextNoteTime = audioCtx.currentTime;
  
  function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + 0.1) {
      const bassFreq = bassNotes[step % bassNotes.length];
      playNote(bassFreq, 'sawtooth', 0.25, nextNoteTime);
      
      if (step % 4 === 0) {
        playKick(nextNoteTime);
      }
      
      if (step % 8 === 4) {
        playSnare(nextNoteTime);
      }
      
      if (step % 2 === 0) {
        const melodyIdx = (step / 2) % leadNotes.length;
        const leadFreq = leadNotes[melodyIdx];
        if (leadFreq > 0) {
          playNote(leadFreq, 'triangle', stepTime * 1.8, nextNoteTime);
        }
      }
      
      nextNoteTime += stepTime;
      step++;
    }
  }
  
  synthInterval = setInterval(scheduler, 25);
  
  mediaProgressTimer = setInterval(() => {
    mediaCurrentTime++;
    if (mediaCurrentTime >= mediaDuration) {
      nextMediaTrack();
      return;
    }
    updateMediaProgressUI();
  }, 1000);
}

function stopSynthPlayback() {
  isMediaPlaying = false;
  $('mediaPlayBtn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" id="playIconSvg"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
  $('albumArtDisk').classList.remove('playing');
  if (synthInterval) { clearInterval(synthInterval); synthInterval = null; }
  if (mediaProgressTimer) { clearInterval(mediaProgressTimer); mediaProgressTimer = null; }
}

function toggleMediaPlayback() {
  if (isMediaPlaying) {
    stopSynthPlayback();
    rawLog('info', 'Media Player: Paused.');
  } else {
    startSynthPlayback();
    rawLog('info', `Media Player: Playing "${trackList[currentTrackIdx].title}".`);
  }
}

function updateMediaProgressUI() {
  const slider = $('mediaSlider');
  const pct = (mediaCurrentTime / mediaDuration) * 100;
  slider.value = pct;
  
  const m = String(Math.floor(mediaCurrentTime / 60)).padStart(2, '0');
  const s = String(Math.floor(mediaCurrentTime % 60)).padStart(2, '0');
  $('progressTimeCurrent').textContent = `${m}:${s}`;
}

function seekMedia(value) {
  const targetTime = Math.floor((value / 100) * mediaDuration);
  mediaCurrentTime = targetTime;
  updateMediaProgressUI();
  rawLog('info', `Seeked player to ${mediaCurrentTime}s`);
}

function setMediaVolume(value) {
  mediaVolume = value;
  if (mediaVolumeNode) {
    mediaVolumeNode.gain.value = mediaVolume / 100;
  }
}

function prevMediaTrack() {
  currentTrackIdx = (currentTrackIdx - 1 + trackList.length) % trackList.length;
  loadTrack(currentTrackIdx);
}

function nextMediaTrack() {
  currentTrackIdx = (currentTrackIdx + 1) % trackList.length;
  loadTrack(currentTrackIdx);
}

function loadTrack(idx) {
  const wasPlaying = isMediaPlaying;
  stopSynthPlayback();
  
  const track = trackList[idx];
  mediaDuration = track.duration;
  mediaCurrentTime = 0;
  
  $('trackTitle').textContent = track.title;
  $('trackArtist').textContent = track.artist;
  
  const m = String(Math.floor(mediaDuration / 60)).padStart(2, '0');
  const s = String(Math.floor(mediaDuration % 60)).padStart(2, '0');
  $('progressTimeTotal').textContent = `${m}:${s}`;
  updateMediaProgressUI();
  
  if (wasPlaying) {
    startSynthPlayback();
  }
  rawLog('info', `Loaded track: "${track.title}" by ${track.artist}`);
}

function handleIncomingMusicControl(cmdByte) {
  const cmdMap = {
    0x01: 'PLAY_PAUSE',
    0x02: 'NEXT',
    0x03: 'PREV',
    0x04: 'VOL_UP',
    0x05: 'VOL_DOWN'
  };
  
  const cmdName = cmdMap[cmdByte] || `UNKNOWN_CMD_${cmdByte.toString(16).toUpperCase()}`;
  $('lastBleCommand').textContent = cmdName;
  rawLog('data', `BLE Remote Command: ${cmdName} (0x${cmdByte.toString(16).toUpperCase()})`);
  
  const ind = $('bleMusicIndicator');
  ind.className = 'pulse-indicator status-orange';
  setTimeout(() => {
    ind.className = 'pulse-indicator status-green';
  }, 1000);
  
  if (cmdByte === 0x01) {
    toggleMediaPlayback();
  } else if (cmdByte === 0x02) {
    nextMediaTrack();
    showToast('Skip Next (Watch Remote)');
  } else if (cmdByte === 0x03) {
    prevMediaTrack();
    showToast('Skip Previous (Watch Remote)');
  } else if (cmdByte === 0x04) {
    const newVal = Math.min(mediaVolume + 10, 100);
    setMediaVolume(newVal);
    $('mediaVolumeSlider').value = newVal;
    showToast('Volume Up (Watch Remote)');
  } else if (cmdByte === 0x05) {
    const newVal = Math.max(mediaVolume - 10, 0);
    setMediaVolume(newVal);
    $('mediaVolumeSlider').value = newVal;
    showToast('Volume Down (Watch Remote)');
  }
}

// ── Custom Fitness Channel (0xFEE0 / 0xFEE1) ─────────────────
async function startCustomDataNotifications() {
  try {
    rawLog('info', 'Resolving proprietary fitness service (0xFEE0)…');
    const svc = await gattServer.getPrimaryService('0000fee0-0000-1000-8000-00805f9b34fb');
    const char = await svc.getCharacteristic('0000fee1-0000-1000-8000-00805f9b34fb');
    
    rawLog('info', 'Subscribing to notifications on characteristic 0xFEE1…');
    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', onCustomDataNotification);
    notifyActive.set(char.uuid, char);
    rawLog('success', 'Proprietary channel notifications active.');
  } catch (err) {
    rawLog('warning', `Fitness service (0xFEE0) not available: ${err.message}. Custom watch gestures might not sync.`);
  }
}

function onCustomDataNotification(event) {
  const value = event.target.value;
  const bytes = new Uint8Array(value.buffer);
  
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  rawLog('data', `OEM Notify [0xFEE1] → [${hex}]`);
  
  // Parse commands/data:
  if (bytes.length >= 2 && bytes[0] === 0x05) {
    const musicCmd = bytes[1];
    if (musicCmd >= 1 && musicCmd <= 5) {
      handleIncomingMusicControl(musicCmd);
      return;
    }
  }
  
  if (bytes.length >= 5 && bytes[0] === 0x08) {
    const steps = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
    if (steps >= 0 && steps < 100000) {
      liveData.steps = steps;
      $('stepsValue').textContent = steps.toLocaleString('en-IN');
      const pct = Math.min((steps / 10000) * 100, 100);
      $('stepsFill').style.width = pct + '%';
      $('stepsStatus').textContent = 'Live';
      $('stepsFooter').textContent = `${Math.round(pct)}% of 10,000 goal`;
      if (isLogging) {
        logCurrentDataPoint('Steps Sync');
      }
    }
  }
  
  if (bytes.length >= 2 && bytes[0] === 0x12) {
    const spo2 = bytes[1];
    if (spo2 >= 80 && spo2 <= 100) {
      setSpO2(spo2);
      $('spo2Status').textContent = 'Live';
      if (isLogging) {
        logCurrentDataPoint('SpO2 Sync');
      }
    }
  }
}

// ── Health Data Logger ──────────────────────────────────────
let isLogging = false;
let loggedData = [];
let periodicLoggerInterval = null;

function toggleLogging() {
  const btn = $('loggerToggleBtn');
  const txt = $('loggerToggleText');
  const indText = $('loggerIndicatorText');
  
  if (isLogging) {
    isLogging = false;
    btn.classList.remove('active');
    txt.textContent = 'Start Data Logging';
    indText.textContent = '● Logging Inactive';
    indText.style.color = 'var(--text-secondary)';
    rawLog('info', 'Data Logging paused.');
    if (periodicLoggerInterval) {
      clearInterval(periodicLoggerInterval);
      periodicLoggerInterval = null;
    }
  } else {
    isLogging = true;
    btn.classList.add('active');
    txt.textContent = 'Pause Data Logging';
    indText.textContent = '● Logging Active';
    indText.style.color = 'var(--emerald)';
    rawLog('info', 'Data Logging started.');
    
    if (gattServer && gattServer.connected) {
      logCurrentDataPoint('Manual Start');
    }
    
    periodicLoggerInterval = setInterval(() => {
      if (isLogging && gattServer && gattServer.connected) {
        logCurrentDataPoint('Periodic');
      }
    }, 15000);
  }
}

function logCurrentDataPoint(triggerSource = 'Periodic') {
  if (!isLogging) return;
  
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour12: false });
  const dateStr = now.toLocaleDateString('en-IN');
  const timestamp = `${dateStr} ${timeStr}`;
  
  const bpm = liveData.bpm || '—';
  const battery = liveData.battery !== null ? `${liveData.battery}%` : '—';
  const steps = liveData.steps !== null ? liveData.steps : '—';
  const spo2 = liveData.spo2 !== null ? `${liveData.spo2}%` : '—';
  
  const record = {
    timestamp,
    bpm,
    battery,
    steps,
    spo2,
    status: triggerSource
  };
  
  loggedData.push(record);
  
  if (loggedData.length > 100) {
    loggedData.shift();
  }
  
  updateLoggerUI();
  updateLoggedCount();
}

function updateLoggedCount() {
  $('loggedRowsCount').textContent = `${loggedData.length} records logged`;
}

function clearDataLog() {
  loggedData = [];
  updateLoggerUI();
  updateLoggedCount();
  showToast('Log cleared');
  rawLog('info', 'Cleared all logged health records.');
}

function updateLoggerUI() {
  const tbody = $('loggerTableBody');
  tbody.innerHTML = '';
  
  if (loggedData.length === 0) {
    tbody.innerHTML = `
      <tr class="table-empty">
        <td colspan="6">No logs recorded yet. Start logging to record data points automatically.</td>
      </tr>
    `;
    return;
  }
  
  const rows = [...loggedData].reverse();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.timestamp}</td>
      <td style="color:var(--rose);font-weight:600;">${r.bpm}</td>
      <td style="color:var(--emerald);">${r.battery}</td>
      <td style="color:var(--blue);">${r.steps}</td>
      <td style="color:var(--cyan);">${r.spo2}</td>
      <td><span class="spec-tag spec-style">${r.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function downloadCSVLog() {
  if (loggedData.length === 0) {
    showToast('❌ No data points to download.');
    return;
  }
  
  let csvContent = 'data:text/csv;charset=utf-8,';
  csvContent += 'Timestamp,Heart Rate (BPM),Battery Level,Steps,SpO2,Status\n';
  
  loggedData.forEach(r => {
    const row = [
      `"${r.timestamp}"`,
      `"${r.bpm}"`,
      `"${r.battery}"`,
      `"${r.steps}"`,
      `"${r.spo2}"`,
      `"${r.status}"`
    ].join(',');
    csvContent += row + '\n';
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  const now = new Date();
  const datestamp = now.toISOString().slice(0,10);
  link.setAttribute('download', `crown_connect_health_log_${datestamp}.csv`);
  document.body.appendChild(link);
  
  link.click();
  document.body.removeChild(link);
  showToast('✓ CSV Downloaded');
  rawLog('success', 'Health CSV log downloaded successfully.');
}

// ── Init ─────────────────────────────────────────────────────
checkBrowser();
loadRemindersFromStorage();
rawLog('info', 'Crown Connect v2.0 ready — BLE auto-reconnect + keep-alive enabled.');
rawLog('info', 'Click "Scan & Connect" to begin.');

