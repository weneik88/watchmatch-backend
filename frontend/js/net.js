// HTTP helper and the room WebSocket (auto-reconnect + server clock sync).

export const API = ((window.WM_API || '').replace(/\/+$/, '')) || location.origin;

export function wsUrl(roomId) {
  const u = new URL(API);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `/ws/${encodeURIComponent(roomId)}`;
  u.search = '';
  return u.toString();
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export class RoomSocket {
  /**
   * handlers: { hello(): object, onMessage(msg), onStatus(status) }
   * status: 'connecting' | 'open' | 'reconnecting' | 'closed'
   */
  constructor(roomId, handlers) {
    this.roomId = roomId;
    this.h = handlers;
    this.attempt = 0;
    this.closed = false;
    this.fatal = false;
    this.offset = 0;          // serverTime - clientTime, ms
    this.bestRtt = Infinity;
    this.sampled = false;
    this.connect();
  }

  serverNow() { return Date.now() + this.offset; }

  connect() {
    this.h.onStatus?.('connecting');
    let ws;
    try { ws = new WebSocket(wsUrl(this.roomId)); } catch { this.retry(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.bestRtt = Infinity;
      this.sampled = false;
      ws.send(JSON.stringify({ t: 'hello', ...this.h.hello() }));
      this.h.onStatus?.('open');
      this.startPings();
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'pong') return this.onPong(m);
      if (m.t === 'welcome' && typeof m.now === 'number' && !this.sampled) this.offset = m.now - Date.now(); // rough, refined by pings
      if (m.t === 'error' && m.fatal) this.fatal = true;
      this.h.onMessage(m);
    };
    ws.onclose = () => {
      this.stopPings();
      if (this.closed) return;
      if (this.fatal) { this.h.onStatus?.('closed'); return; }
      this.retry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  retry() {
    this.h.onStatus?.('reconnecting');
    const delay = Math.min(8000, 700 * 2 ** this.attempt) + Math.random() * 400;
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.closed) this.connect(); }, delay);
  }

  startPings() {
    this.stopPings();
    const ping = () => this.send({ t: 'ping', c: Date.now() });
    [0, 250, 500, 800].forEach((d) => setTimeout(ping, d));
    this.pingTimer = setInterval(ping, 15000);
  }
  stopPings() { clearInterval(this.pingTimer); }

  onPong(m) {
    const now = Date.now();
    const rtt = now - m.c;
    if (!(rtt >= 0) || rtt > 5000) return;
    const off = m.s + rtt / 2 - now;
    this.bestRtt += 2; // slowly forget, so the estimate can adapt
    if (rtt <= this.bestRtt + 30 || !this.sampled) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      this.offset = this.sampled ? this.offset * .5 + off * .5 : off;
      this.sampled = true;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.stopPings();
    try { this.ws && this.ws.close(1000); } catch { /* already closed */ }
  }
}
