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
  return undefined;
}

export class MediaProvider {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private _sourceUrl: string | null = null;
  private mimeType?: string;
  private queue: AppendItem[] = [];
  private attachingEl: HTMLMediaElement | null = null;
  private sourceOpenResolve!: () => void;
  private sourceOpenPromise: Promise<void>;
  private startedPlayback = false;
  private destroyed = false;
  private rebuilding = false;

  private PREBUFFER_SEC = 0.2;
  private KEEP_TAIL_SEC = 2.0;
  private pendingRetry = false;
  private MAX_LIVE_LATENCY_SEC = 4.0;
  private TARGET_LIVE_LATENCY_SEC = 1.0;

  constructor(mimeType?: string) {
    this.mimeType = mimeType;
    if (!('MediaSource' in window)) {
      throw new Error('MediaSource not supported in this browser.');
    }

    const MS = (window as any).MediaSource;
    if (this.mimeType && typeof MS.isTypeSupported === 'function' && !MS.isTypeSupported(this.mimeType)) {
      this.mimeType = pickPlaybackMime();
    }
    if (!this.mimeType) {
      this.mimeType = pickPlaybackMime();
    }

    this.sourceOpenPromise = new Promise<void>((res) => (this.sourceOpenResolve = res));
    this.initMediaSource();
  }

  private initMediaSource() {
    this.mediaSource = new MediaSource();
    this.sourceBuffer = null;
    this.sourceOpenPromise = new Promise<void>((res) => (this.sourceOpenResolve = res));

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.mediaSource) return;
      try {
        this.sourceBuffer = this.mimeType
          ? this.mediaSource.addSourceBuffer(this.mimeType)
          : this.mediaSource.addSourceBuffer('audio/mp4');
      } catch (e) {
        try {
          const alt = this.mimeType?.includes('mp4') ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"';
          this.sourceBuffer = this.mediaSource.addSourceBuffer(alt);
          this.mimeType = alt;
        } catch (e2) {
          console.error('[MediaProvider] addSourceBuffer failed', e2);
          return;
        }
      }
      this.sourceBuffer.addEventListener('updateend', () => this.flush());
      this.sourceOpenResolve();
      this.flush();
    });
  }

  public attach(audioEl: HTMLMediaElement) {
    if (this._sourceUrl) return;
    if (!this.mediaSource) throw new Error('No MediaSource');
    this.attachingEl = audioEl;
    this._sourceUrl = URL.createObjectURL(this.mediaSource);
    audioEl.src = this._sourceUrl;
    (audioEl as any).playsInline = true;

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && audioEl.paused && !audioEl.error) {
        audioEl.play().catch(() => {});
      }
    });
  }

  public async buffer(data: ArrayBuffer) {
    if (this.destroyed) return;
    this.queue.push(data);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.destroyed || this.rebuilding) return;

    // Wait for MediaSource to be ready
    if (!this.sourceBuffer || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      await this.sourceOpenPromise;
    }
    // Re-check after await — rebuild may have happened
    if (this.destroyed || this.rebuilding || !this.sourceBuffer) return;
    if (this.sourceBuffer.updating) return;

    if (!this.queue.length) {
      this.maybeStartPlayback();
      this.seekToLiveEdgeIfNeeded();
      return;
    }

    if (this.attachingEl?.error || this.mediaSource?.readyState === 'ended') {
      await this.rebuild();
      return;
    }

    try {
      const chunk = this.queue.shift()!;
      this.sourceBuffer.appendBuffer(chunk);
      this.pendingRetry = false;
    } catch (e: any) {
      if (e && (e.name === 'QuotaExceededError' || e.name === 'QuotaExceeded')) {
        if (!this.pendingRetry) {
          this.pendingRetry = true;
          await this.evictOld();
          return this.flush();
        }
      }
      console.error('[MediaProvider] appendBuffer failed, rebuilding', e);
      await this.rebuild();
    }
  }

  private seekToLiveEdgeIfNeeded() {
    if (!this.attachingEl || !this.startedPlayback) return;
    const bufEnd = this.bufferedEnd();
    if (bufEnd === null) return;
    const lag = bufEnd - this.attachingEl.currentTime;
    if (lag > this.MAX_LIVE_LATENCY_SEC) {
      this.attachingEl.currentTime = bufEnd - this.TARGET_LIVE_LATENCY_SEC;
    }
  }

  private maybeStartPlayback() {
    if (!this.attachingEl || this.startedPlayback) return;
    const a = this.attachingEl;
    const bufEnd = this.bufferedEnd();
    if (bufEnd === null) return;
    const bufferedAhead = bufEnd - (a.currentTime || 0);
    if (bufferedAhead < this.PREBUFFER_SEC) return;

    this.startedPlayback = true;
    a.play().catch(() => {
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
          this.sourceBuffer?.removeEventListener('updateend', done);
          res();
        };
        this.sourceBuffer?.addEventListener('updateend', done, { once: true });
      });
    } catch {}
  }

  /** Tear down the current MSE pipeline and build a fresh one.
   *  Safe to call at any time — blocks concurrent flushes via `rebuilding` flag
   *  and never revokes blob URLs (prevents ERR_FILE_NOT_FOUND). */
  private async rebuild() {
    if (this.destroyed || this.rebuilding) return;
    this.rebuilding = true;

    // Invalidate old sourceBuffer immediately so no stale reference is used
    this.sourceBuffer = null;

    // Don't revoke the old blob URL — the browser may still be loading it.
    // GC will collect it once the element's src is overwritten below.

    this.initMediaSource();

    if (this.attachingEl && this.mediaSource) {
      this._sourceUrl = URL.createObjectURL(this.mediaSource);
      this.attachingEl.src = this._sourceUrl;
      (this.attachingEl as any).playsInline = true;
      this.startedPlayback = false;
      this.pendingRetry = false;
    }

    // Wait for the new pipeline to be ready before unblocking flushes
    await this.sourceOpenPromise;
    this.rebuilding = false;
    // Kick flush for any data that queued during rebuild
    this.flush();
  }

  public dispose() {
    this.destroyed = true;
    if (this._sourceUrl) {
      try { URL.revokeObjectURL(this._sourceUrl); } catch {}
    }
    this.queue = [];
    this.attachingEl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
  }

  public async reinitialize() {
    this.queue = [];
    await this.rebuild();
  }
}
