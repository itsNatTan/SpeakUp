import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

type BufferSlot = { start: Date | null; data: ArrayBuffer[] };

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, BufferSlot>;

  // last client that actually sent audio (set on first audio packet)
  private lastSenderKey: string | undefined = undefined;
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

  // ---------- Centralized CTS grant (no timers, no server STOP) ----------
  private grantCTS = (client: WebSocket) => {
    if (!this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    const key = this.whichClient(client);
    if (!key) return;

    this.ensureBufferKey(key);
    this.storageBuffer[key].start = new Date();

    // Announce immediately so instructor UI can act (skip/dequeue)
    const name = this.getClientName(client);
    try { this.listener.send(`FROM${name}`); } catch {}

    // Give CTS
    try { client.send('CTS'); } catch {}

    // IMPORTANT: do NOT set lastSenderKey here.
    // We set it only when the first audio packet arrives (handleAudio),
    // so a sluggish client doesn't get treated as an "active sender".
  };

  // --------------------------- Handlers ---------------------------------

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);

    const key = this.whichClient(ws)!;
    this.ensureBufferKey(key);

    // Clean up references on socket close (allows clean re-joins)
    ws.on('close', () => {
      const k = this.whichClient(ws);
      if (!k) return;

      const hadPriority = this.sendQueue.hasPriority(ws);
      this.sendQueue.removeClient(ws); // remove if present

      if (hadPriority || this.lastSenderKey === k) {
        this.lastSenderKey = undefined;
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

    // FIX: when instructor is already listening and queue was empty,
    // announce + grant CTS immediately to the first joiner.
    if (isFirstInQueue && hasListener) {
      this.grantCTS(ws);
    }
  };

  public handleSTOP = (ws: WebSocket) => {
    // Listener sent STOP (or listener socket is the one here)
    if (this.listener === ws) {
      try { this.listener.send('CLEAR'); } catch {}
      this.listener = null;

      if (this.lastSenderKey) {
        const senderWs = this.clientKeyMap[this.lastSenderKey];
        if (senderWs) {
          this.sendQueue.removeClient(senderWs);
          try { senderWs.send('STOP'); } catch {}
        }
        this.lastSenderKey = undefined;
      }
      return;
    }

    // Student sent STOP
    const hasPriority = this.sendQueue.hasPriority(ws);
    const senderKey = this.whichClient(ws);
    if (hasPriority && senderKey) {
      this.lastSenderKey = undefined;

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
    // Replace the previous listener if any (safe to close listener only)
    try { this.listener?.close(); } catch {}
    this.listener = ws;

    ws.on('close', () => {
      if (this.listener === ws) {
        this.listener = null;

        if (this.lastSenderKey) {
          const senderWs = this.clientKeyMap[this.lastSenderKey];
          if (senderWs) {
            this.sendQueue.prependClient(senderWs);
            try { senderWs.send('STOP'); } catch {}
          }
          this.lastSenderKey = undefined;
        }
      }
    });

    // If a speaker is already at head, grant CTS now (announce immediately)
    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      this.grantCTS(nextClient);
      return;
    }

    // If someone had been speaking earlier, best-effort inform UI
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
      // First packet from this speaker—announce and mark as active
      const name = this.getClientName(ws);
      try { this.listener?.send(`FROM${name}`); } catch {}
      this.lastSenderKey = senderKey;
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
