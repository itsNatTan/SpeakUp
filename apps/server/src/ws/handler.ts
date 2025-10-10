import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, { start: Date | null; data: ArrayBuffer[] }>;

  private lastSenderKey: string | undefined = undefined; // key of last client that actually sent audio
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
        return this.handleSkip; // now implemented
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

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);
    this.ensureBufferKey(this.whichClient(ws)!);

    const isFirstInQueue = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;

    if (isFirstInQueue && hasListener) {
      const key = this.whichClient(ws)!;
      this.storageBuffer[key].start = new Date();
      ws.send('CTS');
    }
  };

  public handleSTOP = (ws: WebSocket) => {
    // If the listener disconnected or explicitly sent STOP
    if (this.listener === ws) {
      this.listener?.send('CLEAR');
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

    // If a student is stopping
    const hasPriority = this.sendQueue.hasPriority(ws);
    if (hasPriority) {
      this.lastSenderKey = undefined;

      const file = this.flushBuffer(ws);
      if (file) {
        this.onIncomingFile?.(file.filename, file.data);
      }

      this.listener?.send('CLEAR');
    }

    const nextClient = this.sendQueue.removeClient(ws);
    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      const key = this.whichClient(nextClient);
      if (key) {
        this.ensureBufferKey(key);
        this.storageBuffer[key].start = new Date();
        try { nextClient.send('CTS'); } catch {}
      }
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
          this.lastSenderKey = undefined;
        }
      }
    });

    // Inform who is currently speaking (best-effort)
    const currentSenderKey = this.lastSenderKey;
    if (currentSenderKey) {
      const clientName = currentSenderKey.slice(0, currentSenderKey.length - 6);
      try { ws.send(`FROM${clientName}`); } catch {}
    }

    // If there is a head-of-queue and we have priority, grant CTS
    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      const key = this.whichClient(nextClient);
      if (key) {
        this.ensureBufferKey(key);
        this.storageBuffer[key].start = new Date();
        try { nextClient.send('CTS'); } catch {}
      }
    }
  };

  private handleAudio = (ws: WebSocket, data: RawData) => {
    // Only forward audio if this client currently has priority
    if (!this.sendQueue.hasPriority(ws)) return;

    const senderKey = this.whichClient(ws)!;

    if (senderKey !== this.lastSenderKey) {
      // Announce new speaker to the listener on first packet
      try { this.listener?.send(`FROM${this.getClientName(ws)}`); } catch {}
      this.lastSenderKey = senderKey;
    }

    // Store + forward
    this.ensureBufferKey(senderKey);
    this.storageBuffer[senderKey].data.push(data as ArrayBuffer);
    try { this.listener?.send(data); } catch {}
  };

  // NEW: Instructor-only skip of the current speaker (no deafen/undeafen toggle)
  private handleSkip = (ws: WebSocket) => {
    // Only allow the current instructor to skip
    if (this.listener !== ws || !this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    // Tell the instructor client to clear playback immediately
    try { this.listener.send('CLEAR'); } catch {}

    // Determine the active student robustly:
    // 1) Prefer the head-of-queue *with priority* (this is the current CTS owner)
    // 2) Fallback to the last sender (already producing audio)
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

      // Order the student to stop (use existing STOP path on the client)
      if (activeStudentWs.readyState === WebSocket.OPEN) {
        try { activeStudentWs.send('STOP'); } catch {}
      }

      // Remove the skipped student from the queue; get the next one
      nextClient = this.sendQueue.removeClient(activeStudentWs);

      // Reset bookkeeping so the next speaker announcement works as usual
      this.lastSenderKey = undefined;
    } else {
      // No obvious active student; still try to move the queue forward
      if (head) {
        nextClient = this.sendQueue.removeClient(head);
      }
      this.lastSenderKey = undefined;
    }

    // Advance to the next student (if any) and grant CTS
    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      const key = this.whichClient(nextClient);
      if (key) {
        this.ensureBufferKey(key);
        this.storageBuffer[key].start = new Date();
        try { nextClient.send('CTS'); } catch {}
        // We deliberately do NOT set lastSenderKey here;
        // handleAudio will announce FROM<name> on the first audio packet.
      }
    }
  };
}
