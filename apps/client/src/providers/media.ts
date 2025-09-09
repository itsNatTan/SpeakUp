// media.ts
type AppendItem = ArrayBuffer;

export class MediaProvider {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer!: SourceBuffer;
  private _sourceUrl: string | null = null;
  private mimeType: string;
  private queue: AppendItem[] = [];
  private attachingEl: HTMLMediaElement | null = null;
  private sourceOpenResolve!: () => void;
  private sourceOpenPromise: Promise<void>;
  private startedPlayback = false;
  private destroyed = false;

  // mobile-friendly prebuffer target (tune 0.2–0.6s)
  private PREBUFFER_SEC = 0.4;

  constructor(mimeType: string) {
    this.mimeType = mimeType;
    if (!('MediaSource' in window)) {
      throw new Error('MediaSource not supported in this browser.');
    }
    if (!MediaSource.isTypeSupported?.(mimeType)) {
      // IMPORTANT: WebM/Opus is not supported on iOS Safari.
      // Consider switching to AAC or PCM via Web Audio if this trips.
      throw new Error(`MIME type not supported here: ${mimeType}`);
    }

    this.mediaSource = new MediaSource();
    this.sourceOpenPromise = new Promise<void>((res) => (this.sourceOpenResolve = res));

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.mediaSource) return;
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
      } catch (e) {
        console.error('addSourceBuffer failed', e);
        return;
      }
      this.sourceBuffer.addEventListener('updateend', () => this.flush());
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

  private async flush() {
    if (this.destroyed) return;
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
      await this.sourceOpenPromise;
    }
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    if (!this.queue.length) {
      // try to (re)start playback once there is enough buffered data
      this.maybeStartPlayback();
      return;
    }

    // Guard: if audio element errored, rebuild cleanly
    if (this.attachingEl?.error) {
      console.warn('Audio element errored; rebuilding pipeline.');
      await this.rebuild();
      return;
    }

    try {
      const chunk = this.queue.shift()!;
      this.sourceBuffer.appendBuffer(chunk);
    } catch (e) {
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
    // First play() must be gesture-triggered somewhere in your UI before this;
    // if not, this will reject silently on mobile.
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

  /** Clean, mobile-safe rebuild (use when element errors or MSE goes bad). */
  private async rebuild() {
    if (this.destroyed) return;
    // Detach old
    try {
      if (this.mediaSource?.readyState === 'open' && this.sourceBuffer && !this.sourceBuffer.updating) {
        // best-effort; ignore errors
        // Do NOT endOfStream for PTT mid-session; it can lock further appends on some mobiles
      }
    } catch {}
    if (this._sourceUrl) {
      try { URL.revokeObjectURL(this._sourceUrl); } catch {}
    }

    // Create a fresh pipeline
    this.mediaSource = new MediaSource();
    this.sourceOpenPromise = new Promise<void>((res) => (this.sourceOpenResolve = res));
    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource!.addSourceBuffer(this.mimeType);
      } catch (e) {
        console.error('addSourceBuffer failed after rebuild', e);
        return;
      }
      this.sourceBuffer.addEventListener('updateend', () => this.flush());
      this.sourceOpenResolve();
      this.flush();
    });

    // Reattach to the same element without calling load()
    if (this.attachingEl) {
      this._sourceUrl = URL.createObjectURL(this.mediaSource);
      this.attachingEl.src = this._sourceUrl;
      this.startedPlayback = false; // we’ll restart once prebuffered
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
