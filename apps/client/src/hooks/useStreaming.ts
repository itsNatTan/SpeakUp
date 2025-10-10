import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

type BufferSlot = { start: Date | null; data: ArrayBuffer[] };

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, BufferSlot>;

  private lastSenderKey: string | undefined = undefined; // last client that actually sent audio
  private bufferKey: string | null = null;

  // CTS watchdogs—auto-advance if no first packet within the window (soft, no close)
  private ctsTimers: Record<string, NodeJS.Timeout> = {};
  private readonly CTS_TIMEOUT_MS = 12000; // gentler: 12s to account for slow mic/UI

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
    // key format: "<name>-abcde" => strip "-abcde" (6 chars)
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

    // Reset buffer
    this.storageBuffer[clientKey] = { start: null, data: [] };
    return { filename, data };
  }

  // ---- CTS helpers ----------------------------------------------------------

  private grantCTS = (client: WebSocket) => {
    if (!this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    const key = this.whichClient(client);
    if (!key) return;

    this.ensureBufferKey(key);
    this.storageBuffer[key].start = new Date();

    // Announce immediately so the instructor UI enables skip/dequeue
    const name = this.getClientName(client);
    try { this.listener.send(`FROM${name}`); } catch {}

    // Give CTS to the student
    try { client.send('CTS'); } catch {}

    // Provisional “current” until first audio arrives
    this.lastSenderKey = key;

    // Start CTS watchdog—soft advance if no first audio packet arrives
    this.armCtsTimer(key, client);
  };

  private clearCtsTimer(key: string) {
    const t = this.ctsTimers[key];
    if (t) {
      clearTimeout(t);
      delete this.ctsTimers[key];
    }
  }

  private armCtsTimer(key: string, client: WebSocket) {
    this.clearCtsTimer(key);
    this.ctsTimers[key] = setTimeout(() => {
      // No first packet in time: soft-stop and advance (do not close socket)
      try { client.send('STOP'); } catch {}
      const next = this.sendQueue.removeClient(client);
      this.lastSenderKey = undefined;
      try { this.listener?.send('CLEAR'); } catch {}

      if (next && this.listener && this.listener.readyState === WebSocket.OPEN) {
        this.grantCTS(next);
      }
    }, this.CTS_TIMEOUT_MS);
  }

  // ---- Handlers -------------------------------------------------------------

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);

    const key = this.whichClient(ws)!;
    this.ensureBufferKey(key);

    // Clean up when this student socket closes (avoid stale refs blocking rejoin)
    ws.on('close', () => {
      const k = this.whichClient(ws);
      if (!k) return;
      this.clearCtsTimer(k);

      const hadPriority = this.sendQueue.hasPriority(ws);
      // Remove from queue if still present
      this.sendQueue.removeClient(ws);

      // If they were the active sender, clear state & let next proceed
      if (hadPriority || this.lastSenderKey === k) {
        this.lastSenderKey = undefined;
        try { this.listener?.send('CLEAR'); } catch {}

        const next = this.sendQueue.peekClient?.();
        if (next && this.sendQueue.hasPriority(next) && this.listener && this.listener.readyState === WebSocket.OPEN) {
          this.grantCTS(next);
        }
      }

      // Finally, drop server references so they can reconnect freely
      delete this.clientKeyMap[k];
      delete this.storageBuffer[k];
    });

    const isFirstInQueue = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;

    if (isFirstInQueue && hasListener) {
      // FIX: announce FROM + grant CTS immediately when listener is already ready
      this.grantCTS(ws);
    }
  };

  public handleSTOP = (ws: WebSocket) => {
    // If the listener disconnected or explicitly sent STOP
    if (this.listener === ws) {
      try { this.listener.send('CLEAR'); } catch {}
      this.listener = null;

      if (this.lastSenderKey) {
        const senderWs = this.clientKeyMap[this.lastSenderKey];
        if (senderWs) {
          this.clearCtsTimer(this.lastSenderKey);
          this.sendQueue.removeClient(senderWs);
          try { senderWs.send('STOP'); } catch {}
        }
        this.lastSenderKey = undefined;
      }
      return;
    }

    // If a student is stopping
    const hasPriority = this.sendQueue.hasPriority(ws);
    const senderKey = this.whichClient(ws);
    if (hasPriority && senderKey) {
      this.lastSenderKey = undefined;
      this.clearCtsTimer(senderKey);

      const file = this.flushBuffer(ws);
      if (file) {
        this.onIncomingFile?.(file.filename, file.data);
      }

      try { this.listener?.send('CLEAR'); } catch {}
    }

    const nextClient = this.sendQueue.removeClient(ws);
    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      this.grantCTS(nextClient);
    }
  };

  private handleLISTEN = (ws: WebSocket) => {
    // Replace the previous listener if any
    try { this.listener?.close(); } catch {}
    this.listener = ws;

    ws.on('close', () => {
      if (this.listener === ws) {
        this.listener = null;

        if (this.lastSenderKey) {
          const senderWs = this.clientKeyMap[this.lastSenderKey];
          if (senderWs) {
            // Put current speaker back to the front if instructor vanishes mid-speech
            this.sendQueue.prependClient(senderWs);
            try { senderWs.send('STOP'); } catch {}
          }
          this.clearCtsTimer(this.lastSenderKey);
          this.lastSenderKey = undefined;
        }
      }
    });

    // If there is already a head-of-queue with priority, grant CTS right away
    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      this.grantCTS(nextClient); // announce FROM immediately on LISTEN path
      return;
    }

    // If someone had already started sending (rare), tell UI who it was
    const currentSenderKey = this.lastSenderKey;
    if (currentSenderKey) {
      const clientName = currentSenderKey.slice(0, currentSenderKey.length - 6);
      try { ws.send(`FROM${clientName}`); } catch {}
    }
  };

  private handleAudio = (ws: WebSocket, data: RawData) => {
    // Only forward audio if this client currently has priority
    if (!this.sendQueue.hasPriority(ws)) return;

    const senderKey = this.whichClient(ws)!;

    if (senderKey !== this.lastSenderKey) {
      // First packet from this speaker—announce and cancel CTS watchdog
      const name = this.getClientName(ws);
      try { this.listener?.send(`FROM${name}`); } catch {}
      this.lastSenderKey = senderKey;
      this.clearCtsTimer(senderKey);
    }

    // Store + forward
    this.ensureBufferKey(senderKey);
    this.storageBuffer[senderKey].data.push(data as ArrayBuffer);
    try { this.listener?.send(data); } catch {}
  };

  // Instructor-only skip of the current speaker (no deafen/undeafen toggle)
  private handleSkip = (ws: WebSocket) => {
    // Only allow the current instructor to skip
    if (this.listener !== ws || !this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    // Clear listener playback immediately
    try { this.listener.send('CLEAR'); } catch {}

    // Determine active student:
    // Prefer head-of-queue with priority (current CTS owner), fallback to lastSenderKey.
    let activeStudentWs: WebSocket | undefined;
    const head = this.sendQueue.peekClient?.();
    if (head && this.sendQueue.hasPriority(head)) {
      activeStudentWs = head;
    } else if (this.lastSenderKey) {
      activeStudentWs = this.clientKeyMap[this.lastSenderKey];
    }

    let nextClient: WebSocket | undefined;

    if (activeStudentWs) {
      const activeKey = this.whichClient(activeStudentWs);
      if (activeKey) this.clearCtsTimer(activeKey);

      // Persist any captured audio for the skipped student
      const file = this.flushBuffer(activeStudentWs);
      if (file) {
        try { this.onIncomingFile?.(file.filename, file.data); } catch {}
      }

      // Soft-stop only; do NOT close their socket
      if (activeStudentWs.readyState === WebSocket.OPEN) {
        try { activeStudentWs.send('STOP'); } catch {}
      }

      // Remove the skipped student from the queue; advance
      nextClient = this.sendQueue.removeClient(activeStudentWs);
      this.lastSenderKey = undefined;
    } else {
      // No obvious active; still try to advance
      if (head) nextClient = this.sendQueue.removeClient(head);
      this.lastSenderKey = undefined;
    }

    // Grant CTS to next (announce FROM immediately)
    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      this.grantCTS(nextClient);
    }
  };
}
