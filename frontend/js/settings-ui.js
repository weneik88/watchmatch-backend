// The settings drawer: builds its controls and keeps them in sync with settings.js.

import * as S from './settings.js';
import * as fx from './fx.js';

const $ = (id) => document.getElementById(id);

export function initSettingsUI({ onLogout }) {
  const drawer = $('settings');
  let opener = null;
  let signedIn = false;
  let savedTimer;

  // ---- build controls ----
  const themeBox = $('theme-swatches');
  for (const t of S.THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-sw';
    b.dataset.id = t.id;
    b.setAttribute('aria-label', `Тема ${t.name}`);
    b.innerHTML = '<span class="pv"></span><span class="nm"></span>';
    b.firstChild.style.background = `linear-gradient(135deg, ${t.c[0]}, ${t.c[1]} 60%, ${t.c[2]})`;
    b.lastChild.textContent = t.name;
    b.addEventListener('click', () => { S.set({ theme: t.id }); fx.sound('react'); });
    themeBox.appendChild(b);
  }

  const accBox = $('accent-swatches');
  for (const c of S.ACCENTS) {
    const b = document.createElement('button');
    b.className = 'acc';
    b.dataset.c = c;
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', `Акцент ${c}`);
    b.addEventListener('click', () => S.set({ accent: c }));
    accBox.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.title = 'Свой цвет';
  custom.setAttribute('aria-label', 'Свой цвет');
  custom.addEventListener('input', () => S.set({ accent: custom.value }));
  accBox.appendChild(custom);

  for (const key of ['blur', 'glass', 'radius']) {
    const input = $(`s-${key}`);
    input.addEventListener('input', () => S.set({ [key]: Number(input.value) }));
  }
  for (const [id, key] of [['seg-motion', 'motion'], ['seg-bg', 'bg']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) S.set({ [key]: b.dataset.v });
    });
  }
  for (const key of ['confetti', 'sound', 'cinema']) {
    $(`t-${key}`).addEventListener('change', (e) => {
      S.set({ [key]: e.target.checked });
      if (key === 'sound' && e.target.checked) fx.sound('join');
      if (key === 'confetti' && e.target.checked) fx.confetti({ count: 60 });
    });
  }
  const nick = $('s-nick');
  nick.addEventListener('input', () => S.set({ nickname: nick.value }));
  $('reset-settings').addEventListener('click', () => { S.reset(); fx.toast('Настройки сброшены'); });
  $('logout').addEventListener('click', () => { close(); onLogout(); });

  // ---- sync UI <- settings ----
  function render() {
    const s = S.get();
    for (const b of themeBox.children) b.classList.toggle('on', b.dataset.id === s.theme);
    for (const b of accBox.querySelectorAll('.acc')) b.classList.toggle('on', b.dataset.c === s.accent);
    custom.value = s.accent;
    for (const key of ['blur', 'glass', 'radius']) {
      const input = $(`s-${key}`);
      if (document.activeElement !== input) input.value = s[key];
      const lo = Number(input.min), hi = Number(input.max);
      input.style.setProperty('--p', `${((s[key] - lo) / (hi - lo)) * 100}%`);
      $(`o-${key}`).textContent = key === 'glass' ? `${s[key]}%` : `${s[key]}`;
    }
    for (const [id, key] of [['seg-motion', 'motion'], ['seg-bg', 'bg']]) {
      for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === s[key]);
    }
    for (const key of ['confetti', 'sound', 'cinema']) $(`t-${key}`).checked = !!s[key];
    if (document.activeElement !== nick) nick.value = s.nickname;
  }
  S.onChange((_s, keys) => {
    render();
    if (!drawer.hidden) flashSaved();
  });
  render();

  function flashSaved() {
    const el = $('saved');
    el.textContent = signedIn ? 'Сохранено в аккаунте ✓' : 'Сохранено на этом устройстве ✓';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { el.textContent = ''; }, 1800);
  }

  // ---- open / close ----
  function open() {
    opener = document.activeElement;
    drawer.classList.remove('closing');
    drawer.hidden = false;
    $('saved').textContent = '';
    drawer.querySelector('.drawer-panel [data-close]').focus({ preventScroll: true });
  }
  function close() {
    if (drawer.hidden || drawer.classList.contains('closing')) return;
    drawer.classList.add('closing');
    const done = () => {
      drawer.hidden = true;
      drawer.classList.remove('closing');
      if (opener && opener.focus) opener.focus({ preventScroll: true });
    };
    setTimeout(done, S.get().motion === 'off' ? 0 : 300);
  }
  drawer.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) close(); });
  $('open-settings').addEventListener('click', open);
  $('open-settings-room').addEventListener('click', open);

  return {
    setUser(user) {
      signedIn = !!user;
      $('logout').hidden = !user;
      if (user && !S.get().nickname) nick.placeholder = user.name || 'Ник в комнатах';
      else nick.placeholder = 'Ник в комнатах';
    },
    open,
    close,
  };
}
