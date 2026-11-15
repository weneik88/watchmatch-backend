// Visual and audio effects: toasts, confetti, emoji rain, floating reactions,
// shake, disco, sounds, pointer glow, button ripples, stars.

import { get } from './settings.js';

const motionOn = () => get().motion !== 'off';
const fxOn = () => get().confetti && motionOn();

// ---------- toasts ----------
export function toast(text, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  while (host.children.length >= 3) host.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast glass ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 360);
  }, kind === 'err' ? 4500 : 2600);
}

// ---------- confetti ----------
let canvas, ctx, particles = [], raf = 0, dpr = 1;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.getElementById('fx');
  ctx = canvas.getContext('2d');
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  resize();
  addEventListener('resize', resize);
}

function palette() {
  const cs = getComputedStyle(document.documentElement);
  return [cs.getPropertyValue('--accent').trim() || '#7c5cff', cs.getPropertyValue('--accent2').trim() || '#19d3c5', '#ff5fa2', '#ffd23f', '#35e08a', '#ffffff'];
}

export function confetti({ x = innerWidth / 2, y = innerHeight * 0.45, count = 120, power = 1 } = {}) {
  if (!fxOn()) return;
  ensureCanvas();
  const colors = palette();
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = (6 + Math.random() * 12) * power;
    particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 7 * power,
      w: 6 + Math.random() * 7, h: 4 + Math.random() * 6,
      rot: Math.random() * 6.28, vr: (Math.random() - .5) * .45,
      color: colors[(Math.random() * colors.length) | 0], life: 0, max: 110 + Math.random() * 70,
      round: Math.random() < .25,
    });
  }
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles = particles.filter((p) => p.life < p.max && p.y < innerHeight + 40);
  for (const p of particles) {
    p.life++;
    p.vx *= .985; p.vy = p.vy * .985 + .38;
    p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    ctx.save();
    ctx.translate(p.x * dpr, p.y * dpr);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.min(1, (p.max - p.life) / 30);
    ctx.fillStyle = p.color;
    if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w * .45 * dpr, 0, 6.28); ctx.fill(); }
    else ctx.fillRect(-p.w / 2 * dpr, -p.h / 2 * dpr, p.w * dpr, p.h * dpr);
    ctx.restore();
  }
  raf = particles.length ? requestAnimationFrame(tick) : 0;
  if (!raf) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function fireworks() {
  if (!fxOn()) return;
  [0, 250, 500].forEach((d, i) => setTimeout(() => confetti({
    x: innerWidth * (.2 + .3 * i + Math.random() * .1), y: innerHeight * (.25 + Math.random() * .2), count: 70, power: .9,
  }), d));
}

// ---------- emoji rain ----------
export function rain(emoji, n = 36) {
  if (!fxOn()) return;
  const host = document.getElementById('rain');
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    el.textContent = emoji;
    const dur = 2.6 + Math.random() * 2.4;
    el.style.cssText = `left:${Math.random() * 100}vw;font-size:${1.4 + Math.random() * 2.2}rem;animation-duration:${dur}s;animation-delay:${Math.random() * 1.4}s;--sway:${(Math.random() - .5) * 160}px;--spin:${(Math.random() - .5) * 720}deg`;
    host.appendChild(el);
    setTimeout(() => el.remove(), (dur + 1.6) * 1000 + 200);
  }
}

// ---------- reactions over the video ----------
export function floatEmoji(container, emoji, name) {
  if (!container || !motionOn()) return;
  while (container.children.length > 36) container.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'floater';
  el.style.left = `${8 + Math.random() * 78}%`;
  el.style.setProperty('--dx', `${(Math.random() - .5) * 140}px`);
  el.style.setProperty('--rot', `${(Math.random() - .5) * 50}deg`);
  el.innerHTML = '<i></i><small></small>';
  el.firstChild.textContent = emoji;
  el.lastChild.textContent = name;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

// ---------- screen effects ----------
export function shake() {
  if (!motionOn()) return;
  document.body.classList.remove('shake');
  void document.body.offsetWidth;
  document.body.classList.add('shake');
  navigator.vibrate?.(180);
  setTimeout(() => document.body.classList.remove('shake'), 950);
}

let discoTimer;
export function disco(ms = 6000) {
  if (!motionOn()) return;
  document.body.classList.add('disco');
  clearTimeout(discoTimer);
  discoTimer = setTimeout(() => document.body.classList.remove('disco'), ms);
}

export function rainbow() {
  const on = document.body.classList.toggle('rainbow');
  toast(on ? '🌈 Радужный режим включён' : 'Радуга выключена');
  if (on) confetti({ count: 160, power: 1.2 });
}

// ---------- sound (tiny synth, no files) ----------
let audio;
function tone(freq, dur = .12, type = 'sine', vol = .06, delay = 0) {
  if (!get().sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime + delay;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + .012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur + .02);
  } catch { /* audio blocked */ }
}
let lastPop = 0;
export function sound(kind) {
  switch (kind) {
    case 'msg':   tone(660, .09, 'sine', .05); tone(880, .12, 'sine', .05, .08); break;
    case 'react': if (Date.now() - lastPop < 120) return; lastPop = Date.now(); tone(520 + Math.random() * 300, .1, 'triangle', .05); break;
    case 'join':  tone(523, .1, 'sine', .06); tone(659, .1, 'sine', .06, .09); tone(784, .16, 'sine', .06, .18); break;
    case 'leave': tone(520, .1, 'sine', .05); tone(392, .16, 'sine', .05, .09); break;
    case 'tick':  tone(440, .12, 'square', .04); break;
    case 'go':    tone(880, .3, 'square', .05); tone(1175, .3, 'sine', .05, .02); break;
    case 'party': [523, 659, 784, 1047].forEach((f, i) => tone(f, .14, 'triangle', .06, i * .07)); break;
    case 'err':   tone(180, .2, 'sawtooth', .04); break;
  }
}

// ---------- ambient helpers ----------
export function buildStars() {
  const host = document.getElementById('stars');
  if (!host) return;
  const shadows = (n, maxAlpha) => Array.from({ length: n }, () =>
    `${(Math.random() * 100).toFixed(1)}vw ${(Math.random() * 100).toFixed(1)}vh rgba(255,255,255,${(.35 + Math.random() * maxAlpha).toFixed(2)})`).join(',');
  const [a, b] = host.children;
  a.style.boxShadow = shadows(70, .6);
  b.style.boxShadow = shadows(90, .4);
}

export function installPointerGlow() {
  let ev = null, queued = false;
  document.addEventListener('pointermove', (e) => {
    ev = e;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const g = ev.target.closest && ev.target.closest('.glass');
      if (!g) return;
      const r = g.getBoundingClientRect();
      g.style.setProperty('--mx', `${ev.clientX - r.left}px`);
      g.style.setProperty('--my', `${ev.clientY - r.top}px`);
    });
  }, { passive: true });
}

export function installRipple() {
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn');
    if (!b || !motionOn()) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });
}
