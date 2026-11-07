/* Seal ESS web app: UI, audio setup, sensors. Engine lives in engine-worklet.js, fusion in fusion.js. */
'use strict';

const ENGINES = [
  ['v8', 'American V8'], ['v8sc', 'Supercharged V8'], ['i6t', 'Inline-6 Turbo'],
  ['v12', 'V12 Grand Tourer'], ['f6', 'Flat-6 Sports'], ['i4t', '4-Cyl Turbo'],
];
const LIMITS = { v8: [6500, 6700], v8sc: [6800, 7000], i6t: [7000, 7200], v12: [8500, 8700], f6: [9000, 9200], i4t: [7000, 7200] };

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sealess.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sealess.' + k, JSON.stringify(v)); } catch {} },
};
const settings = { preset: store.get('preset', 'v8'), volume: store.get('volume', 75), aggr: store.get('aggr', 50), demo: store.get('demo', false), mix: store.get('mix', false) };

// iOS audio session: 'playback' ignores the silent switch but pauses other audio (music);
// 'ambient' mixes with music but is muted by the silent switch.
function applyAudioSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = settings.mix ? 'ambient' : 'playback'; } catch {}
}

let ctx = null, node = null, running = false, wakeLock = null, geoWatch = null;
let fusion = new MotionFusion();
let engineState = { rpm: 0, gear: 0, throttle: 0, speedKmh: 0 };
let source = 'waiting';
const demo = { thr: 0, drive: false, speed: 0, lastT: performance.now() };
let revHeld = false;

// ---------- UI setup ----------
const enginesEl = $('engines');
for (const [id, name] of ENGINES) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = name; b.dataset.id = id;
  b.setAttribute('aria-pressed', String(id === settings.preset));
  b.onclick = () => {
    settings.preset = id; store.set('preset', id);
    enginesEl.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.id === id)));
    sendSettings();
  };
  enginesEl.appendChild(b);
}
$('volume').value = settings.volume;
$('aggr').value = settings.aggr;
$('demo').checked = settings.demo;
$('mix').checked = settings.mix;
$('mix').onchange = e => { settings.mix = e.target.checked; store.set('mix', settings.mix); applyAudioSession(); };
$('demoControls').hidden = !settings.demo;
$('volume').oninput = e => { settings.volume = +e.target.value; store.set('volume', settings.volume); sendSettings(); };
$('aggr').oninput = e => { settings.aggr = +e.target.value; store.set('aggr', settings.aggr); sendSettings(); };
$('demo').onchange = e => { settings.demo = e.target.checked; store.set('demo', settings.demo); $('demoControls').hidden = !settings.demo; };
$('demoDrive').onchange = e => { demo.drive = e.target.checked; };
$('pedal').oninput = e => { demo.thr = +e.target.value / 100; };
function holdButton(el, down, up) {
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); down(); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, up));
}
holdButton($('hold'), () => { demo.thr = 1; }, () => { demo.thr = +$('pedal').value / 100; });
holdButton($('rev'), () => { revHeld = true; }, () => { revHeld = false; });

function sendSettings() {
  node?.port.postMessage({ type: 'settings', preset: settings.preset, volume: settings.volume / 100, aggr: settings.aggr / 100 });
}

// ---------- Start / stop ----------
$('start').onclick = () => running ? stop() : start();

async function start() {
  const status = $('status');
  // Everything that needs the tap's "user gesture" is called before the first await.
  applyAudioSession();
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const resumeP = ctx.resume();
  const motionP = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
    ? DeviceMotionEvent.requestPermission().catch(() => 'denied') : Promise.resolve('granted');
  startGps();
  try {
    status.textContent = 'Starting…';
    if (!node) {
      await ctx.audioWorklet.addModule('engine-worklet.js');
      node = new AudioWorkletNode(ctx, 'engine', { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = e => { engineState = e.data; };
      node.connect(ctx.destination);
    }
    await resumeP;
    const motion = await motionP;
    if (motion === 'granted') window.addEventListener('devicemotion', onMotion);
    sendSettings();
    node.port.postMessage({ type: 'run', on: true });
    running = true;
    $('start').textContent = 'Stop engine'; $('start').classList.add('on');
    status.textContent = motion === 'granted' ? 'Running.' : 'Running without Motion: reactions will be slower (GPS only).';
    requestWakeLock();
  } catch (err) {
    status.textContent = 'Could not start audio: ' + (err && err.message || err);
  }
}

function stop() {
  node?.port.postMessage({ type: 'run', on: false });
  running = false;
  $('start').textContent = 'Start engine'; $('start').classList.remove('on');
  $('status').textContent = 'Engine off.';
  window.removeEventListener('devicemotion', onMotion);
  if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  setTimeout(() => { if (!running) ctx?.suspend(); }, 400);
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
}

// ---------- Sensors ----------
const now = () => performance.now() / 1000;
function onMotion(e) {
  const a = e.acceleration, g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  fusion.onMotion(a && a.x != null ? [a.x, a.y, a.z] : null, [g.x, g.y, g.z], now());
}
function startGps() {
  if (!('geolocation' in navigator) || geoWatch != null) return;
  geoWatch = navigator.geolocation.watchPosition(
    p => fusion.onGps(p.coords.speed, p.coords.accuracy, now()),
    err => { if (err.code === 1) $('status').textContent = 'Location is off: allow it in Settings → Privacy → Location Services → Safari Websites.'; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) { ctx?.resume(); requestWakeLock(); }
});

// ---------- Control loop (60 Hz) ----------
setInterval(() => {
  if (!node || !running) return;
  let input;
  if (settings.demo) {
    const t = performance.now(); const dt = Math.min(0.1, (t - demo.lastT) / 1000); demo.lastT = t;
    if (demo.drive) {
      const acc = demo.thr * 7.5 * (1 - demo.speed / 250) - 0.0004 * demo.speed * demo.speed / 3.6 - (demo.thr < 0.05 ? 1.5 : 0);
      demo.speed = Math.min(250, Math.max(0, demo.speed + acc * 3.6 * dt));
    } else demo.speed = 0;
    input = { speedKmh: demo.speed, throttle: demo.thr, lever: demo.drive ? 'D' : 'P' };
    source = 'demo';
  } else {
    const r = fusion.tick(now());
    input = { speedKmh: r.speedKmh, throttle: r.throttle, lever: r.lever };
    source = r.mode;
    if (revHeld && r.speedKmh < 3) input = { speedKmh: 0, throttle: 1, lever: 'P' };
  }
  node.port.postMessage({ type: 'input', ...input });
}, 16);

// ---------- Gauge + chips ----------
const cv = $('gauge'), g2 = cv.getContext('2d');
let shownRpm = 0;
function draw() {
  const [redline, limiter] = LIMITS[settings.preset];
  const maxRpm = Math.ceil((limiter + 500) / 1000) * 1000;
  const W = cv.width, H = cv.height, r = Math.min(W, H) * 0.42, cx = W / 2, cy = H / 2 + r * 0.08;
  const st = running ? engineState : { rpm: 0, gear: 0, throttle: 0, speedKmh: 0 };
  shownRpm += (st.rpm - shownRpm) * 0.4;
  const start = 150 * Math.PI / 180, sweep = 240 * Math.PI / 180;
  g2.clearRect(0, 0, W, H);
  g2.lineCap = 'round'; g2.lineWidth = r * 0.07;
  const arc = (from, to, col) => { g2.strokeStyle = col; g2.beginPath(); g2.arc(cx, cy, r, start + sweep * from, start + sweep * to); g2.stroke(); };
  arc(0, 1, '#22303F'); arc(redline / maxRpm, 1, '#6E1F1F');
  const frac = Math.min(1, Math.max(0, shownRpm / maxRpm));
  if (frac > 0.002) arc(0, frac, shownRpm > redline ? '#FF4D3D' : '#3DA5FF');
  g2.fillStyle = '#8C98A8'; g2.strokeStyle = '#8C98A8'; g2.lineWidth = r * 0.012;
  g2.font = `${r * 0.11}px -apple-system, system-ui, sans-serif`; g2.textAlign = 'center'; g2.textBaseline = 'middle';
  for (let k = 0; k * 1000 <= maxRpm; k++) {
    const a = start + sweep * (k * 1000 / maxRpm);
    g2.beginPath(); g2.moveTo(cx + r * 0.80 * Math.cos(a), cy + r * 0.80 * Math.sin(a));
    g2.lineTo(cx + r * 0.90 * Math.cos(a), cy + r * 0.90 * Math.sin(a)); g2.stroke();
    g2.fillText(String(k), cx + r * 0.68 * Math.cos(a), cy + r * 0.68 * Math.sin(a));
  }
  const na = start + sweep * frac;
  g2.strokeStyle = '#FF4D3D'; g2.lineWidth = r * 0.025;
  g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(cx + r * 0.85 * Math.cos(na), cy + r * 0.85 * Math.sin(na)); g2.stroke();
  g2.fillStyle = '#FF4D3D'; g2.beginPath(); g2.arc(cx, cy, r * 0.05, 0, Math.PI * 2); g2.fill();
  g2.fillStyle = '#E8EDF3'; g2.font = `700 ${r * 0.42}px -apple-system, system-ui, sans-serif`;
  g2.fillText(!running ? '-' : (st.gear === 0 ? 'P' : String(st.gear)), cx, cy + r * 0.5);
  g2.fillStyle = '#C8D0DA'; g2.font = `${r * 0.12}px -apple-system, system-ui, sans-serif`;
  g2.fillText(`${Math.round(shownRpm).toLocaleString()} rpm`, cx, cy + r * 0.8);
  g2.fillText(`${Math.round(st.speedKmh || 0)} km/h`, cx, cy - r * 0.32);
  const bw = r * 1.2, bh = r * 0.05, by = cy + r * 0.95;
  g2.fillStyle = '#22303F'; g2.fillRect(cx - bw / 2, by, bw, bh);
  g2.fillStyle = '#3DDC84'; g2.fillRect(cx - bw / 2, by, bw * (st.throttle || 0), bh);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function chip(text, cls) { return `<span class="chip ${cls}">${text}</span>`; }
setInterval(() => {
  const s = fusion.status(now());
  const srcLabel = { demo: 'Demo', 'motion+gps': 'Motion + GPS', gps: 'GPS only', waiting: 'Waiting for GPS' }[source] || source;
  $('chips').innerHTML = [
    chip('Source: ' + srcLabel, source === 'motion+gps' || source === 'demo' ? 'ok' : (source === 'gps' ? 'warn' : '')),
    chip('GPS: ' + (s.gps === 'ok' ? `±${Math.round(s.gpsAcc)} m` : s.gps), s.gps === 'ok' ? 'ok' : (s.gps === 'stale' ? 'warn' : '')),
    chip('Motion: ' + (s.motion ? 'on' : 'off'), s.motion ? 'ok' : 'warn'),
    chip('Forward: ' + s.forward, s.forward === 'locked' ? 'ok' : 'warn'),
  ].join('');
}, 500);
