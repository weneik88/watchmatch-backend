// Entry point: views, routing, mandatory Google sign-in, streamer-mode address bar, easter eggs.

import { api } from './net.js';
import * as S from './settings.js';
import * as fx from './fx.js';
import { initSettingsUI } from './settings-ui.js';
import { RoomView, makeAvatar } from './room.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const ROOM_HASH_RE = /^#\/r\/([A-Za-z0-9_-]{3,32})$/;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

let token = null;
let user = null;
let cfg = null;
let cfgState = 'loading';            // loading | ok | offline | outdated
let cfgFails = 0;
let gsiState = 'idle';               // idle | loading | ready | failed
let authState = 'out';               // out | loading | in

try { token = localStorage.getItem('wm_token'); } catch { /* storage blocked */ }
if (token) authState = 'loading';

const taglines = [
  'Вместе смотреть кино можно и на расстоянии.',
  'Нажмите play в один и тот же момент. Серьёзно, до секунды.',
  'Чат, реакции и попкорн летят прямо поверх видео.',
  'Пара на расстоянии, друзья в разных городах, семья на связи.',
  'Никаких установок: создал комнату, отправил ссылку, смотришь.',
];

// ------------------------------------------------------------------ views
const room = new RoomView({
  getIdentity: () => ({ token: token || undefined }),
  onExit: () => { if (location.hash) location.hash = ''; showHome(); },
  onAuthLost: (message) => {
    dropSession();
    fx.toast(message || 'Войдите через Google, чтобы зайти в комнату', 'err');
    fx.sound('err');
  },
  onStreamerChange: () => syncUrl(),
});

function showHome() {
  $('view-room').hidden = true;
  $('view-home').hidden = false;
}

// The room the address bar points to. In streamer mode the bar only says "#/room"
// and the code itself lives in this tab's sessionStorage (so a reload still works).
function hashRoom() {
  const m = location.hash.match(ROOM_HASH_RE);
  if (m) return m[1];
  if (location.hash === '#/room') {
    try {
      const c = sessionStorage.getItem('wm_room');
      if (c && ROOM_RE.test(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

function syncUrl() {
  const code = room.code;
  if (!code) return;
  try { sessionStorage.setItem('wm_room', code); } catch { /* ignore */ }
  const want = S.get().streamer ? '#/room' : `#/r/${code}`;
  if (location.hash !== want) history.replaceState(null, '', location.pathname + location.search + want);
}

function route() {
  const code = hashRoom();
  if (code && authState === 'in') {
    $('view-home').hidden = true;
    $('view-room').hidden = false;
    if (room.code !== code) room.enter(code);
    syncUrl();
    return;
  }
  // Not signed in (or no room in the address): stay on the home screen. An invitation link
  // keeps its hash, so the person lands in the room right after signing in.
  if (room.code) room.leave(true);
  if (!code && location.hash === '#/room') history.replaceState(null, '', location.pathname + location.search);
  showHome();
  renderGate();
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function parseRoom(input) {
  let s = String(input || '').trim();
  const m = s.match(/#\/r\/([A-Za-z0-9_-]{3,32})/);
  if (m) return m[1];
  s = s.replace(/^.*\//, '');
  return ROOM_RE.test(s) ? s : null;
}

// ------------------------------------------------------------------ sign-in gate
function requireLogin() {
  if (authState === 'in') return true;
  fx.toast('Сначала войди через Google', 'err');
  fx.sound('err');
  return false;
}

// Explains on the home screen why the buttons are locked, and unlocks them after sign-in.
function renderGate() {
  const signedIn = authState === 'in';
  $('login-box').hidden = signedIn;
  let text = '';
  let google = false;
  if (!signedIn) {
    const invited = !!hashRoom();
    if (authState === 'loading') text = 'Проверяем вход…';
    else if (cfgState === 'loading') text = 'Подключаемся к серверу… Бесплатному серверу нужно до минуты, чтобы проснуться.';
    else if (cfgState === 'outdated') text = 'Сервер ещё не обновлён до новой версии. Попробуй чуть позже.';
    else if (cfgState === 'offline') {
      text = cfgFails >= 3
        ? 'Не получается связаться с сервером, пробуем снова. Если так долго: проверьте на сервере FRONTEND_ORIGIN и что выложена последняя версия.'
        : 'Не получается связаться с сервером, пробуем снова…';
    } else if (!cfg || !cfg.googleClientId) text = 'Вход через Google ещё не настроен на сервере (нужна переменная GOOGLE_CLIENT_ID).';
    else if (gsiState === 'failed') text = 'Не удалось загрузить вход через Google. Проверь интернет или отключи блокировщик.';
    else if (gsiState !== 'ready') text = 'Загружаем вход через Google…';
    else {
      google = true;
      text = invited ? 'Тебя позвали в комнату. Войди через Google, чтобы зайти.' : 'Войди через Google, чтобы создать комнату или зайти по коду.';
    }
  }
  $('login-note').textContent = text;
  $('g-btn').hidden = !google;
  $('create-room').disabled = !signedIn;
  $('join-code').disabled = !signedIn;
  $('join-form').querySelector('button').disabled = !signedIn;
}

function renderUser() {
  $('user-chip').hidden = !user;
  settingsUI.setUser(user);
  if (user) {
    const old = $('user-avatar');
    const av = makeAvatar({ name: user.name, avatar: user.avatar, id: user.id }, true);
    av.id = 'user-avatar';
    old.replaceWith(av);
    $('user-name').textContent = S.get().nickname || user.name;
  }
}

async function onCredential(resp) {
  try {
    const r = await api('/auth/google', { method: 'POST', body: { credential: resp.credential } });
    token = r.token;
    user = r.user;
    authState = 'in';
    try { localStorage.setItem('wm_token', token); } catch { /* ignore */ }
    S.adopt(user.settings);
    renderUser();
    renderGate();
    route(); // an invitation link now takes us straight into the room
    fx.toast(`Привет, ${S.get().nickname || user.name}! 👋`);
    fx.confetti({ count: 120 });
    fx.sound('join');
  } catch (e) {
    fx.toast(e.status === 503 ? 'Вход через Google пока не настроен на сервере' : 'Не удалось войти через Google', 'err');
  }
}

function renderGoogleButton() {
  if (gsiState !== 'ready' || authState === 'in') return;
  const host = $('g-btn');
  host.replaceChildren();
  const light = ['sakura', 'mint'].includes(S.get().theme);
  window.google.accounts.id.renderButton(host, {
    type: 'standard', theme: light ? 'outline' : 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: 'ru', width: 300,
  });
}

function setupGoogle() {
  if (!cfg || !cfg.googleClientId || gsiState !== 'idle') return;
  gsiState = 'loading';
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.defer = true;
  s.onload = () => {
    if (!window.google || !window.google.accounts) { gsiState = 'failed'; renderGate(); return; }
    window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
    gsiState = 'ready';
    renderGate();
    renderGoogleButton();
  };
  s.onerror = () => { gsiState = 'failed'; renderGate(); };
  document.head.appendChild(s);
}

// Forget the session (sign out, or the server no longer accepts it) and leave any room.
function dropSession() {
  token = null;
  user = null;
  authState = 'out';
  try { localStorage.removeItem('wm_token'); } catch { /* ignore */ }
  try { window.google?.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  renderUser();
  renderGate();
  renderGoogleButton();
  route();
}

function logout() {
  dropSession();
  fx.toast('Вы вышли из аккаунта');
}

// The free server sleeps; keep asking until it answers (or tells us it is an old version).
async function loadConfig() {
  for (let i = 0; ; i++) {
    try {
      cfg = await api('/config');
      cfgState = 'ok';
      cfgFails = 0;
      renderGate();
      return;
    } catch (e) {
      if (e.status === 404) { cfgState = 'outdated'; renderGate(); return; }
      cfgState = 'offline';
      cfgFails++;
      renderGate();
      await sleep(Math.min(8000, 1500 * (i + 1)));
    }
  }
}

async function restoreSession() {
  for (let i = 0; i < 10; i++) {
    try {
      user = await api('/me', { token });
      S.adopt(user.settings, { pushIfEmpty: false });
      authState = 'in';
      break;
    } catch (e) {
      if (e.status === 401) { // expired or revoked
        token = null;
        try { localStorage.removeItem('wm_token'); } catch { /* ignore */ }
        authState = 'out';
        break;
      }
      if (e.status) { authState = 'out'; break; } // the server answered, but not usefully
      await sleep(Math.min(8000, 1500 * (i + 1))); // asleep or unreachable
    }
  }
  if (authState === 'loading') authState = 'out';
  renderUser();
  renderGate();
  renderGoogleButton();
  route();
}

// ------------------------------------------------------------------ boot
S.load();
const settingsUI = initSettingsUI({ onLogout: logout });
fx.buildStars();
fx.installPointerGlow();
fx.installRipple();
S.setRemoteSaver(async (s) => { if (token) await api('/me/settings', { method: 'PUT', body: s, token }); });
S.onChange((_s, keys) => {
  if (keys.includes('theme')) renderGoogleButton();
  if (user && keys.includes('nickname')) $('user-name').textContent = S.get().nickname || user.name;
});

$('create-room').addEventListener('click', () => {
  if (!requireLogin()) return;
  location.hash = `#/r/${newCode()}`;
});
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!requireLogin()) return;
  const code = parseRoom($('join-code').value);
  if (!code) { fx.toast('Введи код комнаты или ссылку', 'err'); fx.sound('err'); return; }
  location.hash = `#/r/${code}`;
});
$('brand').addEventListener('click', () => { if (location.hash) location.hash = ''; });
$('brand').addEventListener('dblclick', () => fx.rainbow());

addEventListener('hashchange', route);
renderGate();
route();

// rotating tagline
{
  const el = $('tagline');
  let i = 0;
  el.textContent = taglines[0];
  setInterval(() => {
    if (document.hidden || $('view-home').hidden) return;
    el.classList.add('swap');
    setTimeout(() => { i = (i + 1) % taglines.length; el.textContent = taglines[i]; el.classList.remove('swap'); }, 400);
  }, 4500);
}

// Konami code: ↑ ↑ ↓ ↓ ← → ← → B A
{
  const seq = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let pos = 0;
  document.addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    pos = k === seq[pos] ? pos + 1 : (k === seq[0] ? 1 : 0);
    if (pos === seq.length) { pos = 0; fx.rainbow(); fx.fireworks(); fx.rain('🌈', 30); fx.sound('party'); }
  });
}

// server config and session restore run in the background: the page is usable (and explains itself) meanwhile
loadConfig().then(setupGoogle);
if (token) restoreSession();
