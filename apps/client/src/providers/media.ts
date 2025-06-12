export class MediaProvider {
  private readonly mediaSource: MediaSource;
  private readonly mimeType: string;
  private _sourceBuffer!: SourceBuffer;
  private _sourceUrl: string | undefined;

  constructor(mimeType: string) {
    this.mediaSource = new MediaSource();
    this.mediaSource.onsourceopen = () => {
      this._sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    };
    this.mimeType = mimeType;
  }

  public dispose() {
    if (this._sourceUrl) {
      URL.revokeObjectURL(this._sourceUrl);
    }
  }

  public async buffer(data: ArrayBuffer) {
    await this.ready;
    this._sourceBuffer.appendBuffer(data);
    await this.ready;
  }

  public async reinitialize() {
    const endTime = this._sourceBuffer.buffered.end(0);
    // Remove all buffered data
    if (endTime > 0) {
      this._sourceBuffer.remove(0, endTime);
      await this.ready;
    }
    // Reinitialize to expect incoming header
    this._sourceBuffer.changeType(this.mimeType);
    await this.ready;
  }

  public get ready(): Promise<void> {
    return new Promise((resolve) => {
      const checkReady = () => {
        if (!this._sourceBuffer.updating) {
          resolve();
        } else {
          setTimeout(checkReady, 50);
        }
      };
      checkReady();
    });
  }

  public get sourceUrl(): string {
    if (!this._sourceUrl) {
      this._sourceUrl = URL.createObjectURL(this.mediaSource);
    }
    return this._sourceUrl;
  }

  public get sourceBuffer(): SourceBuffer {
    return this._sourceBuffer;
  }
}
