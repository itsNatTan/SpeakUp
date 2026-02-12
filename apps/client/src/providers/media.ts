// media.ts
type AppendItem = ArrayBuffer;

function pickPlaybackMime(): string | undefined {
  const MS = (window as any).MediaSource;
  if (!MS || typeof MS.isTypeSupported !== 'function') return undefined;

  const mp4Candidates = [
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4',
  ];
  const webmCandidates = [
    'audio/webm; codecs="opus"',
    'audio/webm',
  ];

  const ua = navigator.userAgent || '';
  const seemsSafariIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));

  const primary = seemsSafariIOS ? mp4Candidates : webmCandidates;
  const secondary = seemsSafariIOS ? webmCandidates : mp4Candidates;

  for (const t of primary) if (MS.isTypeSupported(t)) return t;
  for (const t of secondary) if (MS.isTypeSupported(t)) return t;
  return undefined; // let the browser/provider try default
}

export class MediaProvider {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer!: SourceBuffer;
  private _sourceUrl: string | null = null;
  private mimeType?: string; // now optional
  private queue: AppendItem[] = [];
  private attachingEl: HTMLMediaElement | null = null;
  private sourceOpenResolve!: () => void;
  private sourceOpenPromise: Promise<void>;
  private startedPlayback = false;
  private destroyed = false;

  // mobile-friendly prebuffer target (tune 0.2–0.6s)
  private PREBUFFER_SEC = 0.4;
  // keep ~2s before currentTime to allow small seeks/gaps when evicting
  private KEEP_TAIL_SEC = 2.0;
  // single retry flag for QuotaExceeded
  private pendingRetry = false;

  constructor(mimeType?: string) {
    this.mimeType = mimeType;
    if (!('MediaSource' in window)) {
      throw new Error('MediaSource not supported in this browser.');
    }

    // If a mime is provided but not actually supported, fall back gracefully.
    const MS = (window as any).MediaSource;
    if (this.mimeType && typeof MS.isTypeSupported === 'function' && !MS.isTypeSupported(this.mimeType)) {
      // Try to self-pick a working type instead of throwing (Safari 16 edge cases).
      this.mimeType = pickPlaybackMime();
    }
    if (!this.mimeType) {
      // Last resort: attempt auto-pick; if still undefined, we’ll ask MSE to decide.
      this.mimeType = pickPlaybackMime();
    }

    this.mediaSource = new MediaSource();
    this.sourceOpenPromise = new Promise<void>((res) => (this.sourceOpenResolve = res));

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.mediaSource) return;
      try {
        // If mimeType is undefined, let MSE try default audio SourceBuffer (rare but can work).
        this.sourceBuffer = this.mimeType
          ? this.mediaSource.addSourceBuffer(this.mimeType)
          : this.mediaSource.addSourceBuffer('audio/mp4'); // nudge toward the most broadly mobile-safe default
      } catch (e) {
        // As a last fallback, attempt the other family once.
        try {
          const alt = this.mimeType?.includes('mp4') ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"';
          this.sourceBuffer = this.mediaSource.addSourceBuffer(alt);
          this.mimeType = alt;
          // console.warn('addSourceBuffer fallback to', alt, e);
        } catch (e2) {
          console.error('addSourceBuffer failed', e2);
          return;
        }
      }
      this.sourceBuffer.addEventListener('updateend', () => this.flush());
      // Some browsers fire 'error' on SourceBuffer; catch and rebuild if so.
      (this.sourceBuffer as any).addEventListener?.('error', () => this.rebuild());
      this.sourceOpenResolve();
      // kick a first flush if anything was queued before sourceopen
      this.flush();
    });
  }

  /** Attach once to an <audio> element. Do not change src after this. */
  public attach(audioEl: HTMLMediaElement) {
    if (this._sourceUrl) return; // already attached
    if (!this.mediaSource) throw new Error('No MediaSource');
    this.attachingEl = audioEl;
    this._sourceUrl = URL.createObjectURL(this.mediaSource);
    audioEl.src = this._sourceUrl;
    // iOS inline playback hint (harmless elsewhere)
    (audioEl as any).playsInline = true;

    // Mobile: resume when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && audioEl.paused && !audioEl.error) {
        audioEl.play().catch(() => {});
      }
    });
  }

  /** Append a chunk (e.g., from WebSocket). Safe to call from anywhere. */
  public async buffer(data: ArrayBuffer) {
    if (this.destroyed) return;
    this.queue.push(data);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.destroyed) return;
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
      await this.sourceOpenPromise;
    }
    if (this.destroyed) return;
    if (!this.mediaSource || this.mediaSource.readyState !== 'open' || !this.sourceBuffer || this.sourceBuffer.updating) return;
    if (!this.queue.length) {
      // try to (re)start playback once there is enough buffered data
      this.maybeStartPlayback();
      return;
    }

    // Guard: if audio element errored, rebuild cleanly
    if (this.attachingEl?.error || this.mediaSource?.readyState === 'ended') {
      await this.rebuild();
      return;
    }

    try {
      const chunk = this.queue.shift()!;
      if (!this.sourceBuffer || !this.mediaSource || this.mediaSource.readyState !== 'open') return;
      this.sourceBuffer.appendBuffer(chunk);
      this.pendingRetry = false; // successful append clears quota retry guard
    } catch (e: any) {
      if (e && (e.name === 'QuotaExceededError' || e.name === 'QuotaExceeded')) {
        // Evict old data and retry once
        if (!this.pendingRetry) {
          this.pendingRetry = true;
          await this.evictOld();
          return this.flush(); // retry once
        }
      }
      console.error('appendBuffer failed; rebuilding pipeline', e);
      await this.rebuild();
    }
  }

  private maybeStartPlayback() {
    if (!this.attachingEl || this.startedPlayback) return;
    const a = this.attachingEl;

    // Ensure we have a small buffer floor before starting on mobile
    const bufEnd = this.bufferedEnd();
    if (bufEnd === null) return;

    const bufferedAhead = bufEnd - (a.currentTime || 0);
    if (bufferedAhead < this.PREBUFFER_SEC) return;

    this.startedPlayback = true;
    a.play().catch(() => {
      // If it rejects due to gesture policy, we’ll try again next flush after user action.
      this.startedPlayback = false;
    });
  }

  private bufferedEnd(): number | null {
    try {
      if (!this.attachingEl) return null;
      const b = this.attachingEl.buffered;
      if (!b || b.length === 0) return null;
      return b.end(b.length - 1);
    } catch {
      return null;
    }
  }

  private currentBufferedStart(): number | null {
    try {
      if (!this.attachingEl) return null;
      const b = this.attachingEl.buffered;
      if (!b || b.length === 0) return null;
      return b.start(0);
    } catch {
      return null;
    }
  }

  /** Trim old data to free space; keep a small tail behind currentTime. */
  private async evictOld() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.attachingEl) return;
    const a = this.attachingEl;
    const start = this.currentBufferedStart();
    if (start === null) return;

    const safeRemoveEnd = Math.max(0, a.currentTime - this.KEEP_TAIL_SEC);
    if (safeRemoveEnd <= start) return;

    try {
      this.sourceBuffer.remove(0, safeRemoveEnd);
      await new Promise<void>((res) => {
        const done = () => {
          this.sourceBuffer.removeEventListener('updateend', done);
          res();
        };
        this.sourceBuffer.addEventListener('updateend', done, { once: true });
      });
    } catch {}
  }

  /** Clean, mobile-safe rebuild (use when element errors or MSE goes bad). */
  private async rebuild() {
    if (this.destroyed) return;

    // Detach old
    try {
      if (this.mediaSource?.readyState === 'open' && this.sourceBuffer && !this.sourceBuffer.updating) {
        // Avoid endOfStream mid-session; it can lock appends on some mobiles.
      }
    } catch {}
    if (this._sourceUrl) {
      try { URL.revokeObjectURL(this._sourceUrl); } catch {}
    }

    // Create a fresh pipeline
    this.mediaSource = new MediaSource();
    this.sourceOpenPromise = new Promise<void>((res) => (this.sourceOpenResolve = res));
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.destroyed || !this.mediaSource || this.mediaSource.readyState !== 'open') return;
      try {
        this.sourceBuffer = this.mimeType
          ? this.mediaSource!.addSourceBuffer(this.mimeType)
          : this.mediaSource!.addSourceBuffer('audio/mp4');
      } catch (e) {
        if (this.destroyed) return;
        try {
          const alt = this.mimeType?.includes('mp4') ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"';
          this.sourceBuffer = this.mediaSource!.addSourceBuffer(alt);
          this.mimeType = alt;
        } catch (e2) {
          if (!this.destroyed) console.error('addSourceBuffer failed after rebuild', e2);
          return;
        }
      }
      this.sourceBuffer.addEventListener('updateend', () => this.flush());
      (this.sourceBuffer as any).addEventListener?.('error', () => this.rebuild());
      this.sourceOpenResolve();
      this.flush();
    });

    // Reattach to the same element without calling load()
    if (this.attachingEl) {
      this._sourceUrl = URL.createObjectURL(this.mediaSource);
      this.attachingEl.src = this._sourceUrl;
      (this.attachingEl as any).playsInline = true;
      this.startedPlayback = false; // we’ll restart once prebuffered
      this.pendingRetry = false;
    }
  }

  /** Dispose everything when the session ends. */
  public dispose() {
    this.destroyed = true;
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open' && this.sourceBuffer && !this.sourceBuffer.updating) {
        // optional: this.mediaSource.endOfStream();
      }
    } catch {}
    if (this._sourceUrl) {
      try { URL.revokeObjectURL(this._sourceUrl); } catch {}
    }
    this.queue = [];
    this.attachingEl = null;
    this.mediaSource = null;
  }

  /** For completeness, but avoid calling mid-session on mobile. */
  public async reinitialize() {
    // Instead of remove()/changeType() (which creates gaps), just rebuild.
    await this.rebuild();
  }
}
