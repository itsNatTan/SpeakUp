import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

type BufferSlot = { start: Date | null; data: ArrayBuffer[] };

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, BufferSlot>;

  // Set only after first audio arrives (still used for legacy flows)
  private lastSenderKey: string | undefined = undefined;

  // NEW: explicit CTS owner for gating audio even if queue priority is lagging
  private currentCtsKey: string | undefined = undefined;

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
    return key.slice(0, key.length - 6); // "<name>-abcde" -> "<name>"
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

    // Reset buffer
    this.storageBuffer[clientKey] = { start: null, data: [] };
    return { filename, data };
  }

  // ---- Centralized CTS grant: ensure head-of-queue, reset listener, announce, mark CTS owner, then CTS ----
  private grantCTS = (client: WebSocket) => {
    if (!this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    const key = this.whichClient(client);
    if (!key) return;

    // Ensure this socket is truly at the head for consistency (avoid races)
    if (!this.sendQueue.hasPriority(client)) {
      // Reorder: remove and put at the very front
      this.sendQueue.removeClient(client);
      this.sendQueue.prependClient(client);
    }

    this.ensureBufferKey(key);
    this.storageBuffer[key].start = new Date();

    // Reset listener pipeline, then announce, then grant CTS
    try { this.listener.send('CLEAR'); } catch {}
    const name = this.getClientName(client);
    try { this.listener.send(`FROM${name}`); } catch {}

    // Mark CTS owner *before* client starts sending so handleAudio lets them through
    this.currentCtsKey = key;

    try { client.send('CTS'); } catch {}
    // NOTE: lastSenderKey will be set on first audio packet; currentCtsKey is immediate.
  };

  // --------------------------- Handlers ---------------------------------

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);

    const key = this.whichClient(ws)!;
    this.ensureBufferKey(key);

    // Clean up on socket close so re-joins work and no stale CTS owner lingers
    ws.on('close', () => {
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
    });

    const isFirstInQueue = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;

    // Empty-queue -> first joiner path
    if (isFirstInQueue && hasListener) {
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
      // Consider them the active one for teardown
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
    // Swap listener (only closing previous listener is safe)
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

    // If someone is queued, grant CTS immediately (handles empty-queue → first joiner)
    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      this.grantCTS(nextClient);
      return;
    }

    // Best-effort UI hint if someone had been speaking earlier
    if (this.lastSenderKey) {
      const clientName = this.lastSenderKey.slice(0, this.lastSenderKey.length - 6);
      try { ws.send(`FROM${clientName}`); } catch {}
    }
  };

  private handleAudio = (ws: WebSocket, data: RawData) => {
    const senderKey = this.whichClient(ws)!;

    // ACCEPT audio if either:
    // 1) this ws currently holds CTS (explicit), OR
    // 2) queue says it has priority (legacy/normal path).
    const allowed =
      (this.currentCtsKey && senderKey === this.currentCtsKey) ||
      this.sendQueue.hasPriority(ws);

    if (!allowed) return;

    // First packet from this speaker—refresh UI marker and legacy key
    if (senderKey !== this.lastSenderKey) {
      const name = this.getClientName(ws);
      try { this.listener?.send(`FROM${name}`); } catch {}
      this.lastSenderKey = senderKey;
    }

    this.ensureBufferKey(senderKey);
    this.storageBuffer[senderKey].data.push(data as ArrayBuffer);
    try { this.listener?.send(data); } catch {}
  };

  // Instructor skip
  private handleSkip = (ws: WebSocket) => {
    if (this.listener !== ws || !this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    try { this.listener.send('CLEAR'); } catch {}

    // Resolve active: CTS owner preferred, else head with priority, else lastSender
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
}
