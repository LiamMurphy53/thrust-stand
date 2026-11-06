// thrust stand ui - talks to the esp32-s3 feather over web serial (chrome/edge)
const $ = id => document.getElementById(id);
const US_MIN = 1000, US_MAX = 2000, G_TO_N = 0.00980665, WINDOW_S = 20;
const C = { teal: '#75e0d1', amber: '#f3bd74', grid: '#1d3142', zero: '#3b5365', mute: '#8aa1b1' };

const st = {
  port: null, reader: null, readDone: null, writer: null, connected: false,
  armed: false, us: US_MIN, limit: US_MAX, invert: false,
  g: null, raw: null, espUs: null, cpg: null,
  live: [], log: [], recording: false,
  peak: null, rateN: 0, rate: null,
  sweep: null, sweepPts: [], t0: performance.now()
};
const enc = new TextEncoder();
const now = () => (performance.now() - st.t0) / 1000;
const pct = us => Math.round((us - US_MIN) / (US_MAX - US_MIN) * 100);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const msg = t => { $('msg').textContent = t; $('msg').title = t; };

// serial: open port, start reader, sync state
async function connect() {
  if (!('serial' in navigator)) { msg('Web Serial unavailable. Open in Chrome.'); return; }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    st.port = port;
    st.writer = port.writable.getWriter();
    st.connected = true;
    readLoop();
    await send('s');
    await send('p');
    msg('');
  } catch (e) {
    if (e.name !== 'NotFoundError') msg(e.message);
    await cleanup();
  }
  ui();
}

// serial: stop motor and release the port
async function disconnect() {
  await stop();
  await cleanup();
  ui();
}

async function cleanup() {
  st.connected = false; st.armed = false; abortSweep();
  try { if (st.reader) await st.reader.cancel(); } catch (e) {}
  try { if (st.readDone) await st.readDone; } catch (e) {}
  try { if (st.writer) st.writer.releaseLock(); } catch (e) {}
  try { if (st.port) await st.port.close(); } catch (e) {}
  st.port = st.reader = st.readDone = st.writer = null;
}

// serial: read bytes, split into lines
function readLoop() {
  const dec = new TextDecoder();
  let buf = '';
  st.reader = st.port.readable.getReader();
  st.readDone = (async () => {
    try {
      while (true) {
        const { value, done } = await st.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
    } catch (e) {
      if (st.connected) msg('Serial read error: ' + e.message);
    } finally {
      try { st.reader.releaseLock(); } catch (e) {}
    }
  })();
}

async function send(cmd) {
  if (!st.writer) return;
  try { await st.writer.write(enc.encode(cmd + '\n')); }
  catch (e) { msg('Write failed: ' + e.message); }
}

// parse one line from the board: csv sample or '#' status
function onLine(line) {
  line = line.trim();
  if (!line) return;
  if (line[0] === '#') { onStatus(line.slice(1).trim()); return; }
  const p = line.split(',');
  if (p.length !== 4) return;
  const ms = +p[0], us = +p[1], raw = +p[2];
  let g = +p[3];
  if (!Number.isFinite(ms) || !Number.isFinite(g)) return;
  if (st.invert) g = -g;
  const t = now();
  st.g = g; st.raw = raw; st.espUs = us; st.rateN++;
  st.peak = st.peak === null ? g : Math.max(st.peak, g);
  st.live.push({ t, g, us });
  while (st.live.length && st.live[0].t < t - WINDOW_S - 1) st.live.shift();
  if (st.recording) st.log.push([t, ms, us, raw, g]);
  if (st.sweep && st.sweep.collect) st.sweep.buf.push(g);
}

function onStatus(m) {
  const c = m.match(/^cpg\s+(\S+)/);
  if (c) { st.cpg = parseFloat(c[1]); ui(); return; }
  if (m.startsWith('stop')) { st.armed = false; abortSweep(); setUs(US_MIN); ui(); }
  msg(m);
}

// throttle
function setUs(v) {
  if (!Number.isFinite(v)) v = US_MIN;
  st.us = Math.round(Math.min(Math.max(v, US_MIN), st.limit));
  $('slider').value = st.us;
  $('us-input').value = st.us;
  $('us-read').innerHTML = `${st.us} <span>µs</span>`;
  $('pct-read').textContent = pct(st.us) + '%';
}

function setLimit(v) {
  st.limit = Math.round(Math.min(Math.max(Number.isFinite(v) ? v : US_MAX, US_MIN), US_MAX));
  $('max-us').value = st.limit;
  $('slider').max = st.limit;
  $('us-input').max = st.limit;
  setUs(st.us);
}

async function toggleArm() {
  if (st.armed) { await stop(); return; }
  if (!st.connected) return;
  setUs(US_MIN);
  st.armed = true;
  await send('t' + US_MIN);
  ui();
}

async function stop() {
  abortSweep();
  st.armed = false;
  setUs(US_MIN);
  ui();
  await send('s');
}

// resend throttle while armed; doubles as the firmware watchdog keepalive
setInterval(() => { if (st.connected && st.armed) send('t' + st.us); }, 100);
setInterval(() => { st.rate = st.connected ? st.rateN : null; st.rateN = 0; }, 1000);

// sweep: step throttle, average the second half of each dwell
async function runSweep() {
  if (st.sweep) { abortSweep(); return; }
  if (!st.armed) return;
  const a = +$('sw-start').value, b = Math.min(+$('sw-end').value, st.limit);
  const step = Math.abs(+$('sw-step').value), dwell = +$('sw-dwell').value;
  if (!(step > 0 && dwell > 0 && a >= US_MIN && b >= a)) { $('sweep-hint').textContent = 'Check start, end, step and dwell'; return; }
  const steps = [];
  for (let u = a; u <= b + 1e-9; u += step) steps.push(Math.round(u));
  const sw = st.sweep = { abort: false, collect: false, buf: [] };
  st.sweepPts = [];
  if (!st.recording) st.recording = true;
  ui();
  for (let i = 0; i < steps.length; i++) {
    setUs(steps[i]);
    $('sweep-hint').textContent = `Step ${i + 1} of ${steps.length}, ${steps[i]} µs`;
    if (!await wait(dwell * 500, sw)) break;
    sw.buf = []; sw.collect = true;
    if (!await wait(dwell * 500, sw)) break;
    sw.collect = false;
    if (sw.buf.length) st.sweepPts.push({ us: steps[i], g: mean(sw.buf), n: sw.buf.length });
  }
  const aborted = sw.abort;
  if (st.sweep === sw) st.sweep = null;
  if (!aborted) setUs(US_MIN);
  $('sweep-hint').textContent = aborted ? `Stopped, ${st.sweepPts.length} points kept` : `Done, ${st.sweepPts.length} points`;
  ui();
}

function abortSweep() { if (st.sweep) st.sweep.abort = true; }

function wait(ms, sw) {
  return new Promise(res => {
    const end = performance.now() + ms;
    const iv = setInterval(() => {
      if (sw.abort) { clearInterval(iv); res(false); }
      else if (performance.now() >= end) { clearInterval(iv); res(true); }
    }, 20);
  });
}

// logging and export
function clearData() {
  st.log = []; st.sweepPts = []; st.peak = null;
  if (!st.sweep) $('sweep-hint').textContent = '';
  ui();
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fname(kind) {
  const l = $('label').value.trim().replace(/[^\w.-]+/g, '_');
  return `thrust_${l ? l + '_' : ''}${kind}_${stamp()}.csv`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportLog() {
  if (!st.log.length) return;
  const t0 = st.log[0][0];
  const rows = ['time_s,esp_ms,throttle_us,throttle_pct,raw,thrust_g,thrust_n'];
  for (const [t, ms, us, raw, g] of st.log)
    rows.push([(t - t0).toFixed(4), ms, us, pct(us), raw, g.toFixed(2), (g * G_TO_N).toFixed(4)].join(','));
  download(fname('log'), rows.join('\n') + '\n');
}

function exportSweep() {
  if (!st.sweepPts.length) return;
  const rows = ['throttle_us,throttle_pct,thrust_g,thrust_n,samples'];
  for (const p of st.sweepPts)
    rows.push([p.us, pct(p.us), p.g.toFixed(2), (p.g * G_TO_N).toFixed(4), p.n].join(','));
  download(fname('sweep'), rows.join('\n') + '\n');
}

// button and status state
function ui() {
  const c = st.connected;
  $('connect').textContent = c ? 'Disconnect' : 'Connect';
  const s = $('conn-status');
  s.textContent = !c ? 'Disconnected' : st.armed ? 'Armed' : 'Connected';
  s.className = 'status' + (!c ? '' : st.armed ? ' armed' : ' on');
  $('arm').disabled = !c;
  $('arm').textContent = st.armed ? 'Disarm' : 'Arm';
  $('arm').classList.toggle('armed', st.armed);
  $('slider').disabled = $('us-input').disabled = !st.armed || !!st.sweep;
  $('sweep').disabled = !st.armed && !st.sweep;
  $('sweep').textContent = st.sweep ? 'Stop sweep' : 'Run sweep';
  $('tare').disabled = $('cal').disabled = !c || st.armed;
  $('record').disabled = !c && !st.recording;
  $('record').classList.toggle('on', st.recording);
  $('record').innerHTML = st.recording ? '<span class="rec-dot"></span>Recording' : 'Record';
  $('export-log').disabled = !st.log.length;
  $('export-sweep').disabled = !st.sweepPts.length;
  $('cal-hint').textContent = st.cpg === null ? '—'
    : Math.abs(st.cpg - 1) < 1e-9 ? 'Uncalibrated'
    : `${st.cpg.toFixed(2)} counts/g`;
}

function readouts() {
  const g = st.g;
  $('thrust').innerHTML = g === null ? '—' : `${g.toFixed(1)} <span>g</span>`;
  $('thrust-n').textContent = g === null ? '— N' : `${(g * G_TO_N).toFixed(3)} N`;
  $('ro-us').innerHTML = st.espUs === null ? '—' : `${st.espUs} <span>µs</span>`;
  $('ro-pct').textContent = st.espUs === null ? '—' : pct(st.espUs) + '%';
  $('ro-peak').innerHTML = st.peak === null ? '—' : `${st.peak.toFixed(1)} <span>g</span>`;
  $('ro-peak-n').textContent = st.peak === null ? '—' : `${(st.peak * G_TO_N).toFixed(3)} N`;
  $('ro-rate').innerHTML = st.rate === null ? '—' : `${st.rate} <span>Hz</span>`;
  $('ro-raw').textContent = st.raw === null ? '—' : st.raw;
  $('log-hint').textContent = `${st.log.length.toLocaleString()} rows` + (st.sweepPts.length ? `, ${st.sweepPts.length} pts` : '');
}

// charts
function fit(cv) {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.font = '11px Inter, ui-sans-serif, system-ui, sans-serif';
  return { ctx, w: r.width, h: r.height };
}

function ticks(lo, hi, n) {
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(6));
  return out;
}

function gRange(vals, minHi) {
  let lo = 0, hi = minHi;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = (hi - lo) * 0.08;
  return [lo < 0 ? lo - pad : 0, hi + pad];
}

function yAxis(ctx, lo, hi, L, R, w, Y) {
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  for (const v of ticks(lo, hi, 5)) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = v === 0 ? C.zero : C.grid;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.fillStyle = C.mute; ctx.fillText(v, L - 8, y);
  }
}

function drawLive() {
  const { ctx, w, h } = fit($('live'));
  const L = 48, R = 42, T = 8, B = 22, pw = w - L - R, ph = h - T - B;
  if (pw < 20 || ph < 20) return;
  const t1 = now(), t0 = t1 - WINDOW_S;
  const [lo, hi] = gRange(st.live.map(s => s.g), 20);
  const X = t => L + (t - t0) / WINDOW_S * pw;
  const Y = g => T + (hi - g) / (hi - lo) * ph;
  const YU = us => T + (US_MAX - us) / (US_MAX - US_MIN) * ph;
  yAxis(ctx, lo, hi, L, R, w, Y);
  ctx.fillStyle = C.mute; ctx.textAlign = 'left';
  for (const p of [0, 50, 100]) ctx.fillText(p + '%', w - R + 8, YU(US_MIN + p * 10));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let s = 0; s <= WINDOW_S; s += 5) ctx.fillText(s === 0 ? 'now' : `−${s} s`, X(t1 - s), h - B + 7);

  ctx.save();
  ctx.beginPath(); ctx.rect(L, T - 2, pw, ph + 4); ctx.clip();
  const pts = st.live;
  if (pts.length > 1) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.5; ctx.beginPath();
    pts.forEach((s, i) => { const x = X(s.t), y = YU(s.us); if (i) { ctx.lineTo(x, YU(pts[i - 1].us)); ctx.lineTo(x, y); } else ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.strokeStyle = C.teal; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((s, i) => { const x = X(s.t), y = Y(s.g); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.restore();
  if (!pts.length) empty(ctx, L + pw / 2, T + ph / 2, st.connected ? 'Waiting for samples' : 'Connect the board to start');
}

function drawCurve() {
  const { ctx, w, h } = fit($('curve'));
  const L = 48, R = 42, T = 8, B = 22, pw = w - L - R, ph = h - T - B;
  if (pw < 20 || ph < 20) return;
  const vals = st.log.map(r => r[4]).concat(st.sweepPts.map(p => p.g));
  if (st.g !== null) vals.push(st.g);
  const [lo, hi] = gRange(vals, 20);
  const X = us => L + (us - US_MIN) / (US_MAX - US_MIN) * pw;
  const Y = g => T + (hi - g) / (hi - lo) * ph;
  yAxis(ctx, lo, hi, L, R, w, Y);
  ctx.fillStyle = C.mute; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let p = 0; p <= 100; p += 25) ctx.fillText(p + '%', X(US_MIN + p * 10), h - B + 7);

  ctx.save();
  ctx.beginPath(); ctx.rect(L - 4, T - 4, pw + 8, ph + 8); ctx.clip();
  const n = st.log.length, stride = Math.max(1, Math.ceil(n / 5000));
  ctx.fillStyle = '#75e0d140';
  for (let i = 0; i < n; i += stride) { const r = st.log[i]; ctx.fillRect(X(r[2]) - 1.5, Y(r[4]) - 1.5, 3, 3); }
  const sp = st.sweepPts;
  if (sp.length) {
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.5; ctx.beginPath();
    sp.forEach((p, i) => i ? ctx.lineTo(X(p.us), Y(p.g)) : ctx.moveTo(X(p.us), Y(p.g)));
    ctx.stroke();
    ctx.fillStyle = C.amber;
    for (const p of sp) { ctx.beginPath(); ctx.arc(X(p.us), Y(p.g), 3.5, 0, 7); ctx.fill(); }
  }
  if (st.g !== null && st.espUs !== null) {
    ctx.strokeStyle = C.teal; ctx.lineWidth = 2; ctx.beginPath();
    ctx.arc(X(st.espUs), Y(st.g), 6, 0, 7); ctx.stroke();
  }
  ctx.restore();
  if (!n && !sp.length) empty(ctx, L + pw / 2, T + ph / 2, 'Record or run a sweep to plot');
}

function empty(ctx, x, y, text) {
  ctx.fillStyle = '#6f8899'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '13px Inter, ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(text, x, y);
}

function frame() {
  readouts();
  drawLive();
  drawCurve();
  requestAnimationFrame(frame);
}

// wiring
$('connect').onclick = () => (st.connected ? disconnect() : connect());
$('arm').onclick = toggleArm;
$('stop').onclick = stop;
$('slider').oninput = e => setUs(+e.target.value);
$('us-input').onchange = e => setUs(+e.target.value);
$('max-us').onchange = e => setLimit(+e.target.value);
$('sweep').onclick = runSweep;
$('tare').onclick = () => send('z');
$('cal').onclick = () => { const m = +$('cal-mass').value; if (m > 0) send('c' + m); };
$('invert').onchange = e => { st.invert = e.target.checked; st.live = []; st.peak = null; };
$('record').onclick = () => { st.recording = !st.recording; ui(); };
$('clear').onclick = clearData;
$('export-log').onclick = exportLog;
$('export-sweep').onclick = exportSweep;

// esc always stops; space stops unless typing in a field
document.addEventListener('keydown', e => {
  const typing = e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number');
  if (e.key === 'Escape' || (e.code === 'Space' && !typing)) { e.preventDefault(); stop(); }
});

if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', e => {
    if (e.target === st.port) { msg('Board disconnected'); cleanup().then(ui); }
  });
} else {
  msg('Web Serial unavailable. Open in Chrome.');
  $('connect').disabled = true;
}
window.addEventListener('beforeunload', () => { if (st.armed) send('s'); });

setUs(US_MIN);
ui();
requestAnimationFrame(frame);
