import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

type BufferSlot = { start: Date | null; data: ArrayBuffer[] };

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, BufferSlot>;

  private lastSenderKey: string | undefined = undefined;   // UI/legacy
  private currentCtsKey: string | undefined = undefined;    // authoritative CTS owner
  private bufferKey: string | null = null;

  constructor(
    private readonly roomCode: string,
    private readonly onIncomingFile?: (filename: string, data: Buffer) => void,
  ) {
    this.sendQueue = new SendQueue();
    this.listener = null;
    this.clientKeyMap = {};
    this.storageBuffer = {};
  }

  public getMessageHandler(data: RawData) {
    const message = data.toString();
    if (message.startsWith('RTS')) {
      const key = `${message.slice(3)}-${random.generateLowercase(5)}`;
      this.bufferKey = key;
      return this.handleRTS;
    }
    switch (message) {
      case 'STOP':
        return this.handleSTOP;
      case 'LISTEN':
        return this.handleLISTEN;
      case 'SKIP':
        return this.handleSkip;
      default:
        return this.handleAudio;
    }
  }

  private trackClient(ws: WebSocket, key: string) {
    this.clientKeyMap[key] = ws;
  }
  private whichClient(ws: WebSocket) {
    return Object.entries(this.clientKeyMap).find(([, client]) => client === ws)?.[0];
  }
  private getClientName(ws: WebSocket) {
    const key = this.whichClient(ws);
    if (!key) return;
    return key.slice(0, key.length - 6);
  }
  private ensureBufferKey(key: string) {
    if (!this.storageBuffer[key]) this.storageBuffer[key] = { start: null, data: [] };
  }
  private flushBuffer(client: WebSocket) {
    const clientKey = this.whichClient(client);
    if (!clientKey) return;
    const buffer = this.storageBuffer[clientKey];
    if (!buffer?.start) return;

    const filename = `${buffer.start.getTime()}-${clientKey}.wav`;
    const data = Buffer.concat((buffer.data || []).map((d) => Buffer.from(d)));
    this.storageBuffer[clientKey] = { start: null, data: [] };
    return { filename, data };
  }

  // Grant CTS and prep listener (CLEAR→FROM→CTS). Also mark CTS owner.
  private grantCTS = (client: WebSocket) => {
    if (!this.listener || this.listener.readyState !== WebSocket.OPEN) return;
    const key = this.whichClient(client);
    if (!key) return;

    // align queue head with this client (avoid race with hasPriority)
    if (!this.sendQueue.hasPriority(client)) {
      this.sendQueue.removeClient(client);
      this.sendQueue.prependClient(client);
    }

    this.ensureBufferKey(key);
    this.storageBuffer[key].start = new Date();

    // Mark active before CTS to accept early frames
    this.currentCtsKey = key;
    this.lastSenderKey = key;

    try { this.listener.send('CLEAR'); } catch {}
    const name = this.getClientName(client);
    try { this.listener.send(`FROM${name}`); } catch {}
    try { client.send('CTS'); } catch {}
  };

  // --------------------------- Handlers ---------------------------------

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);

    // Assign key for this client (with provided name)
    this.trackClient(ws, this.bufferKey!);

    const key = this.whichClient(ws)!;
    this.ensureBufferKey(key);

    // Cleanup on close
    ws.on('close', () => this.cleanupOnClose(ws));

    const isFirst = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;
    if (isFirst && hasListener) {
      this.grantCTS(ws);
    }
  };

  public handleSTOP = (ws: WebSocket) => {
    // Listener STOP / deafen
    if (this.listener === ws) {
      try { this.listener.send('CLEAR'); } catch {}
      this.listener = null;

      if (this.currentCtsKey) {
        const senderWs = this.clientKeyMap[this.currentCtsKey];
        if (senderWs) {
          this.sendQueue.removeClient(senderWs);
          try { senderWs.send('STOP'); } catch {}
        }
      }
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
      return;
    }

    // Student STOP
    const hasPriority = this.sendQueue.hasPriority(ws);
    const senderKey = this.whichClient(ws);

    if (senderKey && (hasPriority || senderKey === this.currentCtsKey)) {
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;

      const file = this.flushBuffer(ws);
      if (file) this.onIncomingFile?.(file.filename, file.data);

      try { this.listener?.send('CLEAR'); } catch {}
    }

    const nextClient = this.sendQueue.removeClient(ws);
    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      this.grantCTS(nextClient);
    }
  };

  private handleLISTEN = (ws: WebSocket) => {
    try { this.listener?.close(); } catch {}
    this.listener = ws;

    ws.on('close', () => {
      if (this.listener === ws) {
        this.listener = null;
        if (this.currentCtsKey) {
          const senderWs = this.clientKeyMap[this.currentCtsKey];
          if (senderWs) {
            this.sendQueue.prependClient(senderWs);
            try { senderWs.send('STOP'); } catch {}
          }
        }
        this.lastSenderKey = undefined;
        this.currentCtsKey = undefined;
      }
    });

    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      this.grantCTS(nextClient);
      return;
    }

    if (this.lastSenderKey) {
      const clientName = this.lastSenderKey.slice(0, this.lastSenderKey.length - 6);
      try { ws.send(`FROM${clientName}`); } catch {}
    }
  };

  // >>>>>> AUTO-REGISTER ON FIRST AUDIO <<<<<<
  private handleAudio = (ws: WebSocket, data: RawData) => {
    let senderKey = this.whichClient(ws);

    // If this socket never called RTS, register it now.
    if (!senderKey) {
      // Give it a temporary key (anonymous) to keep pipeline flowing
      const anonKey = `Anon-${random.generateLowercase(5)}`;
      this.trackClient(ws, anonKey);
      this.ensureBufferKey(anonKey);

      // If nobody is queued and a listener exists, make this socket the head and grant CTS.
      if (!this.sendQueue.contains(ws)) this.sendQueue.registerClient(ws);
      if (this.listener && this.listener.readyState === WebSocket.OPEN) {
        if (this.sendQueue.peekClient() === ws || this.sendQueue.size() === 1) {
          this.grantCTS(ws); // sets currentCtsKey/lastSenderKey, CLEAR→FROM→CTS
        } else {
          // Not head yet → move it to head to match CTS owner
          this.sendQueue.prependClient(ws);
          this.grantCTS(ws);
        }
      }

      senderKey = this.whichClient(ws);
    }

    // Gate: accept if CTS owner OR queue head OR last announced speaker
    const allowed =
      (this.currentCtsKey && senderKey === this.currentCtsKey) ||
      this.sendQueue.hasPriority(ws) ||
      (this.lastSenderKey && senderKey === this.lastSenderKey);

    // Debug (keep while testing)
    // console.log('[AUDIO]', 'sender=', senderKey, 'allowed=', allowed, 'cts=', this.currentCtsKey, 'isHead=', this.sendQueue.hasPriority(ws), 'last=', this.lastSenderKey);

    if (!allowed) return;

    // First packet refresh (harmless duplicate)
    if (senderKey !== this.lastSenderKey) {
      const name = this.getClientName(ws) || 'Speaker';
      try { this.listener?.send(`FROM${name}`); } catch {}
      this.lastSenderKey = senderKey!;
    }

    this.storageBuffer[senderKey!].data.push(data as ArrayBuffer);
    try { this.listener?.send(data); } catch {}
  };

  private handleSkip = (ws: WebSocket) => {
    if (this.listener !== ws || !this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    try { this.listener.send('CLEAR'); } catch {}

    let activeStudentWs: WebSocket | undefined;
    if (this.currentCtsKey) {
      activeStudentWs = this.clientKeyMap[this.currentCtsKey];
    } else {
      const head = this.sendQueue.peekClient?.();
      if (head && this.sendQueue.hasPriority(head)) activeStudentWs = head;
      else if (this.lastSenderKey) activeStudentWs = this.clientKeyMap[this.lastSenderKey];
    }

    let nextClient: WebSocket | undefined;

    if (activeStudentWs) {
      const file = this.flushBuffer(activeStudentWs);
      if (file) {
        try { this.onIncomingFile?.(file.filename, file.data); } catch {}
      }
      if (activeStudentWs.readyState === WebSocket.OPEN) {
        try { activeStudentWs.send('STOP'); } catch {}
      }
      nextClient = this.sendQueue.removeClient(activeStudentWs);
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
    } else {
      const head = this.sendQueue.peekClient?.();
      if (head) nextClient = this.sendQueue.removeClient(head);
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
    }

    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      this.grantCTS(nextClient);
    }
  };

  // Cleanup helper used by RTS close handler
  private cleanupOnClose = (ws: WebSocket) => {
    const k = this.whichClient(ws);
    if (!k) return;

    const wasPriority = this.sendQueue.hasPriority(ws);
    this.sendQueue.removeClient(ws);

    if (wasPriority || this.lastSenderKey === k || this.currentCtsKey === k) {
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
      try { this.listener?.send('CLEAR'); } catch {}

      const next = this.sendQueue.peekClient?.();
      if (next && this.sendQueue.hasPriority(next) && this.listener && this.listener.readyState === WebSocket.OPEN) {
        this.grantCTS(next);
      }
    }

    delete this.clientKeyMap[k];
    delete this.storageBuffer[k];
  };
}
