/* Effetti olografici della home, come il Jarvis dei film (tutto disegnato nel browser, gratis):
 * - la mappa olografica dei locali: un disco 3D in wireframe attorno a Gorizia che ruota piano, con una colonna
 *   di luce per ogni locale (ambra se aspetta una tua decisione); quando nomini un locale la mappa lo aggancia
 *   con i mirini e mostra la sua scheda;
 * - lo spettro della voce: un anello di frequenze attorno al reattore che segue la tua voce e quella di Jarvis.
 * Un solo ciclo di disegno, fermo quando la pagina non si vede. Si spengono da Strumenti (setHolo). */
import { COAST, TOWNS, toKm } from './jarvis-places.js';

const KEY = 'jarvis-holo';
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
export function holoOn() { try { return globalThis.localStorage?.getItem(KEY) !== 'no'; } catch { return true; } }
export function setHolo(on) { try { globalThis.localStorage?.setItem(KEY, on ? 'si' : 'no'); } catch { /* ok */ } if (!on) stop(); else wake(); }

const root = globalThis.document?.documentElement;
const COLORS = { decide: [255, 179, 71], online: [70, 214, 255], lavoro: [169, 236, 255], nuovo: [120, 150, 180] };
let mapCanvas = null, specCanvas = null, panel = null;
let venues = [];
let focus = null; // id del locale agganciato
let onOpen = null;
let cam = { yaw: 0.6, zoom: 1, cx: 0, cy: 0, shift: 0 };
let goal = { zoom: 1, cx: 0, cy: 0, shift: 0 };
let raf = 0, last = 0, lockAt = 0;
let drag = null;
let bars = new Float32Array(72);

function canvas(className, label) {
  const el = document.createElement('canvas');
  el.className = className;
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); } else el.setAttribute('aria-hidden', 'true');
  return el;
}
function fit(el) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return null;
  if (el.width !== Math.round(w * ratio) || el.height !== Math.round(h * ratio)) { el.width = Math.round(w * ratio); el.height = Math.round(h * ratio); }
  const ctx = el.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}

/** Rimette le tele olografiche nei segnaposto della home appena ridisegnata. */
export function attachHolo(list, { open = null } = {}) {
  if (!globalThis.document) return;
  venues = Array.isArray(list) ? list : [];
  onOpen = open;
  const mapSlot = document.querySelector('[data-holo-map]');
  const specSlot = document.querySelector('[data-holo-spectrum]');
  if (!holoOn()) { mapSlot?.closest('.holo-map')?.setAttribute('hidden', ''); return; }
  if (mapSlot) {
    if (!mapCanvas) {
      mapCanvas = canvas('holo-canvas', 'Mappa olografica dei locali');
      mapCanvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, yaw: cam.yaw, moved: false }; });
      mapCanvas.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true; cam.yaw = drag.yaw + dx * 0.01; });
      mapCanvas.addEventListener('pointerup', (e) => { const moved = drag?.moved; drag = null; if (!moved) tap(e); });
      mapCanvas.addEventListener('pointerleave', () => { drag = null; });
      panel = document.createElement('div');
      panel.className = 'holo-panel';
      panel.hidden = true;
    }
    mapSlot.replaceChildren(mapCanvas, panel);
    renderPanel();
  }
  if (specSlot) {
    if (!specCanvas) specCanvas = canvas('holo-spectrum-canvas');
    specSlot.replaceChildren(specCanvas);
  }
  if (venues.length && !goal.set) { frame(); goal.set = true; }
  wake();
}
/** Aggancia un locale (nominato in chat o toccato). null = torna alla vista d'insieme. */
export function focusVenue(id) {
  const venue = venues.find((v) => v.id === id);
  focus = venue ? venue.id : null;
  lockAt = performance.now();
  // Il locale agganciato va a sinistra: a destra c'è la sua scheda.
  if (venue) Object.assign(goal, { zoom: Math.max(goal.zoom * 1.6, 3.4), cx: venue.x, cy: venue.y, shift: -0.24 });
  else frame();
  renderPanel();
  wake();
  return Boolean(venue);
}
function frame() {
  const far = Math.max(2.5, ...venues.map((v) => Math.hypot(v.x, v.y)));
  Object.assign(goal, { zoom: Math.max(0.4, Math.min(6, 13 / far)), cx: 0, cy: 0, shift: 0 });
}
const STATE_LABEL = { decide: 'Aspetta una tua decisione', online: 'Menu online', lavoro: 'Pratica in corso', nuovo: 'Senza menu' };
const PLAN_LABEL = { standard: 'Standard', annuale: 'Annuale', premium: 'Premium' };
function renderPanel() {
  if (!panel) return;
  const venue = venues.find((v) => v.id === focus);
  panel.hidden = !venue;
  panel.closest('.holo-map')?.classList.toggle('locked', Boolean(venue));
  if (!venue) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  panel.className = `holo-panel s-${venue.state}`;
  panel.innerHTML = `<small>BERSAGLIO AGGANCIATO</small><strong>${esc(venue.name)}</strong><span>${esc(venue.town || 'Posizione indicativa')}${PLAN_LABEL[venue.plan] ? ` · ${PLAN_LABEL[venue.plan]}` : ''}</span><span class="st">${esc(STATE_LABEL[venue.state])}${venue.open ? ` · ${venue.open} ${venue.open === 1 ? 'pratica aperta' : 'pratiche aperte'}` : ''}</span><button type="button" data-holo-open="${esc(venue.id)}">Apri il locale</button><button type="button" class="x" data-holo-close aria-label="Torna alla mappa">×</button>`;
  panel.querySelector('[data-holo-open]').onclick = () => onOpen?.(venue.id);
  panel.querySelector('[data-holo-close]').onclick = () => focusVenue(null);
}

// ——— proiezione: disco inclinato che ruota attorno al centro della vista ———
function project(x, y, z, w, h) {
  const px = (x - cam.cx), py = (y - cam.cy);
  const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
  const rx = px * c - py * s, ry = px * s + py * c;
  const radius = 17 / cam.zoom; // km visibili dal centro al bordo
  const nx = rx / radius, ny = ry / radius;
  const depth = 1 / (1 + Math.max(-0.6, Math.min(0.6, ny * 0.22)));
  const half = w / 2.15;
  return { x: w / 2 + cam.shift * w + nx * half * depth, y: h * 0.54 - ny * h * 0.34 * depth - z * depth, d: depth, s: half / radius * depth };
}
function tap(event) {
  if (!mapCanvas) return;
  const rect = mapCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  let best = null;
  for (const v of venues) { const p = project(v.x, v.y, 0, rect.width, rect.height); const d = Math.hypot(p.x - x, p.y - y); if (d < 26 && (!best || d < best.d)) best = { v, d }; }
  focusVenue(best ? best.v.id : null);
}
// Scritte sulla mappa senza accavallarsi: prova a destra del punto, poi a sinistra, poi una riga sotto o sopra.
function placer(ctx, width) {
  const taken = [];
  const free = (r) => r.x >= 2 && r.x + r.w <= width - 2 && !taken.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
  const label = (text, x, y, gap = 0) => {
    const w = ctx.measureText(text).width + 4, h = 11;
    const spots = [[x, y], [x - w - gap, y], [x, y + 12], [x - w - gap, y + 12], [x, y - 12], [x - w - gap, y - 12], [x, y + 24]];
    const spot = spots.find(([sx, sy]) => free({ x: sx, y: sy - 9, w, h }));
    if (!spot) return; // meglio nessuna scritta che una sopra l'altra
    taken.push({ x: spot[0], y: spot[1] - 9, w, h });
    ctx.fillText(text, spot[0], spot[1]);
  };
  label.reserve = (x, y, w, h) => taken.push({ x, y, w, h });
  return label;
}
function drawMap(t) {
  const out = mapCanvas && mapCanvas.isConnected ? fit(mapCanvas) : null;
  if (!out) return false;
  const { ctx, w, h } = out;
  ctx.clearRect(0, 0, w, h);
  const line = (a, b, alpha) => { ctx.strokeStyle = `rgba(70,214,255,${alpha})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  ctx.lineWidth = 1;
  const label = placer(ctx, w);
  // Lo spazio della scheda del locale agganciato e le teste delle colonne di luce restano libere dalle scritte.
  if (focus && panel && !panel.hidden) label.reserve(w - Math.min(200, w / 2) - 8, 0, w, h);
  const pins = venues.map((v) => ({ v, p: project(v.x, v.y, 0, w, h) })).sort((a, b) => a.p.d - b.p.d);
  const tallOf = (v, p) => (v.state === 'decide' ? 34 : v.state === 'online' ? 24 : 16) * p.d;
  for (const { v, p } of pins) {
    if (v.id === focus) label.reserve(p.x - 32, p.y - 50, 64, 64); // il mirino: il nome è già nella scheda
    else label.reserve(p.x - 4, p.y - tallOf(v, p) - 4, 8, 8);
  }
  // Anelli di distanza (5, 10, 20, 40 km) e raggi.
  const reach = 17 / cam.zoom * 1.25;
  for (const km of [2, 5, 10, 20, 40].filter((k) => k <= reach && k >= reach / 12)) {
    ctx.strokeStyle = `rgba(70,214,255,${km === 10 ? 0.32 : 0.18})`;
    ctx.beginPath();
    for (let i = 0; i <= 96; i += 1) { const a = i / 96 * Math.PI * 2; const p = project(Math.cos(a) * km, Math.sin(a) * km, 0, w, h); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    ctx.stroke();
    const tag = project(km * 0.71, km * 0.71, 0, w, h);
    ctx.fillStyle = 'rgba(70,214,255,.45)'; ctx.font = '9px "JetBrains Mono", monospace'; label(`${km} KM`, tag.x + 3, tag.y);
  }
  for (let i = 0; i < 12; i += 1) { const a = i / 12 * Math.PI * 2; line(project(cam.cx, cam.cy, 0, w, h), project(cam.cx + Math.cos(a) * reach, cam.cy + Math.sin(a) * reach, 0, w, h), 0.07); }
  // Costa del golfo.
  ctx.strokeStyle = 'rgba(169,236,255,.38)'; ctx.setLineDash([3, 4]); ctx.beginPath();
  COAST.forEach(([lat, lon], i) => { const k = toKm(lat, lon); const p = project(k.x, k.y, 0, w, h); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
  ctx.stroke(); ctx.setLineDash([]);
  // Paesi con locali (e Gorizia).
  const towns = new Set(['Gorizia', ...venues.map((v) => v.town).filter(Boolean)]);
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  for (const town of TOWNS.filter((tw) => towns.has(tw.name))) {
    const k = toKm(town.lat, town.lon); const p = project(k.x, k.y, 0, w, h);
    ctx.fillStyle = 'rgba(169,236,255,.75)'; ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    ctx.fillStyle = 'rgba(169,236,255,.6)'; label(town.name.toUpperCase(), p.x + 5, p.y + 3);
  }
  // Locali: colonne di luce, le più lontane prima.
  for (const { v, p } of pins) {
    const [r, g, b] = COLORS[v.state] || COLORS.nuovo;
    const pulse = v.state === 'decide' ? 0.6 + 0.4 * Math.sin(t / 380) : 1;
    const tall = tallOf(v, p);
    const grad = ctx.createLinearGradient(p.x, p.y, p.x, p.y - tall);
    grad.addColorStop(0, `rgba(${r},${g},${b},${0.9 * pulse})`); grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad; ctx.fillRect(p.x - 1.5, p.y - tall, 3, tall);
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.7 * pulse})`; ctx.beginPath(); ctx.ellipse(p.x, p.y, 6, 2.6, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(${r},${g},${b},1)`; ctx.beginPath(); ctx.arc(p.x, p.y - tall, 2.4, 0, Math.PI * 2); ctx.fill();
    if (focus !== v.id && (focus || cam.zoom > 1.8 || venues.length <= 6)) { ctx.fillStyle = `rgba(${r},${g},${b},.9)`; ctx.font = '600 10px "JetBrains Mono", monospace'; label(v.name.slice(0, 22), p.x + 7, p.y - tall + 3, 14); }
  }
  // Mirino sul locale agganciato: quattro angoli che si stringono e ruotano.
  const locked = venues.find((v) => v.id === focus);
  if (locked) {
    const p = project(locked.x, locked.y, 0, w, h);
    const k = Math.min(1, (performance.now() - lockAt) / 700);
    const size = 46 - 26 * k, spin = (1 - k) * 1.2 + t / 4000;
    ctx.strokeStyle = 'rgba(255,179,71,.95)'; ctx.lineWidth = 1.6;
    for (let i = 0; i < 4; i += 1) {
      const a = spin + i * Math.PI / 2; const cx = p.x + Math.cos(a + Math.PI / 4) * size, cy = p.y - 10 + Math.sin(a + Math.PI / 4) * size;
      ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8); ctx.lineTo(cx, cy); ctx.lineTo(cx - Math.cos(a + Math.PI / 2) * 8, cy - Math.sin(a + Math.PI / 2) * 8); ctx.stroke();
    }
    ctx.lineWidth = 1;
  }
  // Scansione che attraversa la mappa: una linea sottile che sfuma ai lati.
  const sweep = ((t / 4200) % 1) * h;
  const scan = ctx.createLinearGradient(0, 0, w, 0);
  scan.addColorStop(0, 'rgba(70,214,255,0)'); scan.addColorStop(0.5, 'rgba(70,214,255,.22)'); scan.addColorStop(1, 'rgba(70,214,255,0)');
  ctx.fillStyle = scan; ctx.fillRect(0, sweep, w, 1);
  return true;
}

// ——— spettro della voce attorno al reattore ———
function level() {
  const style = root?.style;
  const phase = root?.dataset.jarvis || 'idle';
  if (phase === 'listening') return { phase, v: Number(style?.getPropertyValue('--jv-lvl')) || 0 };
  if (phase === 'speaking') {
    const out = root?.dataset.jarvisOut ? Number(style?.getPropertyValue('--jv-out')) || 0 : null;
    // La voce del telefono non dice quanto è forte: un'onda simile al parlato.
    return { phase, v: out ?? (0.35 + 0.3 * Math.abs(Math.sin(performance.now() / 140)) * Math.abs(Math.sin(performance.now() / 410))) };
  }
  return { phase, v: phase === 'thinking' ? 0.18 : 0.06 };
}
function drawSpectrum(t) {
  const out = specCanvas && specCanvas.isConnected ? fit(specCanvas) : null;
  if (!out) return false;
  const { ctx, w, h } = out;
  ctx.clearRect(0, 0, w, h);
  const { phase, v } = level();
  const n = bars.length, cx = w / 2, cy = h / 2, inner = Math.min(w, h) / 2 - 34;
  const [r, g, b] = phase === 'listening' ? [201, 244, 255] : phase === 'speaking' ? [70, 214, 255] : [70, 214, 255];
  for (let i = 0; i < n; i += 1) {
    const wobble = 0.5 + 0.5 * Math.sin(i * 0.9 + t / (phase === 'thinking' ? 160 : 260)) * Math.sin(i * 0.37 - t / 520);
    const target = v * (0.35 + 0.65 * wobble);
    bars[i] += (target - bars[i]) * 0.28;
    const len = 3 + bars[i] * 30;
    const a = i / n * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.25 + bars[i] * 0.75})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner); ctx.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len)); ctx.stroke();
  }
  return true;
}

function loop(time) {
  raf = 0;
  if (document.hidden || !holoOn()) return;
  const dt = Math.min(64, time - (last || time)); last = time;
  if (!drag && !reduced) cam.yaw += dt * (focus ? 0.00004 : 0.00012);
  const ease = Math.min(1, dt / 260);
  cam.zoom += (goal.zoom - cam.zoom) * ease; cam.cx += (goal.cx - cam.cx) * ease; cam.cy += (goal.cy - cam.cy) * ease; cam.shift += (goal.shift - cam.shift) * ease;
  const a = drawMap(time), b = drawSpectrum(time);
  if ((a || b) && !reduced) raf = requestAnimationFrame(loop);
}
function wake() { if (!raf && globalThis.requestAnimationFrame && holoOn()) { last = 0; raf = requestAnimationFrame(loop); } }
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
globalThis.document?.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
