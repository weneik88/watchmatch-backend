// One interface over an HTML5 <video> and the YouTube IFrame player.
//
// The room code drives it "level-triggered": every few hundred ms it computes
// where the video *should* be and calls the methods below. So every method is
// safe to call repeatedly and does nothing until the player is ready.

const keyOf = (src) => (src.kind === 'youtube' ? `yt:${src.id}` : `file:${src.url}`);

let ytPromise = null;
function loadYT() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!ytPromise) {
    ytPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (typeof prev === 'function') prev(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      const fail = (e) => { ytPromise = null; s.remove(); reject(e); };
      s.onerror = () => fail(new Error('script'));
      setTimeout(() => { if (!(window.YT && window.YT.Player)) fail(new Error('timeout')); }, 15000);
      document.head.appendChild(s);
    });
  }
  return ytPromise;
}

export class Player {
  constructor({ video, ytHost, onEnded, onError }) {
    this.video = video;
    this.ytHost = ytHost;
    this.onEnded = onEnded;
    this.onError = onError;

    this.key = null;
    this.kind = null;
    this.ready = false;
    this.token = 0;

    this.volume = 0.8;
    this.muted = false;

    this.yt = null;
    this.ytReady = false;
    this.ytRate = null;
    this.curYtId = null;
    this.wantYt = null;

    video.addEventListener('loadedmetadata', () => { if (this.kind === 'file') { this.ready = true; this._applyVolume(); } });
    video.addEventListener('ended', () => { if (this.kind === 'file') this.onEnded?.(); });
    video.addEventListener('error', () => {
      if (this.kind === 'file' && this.video.getAttribute('src')) this.onError?.('Не удалось открыть это видео. Нужна прямая ссылка на файл .mp4 или .webm, доступная из браузера.');
    });
  }

  load(src) {
    const key = keyOf(src);
    if (key === this.key) return;
    this.key = key;
    this.token++;
    this.ready = false;
    this.ytRate = null;

    if (src.kind === 'file') {
      this.kind = 'file';
      this._pauseYT();
      this.ytHost.hidden = true;
      this.video.hidden = false;
      this.video.src = src.url;
      this.video.load();
      this._applyVolume();
    } else {
      this.kind = 'youtube';
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.hidden = true;
      this.ytHost.hidden = false;
      this._openYT(src.id, this.token);
    }
  }

  unload() {
    this.key = null;
    this.kind = null;
    this.ready = false;
    this.token++;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.hidden = true;
    this._pauseYT();
    this.ytHost.hidden = true;
  }

  destroy() {
    this.unload();
    if (this.yt) { try { this.yt.destroy(); } catch { /* already gone */ } }
    this.yt = null;
    this.ytReady = false;
    this.ytHost.replaceChildren();
  }

  _pauseYT() { if (this.yt && this.ytReady) { try { this.yt.pauseVideo(); } catch { /* ignore */ } } }

  async _openYT(id, tok) {
    let YT;
    try { YT = await loadYT(); } catch {
      if (tok === this.token) this.onError?.('Не удалось загрузить плеер YouTube. Возможно, он заблокирован в вашей сети.');
      return;
    }
    if (tok !== this.token) return;
    this.wantYt = id;

    if (this.yt) {
      if (this.ytReady) { this.yt.cueVideoById(id); this.curYtId = id; this.ytRate = null; this.ready = true; }
      return; // still starting: onReady will pick up wantYt
    }

    const mount = document.createElement('div');
    this.ytHost.replaceChildren(mount);
    this.curYtId = id;
    this.yt = new YT.Player(mount, {
      videoId: id,
      playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: () => {
          this.ytReady = true;
          this._applyVolume();
          if (this.kind === 'youtube') {
            if (this.curYtId !== this.wantYt) { this.yt.cueVideoById(this.wantYt); this.curYtId = this.wantYt; }
            this.ready = true;
          }
        },
        onStateChange: (e) => { if (e.data === 0 && this.kind === 'youtube') this.onEnded?.(); },
        onError: (e) => {
          const code = e && e.data;
          this.onError?.([2, 5].includes(code) ? 'YouTube не смог открыть это видео.' : 'Это видео недоступно или его автор запретил встраивание.');
        },
      },
    });
  }

  // ---- reading ----
  time() {
    if (!this.ready) return 0;
    if (this.kind === 'file') return this.video.currentTime || 0;
    try { return this.yt.getCurrentTime() || 0; } catch { return 0; }
  }
  duration() {
    if (!this.ready) return 0;
    if (this.kind === 'file') return Number.isFinite(this.video.duration) ? this.video.duration : 0;
    try { return this.yt.getDuration() || 0; } catch { return 0; }
  }
  isPlaying() {
    if (!this.ready) return false;
    if (this.kind === 'file') return !this.video.paused && !this.video.ended;
    try { const s = this.yt.getPlayerState(); return s === 1 || s === 3; } catch { return false; }
  }
  ended() {
    if (!this.ready) return false;
    if (this.kind === 'file') return this.video.ended;
    try { return this.yt.getPlayerState() === 0; } catch { return false; }
  }

  // ---- control ----
  async play() {
    if (!this.ready) return true;
    if (this.kind === 'file') {
      try { await this.video.play(); return true; } catch (e) { return e && e.name === 'AbortError'; }
    }
    try { this.yt.playVideo(); } catch { /* ignore */ }
    return true;
  }
  pause() {
    if (!this.ready) return;
    if (this.kind === 'file') this.video.pause();
    else { try { this.yt.pauseVideo(); } catch { /* ignore */ } }
  }
  seek(t) {
    if (!this.ready || !Number.isFinite(t)) return;
    t = Math.max(0, t);
    if (this.kind === 'file') { try { this.video.currentTime = t; } catch { /* ignore */ } }
    else { try { this.yt.seekTo(t, true); } catch { /* ignore */ } }
  }
  setRate(rate, nudge = 1) {
    if (!this.ready) return;
    if (this.kind === 'file') {
      const v = Math.min(16, Math.max(0.0625, rate * nudge));
      if (Math.abs(this.video.playbackRate - v) > 1e-3) this.video.playbackRate = v;
    } else if (this.ytReady && rate !== this.ytRate) {
      try { this.yt.setPlaybackRate(rate); this.ytRate = rate; } catch { /* ignore */ }
    }
  }

  setVolume(v) { this.volume = Math.min(1, Math.max(0, v)); this._applyVolume(); }
  setMuted(m) { this.muted = !!m; this._applyVolume(); }
  _applyVolume() {
    this.video.volume = this.volume;
    this.video.muted = this.muted;
    if (this.yt && this.ytReady) {
      try { this.yt.setVolume(Math.round(this.volume * 100)); this.muted ? this.yt.mute() : this.yt.unMute(); } catch { /* ignore */ }
    }
  }
}
