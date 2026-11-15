// Entry point: views, routing, Google sign-in, easter eggs.

import { api } from './net.js';
import * as S from './settings.js';
import * as fx from './fx.js';
import { initSettingsUI } from './settings-ui.js';
import { RoomView, makeAvatar } from './room.js';

const $ = (id) => document.getElementById(id);
const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

let token = null;
let user = null;
let cfg = null;
let gsiReady = false;

try { token = localStorage.getItem('wm_token'); } catch { /* storage blocked */ }

const taglines = [
  'Вместе смотреть кино можно и на расстоянии.',
  'Нажмите play в один и тот же момент. Серьёзно, до секунды.',
  'Чат, реакции и попкорн летят прямо поверх видео.',
  'Пара на расстоянии, друзья в разных городах, семья на связи.',
  'Никаких установок: создал комнату, отправил ссылку, смотришь.',
];

// ------------------------------------------------------------------ views
const room = new RoomView({
  getIdentity: () => ({ name: identityName(), token: token || undefined }),
  onExit: () => { if (location.hash.startsWith('#/r/')) location.hash = ''; showHome(); },
});

function identityName() {
  if (user) return S.get().nickname || user.name;
  return S.get().nickname || $('guest-name').value.trim();
}

function showHome() {
  $('view-room').hidden = true;
  $('view-home').hidden = false;
}

function route() {
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9_-]{3,32})$/);
  if (m) {
    $('view-home').hidden = true;
    $('view-room').hidden = false;
    if (room.code !== m[1]) room.enter(m[1]);
  } else {
    if (room.code) room.leave(true);
    showHome();
  }
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

function saveGuestName() {
  try { localStorage.setItem('wm_guest', $('guest-name').value.trim().slice(0, 24)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ auth
function renderUser() {
  const chip = $('user-chip');
  chip.hidden = !user;
  $('login-box').hidden = !!user || !(cfg && cfg.googleClientId);
  $('name-field').hidden = !!user;
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
    try { localStorage.setItem('wm_token', token); } catch { /* ignore */ }
    S.adopt(user.settings);
    renderUser();
    fx.toast(`Привет, ${S.get().nickname || user.name}! 👋`);
    fx.confetti({ count: 120 });
    fx.sound('join');
  } catch (e) {
    fx.toast(e.status === 503 ? 'Вход через Google пока не настроен на сервере' : 'Не удалось войти через Google', 'err');
  }
}

function renderGoogleButton() {
  if (!gsiReady || user) return;
  const host = $('g-btn');
  host.replaceChildren();
  const light = ['sakura', 'mint'].includes(S.get().theme);
  window.google.accounts.id.renderButton(host, {
    type: 'standard', theme: light ? 'outline' : 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: 'ru', width: 300,
  });
}

function setupGoogle() {
  if (!cfg || !cfg.googleClientId) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.defer = true;
  s.onload = () => {
    if (!window.google || !window.google.accounts) return;
    window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
    gsiReady = true;
    renderGoogleButton();
  };
  s.onerror = () => { $('login-box').hidden = true; };
  document.head.appendChild(s);
}

function logout() {
  token = null;
  user = null;
  try { localStorage.removeItem('wm_token'); } catch { /* ignore */ }
  try { window.google?.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  renderUser();
  renderGoogleButton();
  fx.toast('Вы вышли из аккаунта');
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

try { $('guest-name').value = localStorage.getItem('wm_guest') || ''; } catch { /* ignore */ }
$('guest-name').addEventListener('input', saveGuestName);

$('create-room').addEventListener('click', () => { saveGuestName(); location.hash = `#/r/${newCode()}`; });
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = parseRoom($('join-code').value);
  if (!code) { fx.toast('Введи код комнаты или ссылку', 'err'); fx.sound('err'); return; }
  saveGuestName();
  location.hash = `#/r/${code}`;
});
$('brand').addEventListener('click', () => { if (location.hash) location.hash = ''; });
$('brand').addEventListener('dblclick', () => fx.rainbow());

addEventListener('hashchange', route);
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

// server config + session restore (the backend may be waking up, so none of this blocks the UI)
(async () => {
  try { cfg = await api('/config'); } catch { cfg = null; }
  if (token) {
    try {
      user = await api('/me', { token });
      S.adopt(user.settings, { pushIfEmpty: false });
    } catch (e) {
      if (e.status === 401) { token = null; try { localStorage.removeItem('wm_token'); } catch { /* ignore */ } }
    }
  }
  renderUser();
  setupGoogle();
})();
