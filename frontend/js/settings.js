// Interface settings: theme, accent, glass, motion, effects, nickname.
// Stored in localStorage; for signed-in users also synced to the server.

const KEY = 'wm_settings';

export const THEMES = [
  { id: 'aurora',   name: 'Аврора',   c: ['#070b1f', '#1b1050', '#19d3c5'] },
  { id: 'midnight', name: 'Полночь',  c: ['#04050a', '#0b1530', '#3b82f6'] },
  { id: 'sunset',   name: 'Закат',    c: ['#1d0b1f', '#4a1334', '#ff7a59'] },
  { id: 'ocean',    name: 'Океан',    c: ['#03161f', '#053247', '#00e5a8'] },
  { id: 'graphite', name: 'Графит',   c: ['#0c0c0d', '#17171a', '#a78bfa'] },
  { id: 'sakura',   name: 'Сакура',   c: ['#fff3f8', '#ffd9ea', '#c8a2ff'] },
  { id: 'mint',     name: 'Мята',     c: ['#effff8', '#d3f8e6', '#7cc8ff'] },
];
const THEME_BG = { aurora: '#070b1f', midnight: '#04050a', sunset: '#1d0b1f', ocean: '#03161f', graphite: '#0c0c0d', sakura: '#fff3f8', mint: '#effff8' };

export const ACCENTS = ['#7c5cff', '#19d3c5', '#ff5fa2', '#ff8a3d', '#35e08a', '#3b82f6', '#f43f5e', '#facc15'];

export const DEFAULTS = {
  theme: 'aurora', accent: '#7c5cff',
  blur: 26, glass: 12, radius: 22,
  motion: 'full', bg: 'blobs',
  confetti: true, sound: true, cinema: false,
  streamer: true,   // hide the room code on screen and in the address bar (on by default)
  nickname: '',
};

let current = { ...DEFAULTS };
const listeners = new Set();
let remoteSaver = null;
let remoteTimer = null;

export const get = () => current;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const setRemoteSaver = (fn) => { remoteSaver = fn; };

function clean(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (THEMES.some((t) => t.id === raw.theme)) out.theme = raw.theme;
  if (typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent)) out.accent = raw.accent.toLowerCase();
  if (['full', 'calm', 'off'].includes(raw.motion)) out.motion = raw.motion;
  if (['blobs', 'stars', 'grid', 'none'].includes(raw.bg)) out.bg = raw.bg;
  for (const [k, lo, hi] of [['blur', 0, 60], ['glass', 2, 45], ['radius', 6, 38]]) {
    if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = Math.round(Math.min(hi, Math.max(lo, raw[k])));
  }
  for (const k of ['confetti', 'sound', 'cinema', 'streamer']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  if (typeof raw.nickname === 'string') out.nickname = raw.nickname.replace(/\s+/g, ' ').trim().slice(0, 24);
  return out;
}

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function apply() {
  const s = current, root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.bg = s.bg;
  root.dataset.motion = s.motion;
  root.dataset.cinema = s.cinema ? 'on' : 'off';

  const [h, sat, l] = hexToHsl(s.accent);
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--accent2', `hsl(${Math.round((h + 42) % 360)} ${Math.round(Math.max(sat, 60))}% ${Math.round(Math.min(Math.max(l, 45), 62))}%)`);
  root.style.setProperty('--accent-rgb', [1, 3, 5].map((i) => parseInt(s.accent.slice(i, i + 2), 16)).join(', '));
  root.style.setProperty('--blur', `${s.blur}px`);
  root.style.setProperty('--glass', String(s.glass / 100));
  root.style.setProperty('--radius', `${s.radius}px`);
  root.style.setProperty('--speed', s.motion === 'calm' ? '2.4' : '1');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_BG[s.theme] || '#070b1f';
}

function emit(changedKeys) {
  apply();
  for (const fn of listeners) fn(current, changedKeys);
}

export function load() {
  let saved = {};
  try { saved = clean(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  current = { ...DEFAULTS, ...(reduced && !saved.motion ? { motion: 'calm' } : {}), ...saved };
  apply();
}

function persistLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
}

function scheduleRemote() {
  if (!remoteSaver) return;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(flush, 800);
}

export async function flush() {
  clearTimeout(remoteTimer);
  remoteTimer = null;
  if (remoteSaver) { try { await remoteSaver(current); } catch { /* offline: local copy is still there */ } }
}

export function set(patch) {
  const c = clean(patch);
  const keys = Object.keys(c).filter((k) => current[k] !== c[k]);
  if (!keys.length) return;
  current = { ...current, ...c };
  persistLocal();
  scheduleRemote();
  emit(keys);
}

// Used when the server sends the account's settings after sign-in.
export function adopt(remote, { pushIfEmpty = true } = {}) {
  const c = clean(remote);
  if (Object.keys(c).length) {
    current = { ...current, ...c };
    persistLocal();
    emit(Object.keys(c));
  } else if (pushIfEmpty) {
    scheduleRemote(); // first sign-in: keep the look the person already picked
  }
}

export function reset() {
  const nickname = current.nickname;
  current = { ...DEFAULTS, nickname };
  persistLocal();
  scheduleRemote();
  emit(Object.keys(DEFAULTS));
}
