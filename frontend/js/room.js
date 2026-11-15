// The room screen: websocket events -> state -> player, chat, people, effects.

import { RoomSocket } from './net.js';
import { Player } from './player.js';
import * as S from './settings.js';
import * as fx from './fx.js';

const $ = (id) => document.getElementById(id);

export const hue = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

export function makeAvatar(m, small = false) {
  const url = typeof m.avatar === 'string' && m.avatar.startsWith('https://') ? m.avatar : null;
  let el;
  if (url) {
    el = document.createElement('img');
    el.src = url;
    el.alt = '';
    el.referrerPolicy = 'no-referrer';
    el.className = 'av';
    el.addEventListener('error', () => el.replaceWith(makeAvatar({ ...m, avatar: null }, small)), { once: true });
  } else {
    el = document.createElement('span');
    el.className = 'av';
    el.style.setProperty('--h', hue(m.name || m.id));
    el.textContent = (m.name || '?').trim().charAt(0).toUpperCase();
  }
  if (small) el.classList.add('sm');
  return el;
}

const REASON = {
  load: () => '🎬 Новое видео',
  play: () => '▶️ Играем',
  pause: () => '⏸️ Пауза',
  seek: (st) => `⏩ Перемотка на ${fmt(st.pos)}`,
  rate: (st) => `⚡ Скорость ${st.rate}×`,
};

export class RoomView {
  constructor({ getIdentity, onExit }) {
    this.getIdentity = getIdentity;
    this.onExit = onExit;
    this.sock = null;
    this.player = new Player({
      video: $('video'),
      ytHost: $('yt-host'),
      onEnded: () => this.onVideoEnded(),
      onError: (msg) => { fx.toast(msg, 'err'); fx.sound('err'); this.sys(msg); },
    });
    this.player.setVolume(Number(localStorage.getItem('wm_vol') ?? 0.8));
    this.player.setMuted(localStorage.getItem('wm_muted') === '1');
    this.reset();
    this.wire();
  }

  reset() {
    this.code = null;
    this.me = null;
    this.members = [];
    this.hostId = null;
    this.open = false;
    this.state = { src: null, playing: false, pos: 0, at: 0, rate: 1 };
    this.unread = 0;
    this.tab = 'chat';
    this.scrubbing = false;
    this.seekCooldown = 0;
    this.blocked = false;
    this.unlocked = false;
    this.cdTimers = [];
    this.lastIdle = 0;
  }

  get can() { return this.me != null && (this.me === this.hostId || this.open); }
  get isHost() { return this.me != null && this.me === this.hostId; }
  now() { return this.sock ? this.sock.serverNow() : Date.now(); }

  // ------------------------------------------------------------------ enter / leave
  enter(code) {
    this.leave(true);
    this.code = code;
    $('room-code').textContent = code;
    $('messages').replaceChildren();
    $('people').replaceChildren();
    $('avatars').replaceChildren();
    this.setTab('chat');
    this.renderSource();
    this.applyPermissions();
    this.updateGate();
    this.setConn('wait');

    this.sock = new RoomSocket(code, {
      hello: () => this.getIdentity(),
      onMessage: (m) => this.onMessage(m),
      onStatus: (st) => this.setConn(st === 'open' ? 'on' : st === 'closed' ? 'off' : 'wait', st),
    });
    this.loop = setInterval(() => this.apply(), 400);
    this.uiLoop = setInterval(() => this.updateUI(), 250);
  }

  leave(silent = false) {
    clearInterval(this.loop);
    clearInterval(this.uiLoop);
    this.cdTimers.forEach(clearTimeout);
    if (this.sock) { this.sock.close(); this.sock = null; }
    this.player.destroy();
    document.body.classList.remove('playing', 'disco', 'shake');
    document.title = 'WatchMatch — смотрим вместе';
    $('countdown').hidden = true;
    $('gate').hidden = true;
    $('floaters').replaceChildren();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.reset();
    if (!silent) this.onExit?.();
  }

  setConn(kind, status) {
    const d = $('conn');
    d.className = `dot ${kind === 'on' ? '' : kind}`;
    d.title = kind === 'on' ? 'Подключено' : status === 'reconnecting' ? 'Переподключаемся…' : kind === 'off' ? 'Отключено' : 'Подключаемся…';
  }

  // ------------------------------------------------------------------ incoming
  onMessage(m) {
    switch (m.t) {
      case 'welcome': return this.onWelcome(m);
      case 'members': this.setMembers(m); return;
      case 'join':
        this.sys(`👋 ${m.member.name} зашёл(ла)`);
        fx.sound('join');
        return;
      case 'leave':
        this.sys(`🚪 ${m.member.name} вышел(ла)`);
        fx.sound('leave');
        if (m.newHost) {
          const h = this.members.find((x) => x.id === m.newHost);
          if (h) this.sys(`👑 Новый хост: ${h.name}`);
        }
        return;
      case 'hostchanged':
        this.sys(`👑 Хост теперь ${m.name}`);
        if (m.host === this.me) { fx.toast('Теперь ты хост 👑'); fx.confetti({ count: 70 }); }
        return;
      case 'chat': this.addChat(m); return;
      case 'react':
        fx.floatEmoji($('floaters'), m.emoji, m.name);
        fx.sound('react');
        return;
      case 'party': this.onParty(m); return;
      case 'state': this.onState(m); return;
      case 'countdown': this.onCountdown(m); return;
      case 'error':
        fx.toast(m.message || 'Ошибка', 'err');
        fx.sound('err');
        if (m.fatal) setTimeout(() => this.leave(), 1800);
        return;
      default:
    }
  }

  onWelcome(m) {
    this.me = m.you;
    this.state = m.state;
    this.members = m.members;
    this.hostId = m.host;
    this.open = !!m.open;
    this.blocked = false;
    $('messages').replaceChildren();
    for (const c of m.chat || []) this.addChat(c, true);
    this.sys(`🎟 Комната ${this.code}. Отправь ссылку другу: кнопка 🔗 сверху`);
    this.renderMembers();
    this.applyPermissions();
    this.renderSource();
    this.updateGate();
    this.apply();
    if (!this.greeted) { this.greeted = true; fx.confetti({ count: 80, power: .8 }); }
  }

  setMembers(m) {
    this.members = m.members;
    this.hostId = m.host;
    this.open = !!m.open;
    this.renderMembers();
    this.applyPermissions();
  }

  onState(m) {
    this.state = m.state;
    this.seekCooldown = 0;
    this.blocked = false;
    this.cdTimers.forEach(clearTimeout);
    this.cdTimers = [];
    $('countdown').hidden = true;
    const fn = REASON[m.reason];
    if (fn) this.sys(`${fn(m.state)} — ${m.name}`);
    this.renderSource();
    this.updateGate();
    this.apply();
  }

  onCountdown(m) {
    this.state = m.state;
    this.seekCooldown = 0;
    this.blocked = false;
    this.cdTimers.forEach(clearTimeout);
    this.cdTimers = [];
    this.sys(`⏳ Старт через 3 секунды — ${m.name}`);
    const startLocal = m.startAt - (this.sock ? this.sock.offset : 0);
    const box = $('countdown');
    const show = (text, sound) => {
      box.hidden = false;
      const b = document.createElement('b');
      b.textContent = text;
      box.replaceChildren(b);
      fx.sound(sound);
    };
    for (const n of [3, 2, 1]) {
      const delay = startLocal - n * 1000 - Date.now();
      if (delay > -200) this.cdTimers.push(setTimeout(() => show(String(n), 'tick'), Math.max(0, delay)));
    }
    this.cdTimers.push(setTimeout(() => { show('▶', 'go'); fx.confetti({ count: 60, power: .8 }); }, Math.max(0, startLocal - Date.now())));
    this.cdTimers.push(setTimeout(() => { box.hidden = true; }, Math.max(0, startLocal - Date.now()) + 800));
    this.updateGate();
    this.apply();
  }

  onParty(m) {
    this.sys(`🎊 ${m.name} устроил(а) ${{ confetti: 'конфетти', popcorn: 'попкорн', shake: 'землетрясение', disco: 'диско' }[m.kind]}`);
    fx.sound('party');
    if (m.kind === 'confetti') { fx.confetti({ count: 170, power: 1.2 }); fx.fireworks(); }
    else if (m.kind === 'popcorn') fx.rain('🍿', 44);
    else if (m.kind === 'shake') fx.shake();
    else if (m.kind === 'disco') { fx.disco(7000); fx.confetti({ count: 80 }); }
  }

  onVideoEnded() {
    fx.fireworks();
    fx.sound('party');
    if (this.isHost && this.sock) this.sock.send({ t: 'pause', pos: this.player.duration() });
  }

  // ------------------------------------------------------------------ sync
  target() {
    const s = this.state;
    const now = this.now();
    const eff = !!(s.playing && now >= s.at);
    let t = s.pos + (eff ? ((now - s.at) / 1000) * s.rate : 0);
    const dur = this.player.duration();
    let over = false;
    if (dur > 0 && t >= dur) { t = dur; over = true; }
    return { eff, t, over };
  }

  apply() {
    const s = this.state;
    const p = this.player;
    if (!s.src) {
      if (p.key) p.unload();
      document.body.classList.remove('playing');
      return;
    }
    p.load(s.src);
    if (!p.ready) return;

    const { eff, t, over } = this.target();
    document.body.classList.toggle('playing', eff && !over);
    if (this.scrubbing) return;

    const factor = this.nudge(eff, t);
    p.setRate(s.rate, factor);

    const drift = p.time() - t;
    const nowMs = Date.now();

    if (eff && !over) {
      if (!p.isPlaying() && !this.blocked) {
        if (Math.abs(drift) > 0.4 && nowMs > this.seekCooldown) { p.seek(t); this.seekCooldown = nowMs + 1200; }
        p.play().then((ok) => { if (!ok) { this.blocked = true; this.updateGate(); } });
      } else if (Math.abs(drift) > (p.kind === 'youtube' ? 0.8 : 0.7) && nowMs > this.seekCooldown) {
        p.seek(t + 0.1);
        this.seekCooldown = nowMs + 1500;
      }
    } else {
      if (p.isPlaying()) p.pause();
      if (Math.abs(drift) > 0.3 && nowMs > this.seekCooldown) { p.seek(t); this.seekCooldown = nowMs + 600; }
    }
  }

  // Small drifts are corrected by speeding up / slowing down a little instead of jumping.
  nudge(eff, t) {
    if (!eff || this.player.kind !== 'file') return 1;
    const drift = this.player.time() - t;
    if (Math.abs(drift) < 0.12 || Math.abs(drift) > 0.7) return 1;
    return 1 - Math.max(-0.08, Math.min(0.08, drift * 0.25));
  }

  // ------------------------------------------------------------------ gate (autoplay policy)
  needsGesture() {
    if (this.unlocked) return false;
    const ua = navigator.userActivation;
    return ua ? !ua.hasBeenActive : false;
  }
  updateGate() {
    const show = !!this.state.src && (this.blocked || this.needsGesture());
    $('gate').hidden = !show;
  }

  // ------------------------------------------------------------------ UI
  renderSource() {
    const has = !!this.state.src;
    $('player-empty').hidden = has;
    $('empty-text').textContent = this.can
      ? 'Вставь ссылку на видео, и оно появится у всех в комнате.'
      : 'Ждём, пока хост выберет видео.';
  }

  applyPermissions() {
    const can = this.can;
    $('source-input').disabled = !can;
    $('source-form').querySelector('button').disabled = !can;
    $('source-input').placeholder = can ? 'Ссылка на YouTube или видео (.mp4, .webm)' : 'Видео выбирает хост 👑';
    for (const id of ['c-play', 'c-seek', 'c-rate']) $(id).disabled = !can;
    $('hostbar').hidden = !can;
    $('toggle-open').hidden = !this.isHost;
    $('toggle-open').classList.toggle('on', this.open);
    $('toggle-open').textContent = this.open ? '🎮 Пульт у всех: вкл' : '🎮 Пульт у всех: выкл';
    $('people-hint').textContent = this.open ? 'Пульт открыт: управлять может каждый.' : 'Управляет только хост.';
    this.renderSource();
    this.renderMembers();
  }

  renderMembers() {
    const list = $('people');
    list.replaceChildren();
    for (const m of this.members) {
      const li = document.createElement('li');
      li.className = 'inner';
      li.appendChild(makeAvatar(m));
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = m.name;
      const tags = [m.host ? '👑' : '', m.id === this.me ? 'ты' : '', m.guest ? '' : '✓'].filter(Boolean).join(' ');
      if (tags) { const sm = document.createElement('small'); sm.textContent = ` ${tags}`; nm.appendChild(sm); }
      li.appendChild(nm);
      if (this.isHost && m.id !== this.me) {
        const b = document.createElement('button');
        b.className = 'chip-btn';
        b.textContent = '👑';
        b.title = 'Сделать хостом';
        b.setAttribute('aria-label', `Сделать хостом: ${m.name}`);
        b.addEventListener('click', () => { this.sock?.send({ t: 'host', to: m.id }); });
        li.appendChild(b);
      }
      list.appendChild(li);
    }
    const av = $('avatars');
    av.replaceChildren();
    for (const m of this.members.slice(0, 5)) { const a = makeAvatar(m); a.title = m.name; av.appendChild(a); }
    if (this.members.length > 5) { const more = makeAvatar({ name: `+${this.members.length - 5}`, id: 'more' }); more.textContent = `+${this.members.length - 5}`; av.appendChild(more); }
    const c = $('count');
    c.textContent = String(this.members.length);
  }

  sys(text) {
    const el = document.createElement('div');
    el.className = 'sys';
    el.textContent = text;
    this.pushMessage(el, false);
  }

  addChat(m, quiet = false) {
    const mine = m.from === this.me;
    const row = document.createElement('div');
    row.className = `msg${mine ? ' me' : ''}`;
    row.style.setProperty('--h', hue(m.name));
    row.appendChild(makeAvatar({ name: m.name, avatar: m.avatar, id: m.from }, true));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.name;
    const text = document.createElement('span');
    text.textContent = m.text;
    bubble.append(who, text);
    row.appendChild(bubble);
    this.pushMessage(row, mine);
    if (!mine && !quiet) {
      fx.sound('msg');
      if (this.tab !== 'chat') { this.unread++; this.renderUnread(); }
    }
  }

  pushMessage(el, force) {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.appendChild(el);
    while (box.children.length > 200) box.firstChild.remove();
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  renderUnread() {
    const i = $('unread');
    i.textContent = this.unread ? String(this.unread) : '';
    i.classList.toggle('zero', !this.unread);
  }

  setTab(tab) {
    this.tab = tab;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    $('tab-chat').classList.toggle('active', tab === 'chat');
    $('tab-people').classList.toggle('active', tab === 'people');
    if (tab === 'chat') { this.unread = 0; this.renderUnread(); const b = $('messages'); b.scrollTop = b.scrollHeight; }
  }

  updateUI() {
    const p = this.player;
    const { eff, t, over } = this.target();
    const cur = p.ready ? (this.scrubbing ? Number($('c-seek').value) / 1000 * p.duration() : p.time()) : 0;
    const dur = p.duration();
    $('c-cur').textContent = fmt(cur);
    $('c-dur').textContent = fmt(dur);
    if (!this.scrubbing) {
      const seek = $('c-seek');
      seek.value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
      seek.style.setProperty('--p', `${seek.value / 10}%`);
    }
    const playing = eff && !over;
    const icon = $('c-play').querySelector('use');
    const want = playing ? '#i-pause' : '#i-play';
    if (icon.getAttribute('href') !== want) icon.setAttribute('href', want);
    $('c-rate').value = String(this.state.rate);
    document.title = playing ? '▶ WatchMatch' : 'WatchMatch — смотрим вместе';

    const wrap = $('player-wrap');
    wrap.classList.toggle('idle', playing && Date.now() - this.lastIdle > 3000);
  }

  // ------------------------------------------------------------------ user actions
  send(obj) { return this.sock ? this.sock.send(obj) : false; }

  togglePlay() {
    if (!this.can) return fx.toast('Пульт сейчас у хоста 👑');
    if (!this.state.src) return fx.toast('Сначала загрузи видео');
    const playing = this.state.playing;
    this.send({ t: playing ? 'pause' : 'play', pos: this.player.ready ? this.player.time() : undefined });
  }

  seekBy(delta) {
    if (!this.can || !this.state.src) return;
    const dur = this.player.duration();
    let t = this.player.time() + delta;
    t = Math.max(0, dur ? Math.min(dur, t) : t);
    this.send({ t: 'seek', pos: t });
  }

  wire() {
    $('c-play').addEventListener('click', () => this.togglePlay());
    $('player-wrap').addEventListener('click', (e) => {
      if (e.target.closest('.controls, .gate, button, select, input')) return;
      this.togglePlay();
    });
    $('player-wrap').addEventListener('dblclick', (e) => {
      if (e.target.closest('.controls, .gate')) return;
      this.toggleFullscreen();
    });
    $('player-wrap').addEventListener('pointermove', () => { this.lastIdle = Date.now(); $('player-wrap').classList.remove('idle'); });

    const seek = $('c-seek');
    seek.addEventListener('pointerdown', () => { this.scrubbing = true; });
    seek.addEventListener('input', () => {
      seek.style.setProperty('--p', `${seek.value / 10}%`);
      $('c-cur').textContent = fmt((seek.value / 1000) * this.player.duration());
    });
    seek.addEventListener('change', () => {
      const t = (seek.value / 1000) * this.player.duration();
      this.scrubbing = false;
      if (this.can) this.send({ t: 'seek', pos: t });
    });
    seek.addEventListener('pointerup', () => { this.scrubbing = false; });
    seek.addEventListener('blur', () => { this.scrubbing = false; });

    $('c-rate').addEventListener('change', (e) => this.send({ t: 'rate', rate: Number(e.target.value) }));

    const vol = $('c-vol');
    vol.value = String(Math.round(this.player.volume * 100));
    vol.style.setProperty('--p', `${vol.value}%`);
    vol.addEventListener('input', () => {
      this.player.setVolume(vol.value / 100);
      if (vol.value > 0 && this.player.muted) this.player.setMuted(false);
      vol.style.setProperty('--p', `${vol.value}%`);
      this.renderVolIcon();
      try { localStorage.setItem('wm_vol', String(vol.value / 100)); localStorage.setItem('wm_muted', this.player.muted ? '1' : '0'); } catch { /* ignore */ }
    });
    $('c-mute').addEventListener('click', () => this.toggleMute());
    $('c-full').addEventListener('click', () => this.toggleFullscreen());
    this.renderVolIcon();

    $('gate-btn').addEventListener('click', () => {
      this.unlocked = true;
      this.blocked = false;
      $('gate').hidden = true;
      this.apply();
    });

    $('source-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('source-input');
      const url = input.value.trim();
      if (!url) return;
      if (this.send({ t: 'load', url })) input.value = '';
      else fx.toast('Нет соединения с сервером', 'err');
    });

    for (const b of document.querySelectorAll('#reactions .emoji-btn')) {
      b.addEventListener('click', () => this.send({ t: 'react', emoji: b.dataset.emoji }));
    }
    for (const b of document.querySelectorAll('#party .chip-btn')) {
      b.addEventListener('click', () => this.send({ t: 'party', kind: b.dataset.party }));
    }
    $('start-countdown').addEventListener('click', () => this.send({ t: 'countdown' }));
    $('toggle-open').addEventListener('click', () => this.send({ t: 'control', open: !this.open }));

    $('leave').addEventListener('click', () => { if (location.hash) location.hash = ''; else this.leave(); });
    $('copy-link').addEventListener('click', () => this.copyLink());

    for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => this.setTab(b.dataset.tab));
    $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); this.submitChat(); });

    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('fullscreenchange', () => $('player-wrap').classList.toggle('fs', !!document.fullscreenElement));
  }

  renderVolIcon() {
    const muted = this.player.muted || this.player.volume === 0;
    $('c-mute').querySelector('use').setAttribute('href', muted ? '#i-mute' : '#i-vol');
  }
  toggleMute() {
    this.player.setMuted(!this.player.muted);
    this.renderVolIcon();
    try { localStorage.setItem('wm_muted', this.player.muted ? '1' : '0'); } catch { /* ignore */ }
  }
  toggleFullscreen() {
    const el = $('player-wrap');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  }

  async copyLink() {
    const link = `${location.origin}${location.pathname}#/r/${this.code}`;
    try { await navigator.clipboard.writeText(link); fx.toast('Ссылка скопирована 🔗'); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); fx.toast('Ссылка скопирована 🔗'); } catch { fx.toast(link); }
      ta.remove();
    }
  }

  submitChat() {
    const input = $('chat-input');
    let text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      switch (cmd.toLowerCase()) {
        case 'help': return this.sys('Команды: /shrug, /roll, /flip, /confetti, /popcorn, /shake, /disco, /rainbow');
        case 'shrug': text = `${arg} ¯\\_(ツ)_/¯`.trim(); break;
        case 'roll': text = `🎲 выпало ${1 + Math.floor(Math.random() * 100)} из 100`; break;
        case 'flip': text = `🪙 ${Math.random() < .5 ? 'Орёл' : 'Решка'}`; break;
        case 'confetti': case 'popcorn': case 'shake': case 'disco':
          return void this.send({ t: 'party', kind: cmd.toLowerCase() });
        case 'rainbow': return fx.rainbow();
        default: return this.sys('Неизвестная команда. Попробуй /help');
      }
    }
    if (!this.send({ t: 'chat', text })) fx.toast('Нет соединения', 'err');
  }

  onKey(e) {
    if (!this.code || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($('settings') && !$('settings').hidden) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); this.togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); this.seekBy(-5); break;
      case 'ArrowRight': e.preventDefault(); this.seekBy(5); break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case 'm': case 'M': this.toggleMute(); break;
      default:
    }
  }
}
