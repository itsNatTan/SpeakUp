import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

type BufferSlot = { start: Date | null; data: ArrayBuffer[] };

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, BufferSlot>;

  // Active speaker tracking
  private lastSenderKey: string | undefined = undefined;
  private currentCtsKey: string | undefined = undefined;

  private bufferKey: string | null = null;

  // NEW: listener’s preferred playback container/codec (from “FORMAT …”)
  private preferredPlaybackMime: string | undefined;

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

    // Check if it's a JSON WebRTC signaling message
    if (message.startsWith('{')) {
      try {
        const signal = JSON.parse(message);
        if (signal.type) {
          return this.handleWebRTCSignaling.bind(this, signal);
        }
      } catch {
        // Not valid JSON, continue with normal handling
      }
    }

    // Listener declares what MSE container it wants to PLAY
    if (message.startsWith('FORMAT ')) {
      const fmt = message.slice('FORMAT '.length).trim();
      this.preferredPlaybackMime = fmt;
      return () => {}; // no-op handler
    }

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

  private trackClient(ws: WebSocket, key: string) { this.clientKeyMap[key] = ws; }
  private whichClient(ws: WebSocket) { return Object.entries(this.clientKeyMap).find(([, c]) => c === ws)?.[0]; }
  private getClientName(ws: WebSocket) { const k = this.whichClient(ws); return k ? k.slice(0, k.length - 6) : undefined; }
  private ensureBufferKey(key: string) { if (!this.storageBuffer[key]) this.storageBuffer[key] = { start: null, data: [] }; }

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

  // CENTRAL: CLEAR → FROM → (REC_MIME if any) → CTS
  private grantCTS = (client: WebSocket) => {
    if (!this.listener || this.listener.readyState !== WebSocket.OPEN) return;
    const key = this.whichClient(client);
    if (!key) return;

    if (!this.sendQueue.hasPriority(client)) {
      this.sendQueue.removeClient(client);
      this.sendQueue.prependClient(client);
    }

    this.ensureBufferKey(key);
    this.storageBuffer[key].start = new Date();

    // Mark active BEFORE CTS so early frames are accepted
    this.currentCtsKey = key;
    this.lastSenderKey = key;

    try { this.listener.send('CLEAR'); } catch {}
    const name = this.getClientName(client) || 'Speaker';
    try { this.listener.send(`FROM${name}`); } catch {}

    // NEW: tell the student which recorder mime to use
    if (this.preferredPlaybackMime) {
      try { client.send(`REC_MIME ${this.preferredPlaybackMime}`); } catch {}
    }

    try { client.send('CTS'); } catch {}
  };

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);
    const key = this.whichClient(ws)!;
    this.ensureBufferKey(key);

    ws.on('close', () => this.cleanupOnClose(ws));

    const isFirst = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;
    if (isFirst && hasListener) this.grantCTS(ws);
  };

  public handleSTOP = (ws: WebSocket) => {
    if (this.listener === ws) {
      try { 
        this.listener.send(JSON.stringify({ type: 'clear' }));
      } catch {}
      this.listener = null;

      if (this.currentCtsKey) {
        const senderWs = this.clientKeyMap[this.currentCtsKey];
        if (senderWs) {
          this.sendQueue.removeClient(senderWs);
          try { 
            senderWs.send(JSON.stringify({ type: 'stop' }));
          } catch {}
        }
      }
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
      return;
    }

    const hasPriority = this.sendQueue.hasPriority(ws);
    const senderKey = this.whichClient(ws);

    if (senderKey && (hasPriority || senderKey === this.currentCtsKey)) {
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;

      const file = this.flushBuffer(ws);
      if (file) this.onIncomingFile?.(file.filename, file.data);

      try { 
        this.listener?.send(JSON.stringify({ type: 'clear' }));
      } catch {}
    }

    const nextClient = this.sendQueue.removeClient(ws);
    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      this.grantCTSWebRTC(nextClient);
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
            try { 
              senderWs.send(JSON.stringify({ type: 'stop' }));
            } catch {}
          }
        }
        this.lastSenderKey = undefined;
        this.currentCtsKey = undefined;
      }
    });

    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      this.grantCTSWebRTC(nextClient);
      return;
    }

    if (this.lastSenderKey) {
      const clientName = this.lastSenderKey.slice(0, this.lastSenderKey.length - 6);
      try { 
        ws.send(JSON.stringify({ type: 'from', name: clientName }));
      } catch {}
    }
  };

  private handleAudio = (ws: WebSocket, data: RawData) => {
    const senderKey = this.whichClient(ws);
    if (!senderKey) { try { ws.send('NEED_RTS'); } catch {}; return; }

    const allowed =
      (this.currentCtsKey && senderKey === this.currentCtsKey) ||
      this.sendQueue.hasPriority(ws) ||
      (this.lastSenderKey && senderKey === this.lastSenderKey);

    if (!allowed) return;

    if (senderKey !== this.lastSenderKey) {
      const name = this.getClientName(ws) || 'Speaker';
      try { this.listener?.send(`FROM${name}`); } catch {}
      this.lastSenderKey = senderKey;
    }

    this.ensureBufferKey(senderKey);
    this.storageBuffer[senderKey].data.push(data as ArrayBuffer);
    try { this.listener?.send(data); } catch {}
  };

  private handleSkip = (ws: WebSocket) => {
    if (this.listener !== ws || !this.listener || this.listener.readyState !== WebSocket.OPEN) return;

    try { 
      this.listener.send(JSON.stringify({ type: 'clear' }));
    } catch {}

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
      if (file) { try { this.onIncomingFile?.(file.filename, file.data); } catch {} }
      if (activeStudentWs.readyState === WebSocket.OPEN) { 
        try { 
          activeStudentWs.send(JSON.stringify({ type: 'stop' }));
        } catch {} 
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
      this.grantCTSWebRTC(nextClient);
    }
  };

  private handleWebRTCSignaling = (signal: any, ws: WebSocket) => {
    // Handle WebRTC signaling messages
    if (signal.type === 'ready') {
      // Student wants to speak (WebRTC version of RTS)
      const senderKey = this.whichClient(ws);
      if (!senderKey) {
        // Need to register this client first
        const username = signal.username || 'WebRTC';
        const key = `${username}-${random.generateLowercase(5)}`;
        this.bufferKey = key;
        this.trackClient(ws, key);
        this.ensureBufferKey(key);
        ws.on('close', () => this.cleanupOnClose(ws));
      }

      // Re-register client in queue if not already there (in case they were removed after stop)
      if (!this.sendQueue.contains(ws)) {
        this.sendQueue.registerClient(ws);
      }

      const isFirst = this.sendQueue.hasPriority(ws);
      const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;
      if (isFirst && hasListener) {
        this.grantCTSWebRTC(ws);
      }
      // If not first, they're already in queue and will be granted CTS when their turn comes
      return;
    }

    if (signal.type === 'stop') {
      // Handle stop for WebRTC clients
      this.handleSTOP(ws);
      return;
    }

    if (signal.type === 'offer') {
      // Student sent an offer, forward to listener
      const senderKey = this.whichClient(ws);
      if (senderKey && this.listener && this.listener.readyState === WebSocket.OPEN) {
        const name = this.getClientName(ws) || 'Speaker';
        try {
          this.listener.send(JSON.stringify({ type: 'offer', sdp: signal.sdp, from: name }));
        } catch {}
      }
      return;
    }

    if (signal.type === 'answer') {
      // Listener sent an answer, forward to current active student
      if (this.listener === ws && this.currentCtsKey) {
        const studentWs = this.clientKeyMap[this.currentCtsKey];
        if (studentWs && studentWs.readyState === WebSocket.OPEN) {
          try {
            studentWs.send(JSON.stringify({ type: 'answer', sdp: signal.sdp }));
          } catch {}
        }
      }
      return;
    }

    if (signal.type === 'ice-candidate') {
      // Forward ICE candidates between peers
      const senderKey = this.whichClient(ws);
      if (this.listener === ws && this.currentCtsKey) {
        // Listener -> Student
        const studentWs = this.clientKeyMap[this.currentCtsKey];
        if (studentWs && studentWs.readyState === WebSocket.OPEN) {
          try {
            studentWs.send(JSON.stringify({ type: 'ice-candidate', candidate: signal.candidate }));
          } catch {}
        }
      } else if (senderKey && this.listener && this.listener.readyState === WebSocket.OPEN) {
        // Student -> Listener
        try {
          this.listener.send(JSON.stringify({ type: 'ice-candidate', candidate: signal.candidate }));
        } catch {}
      }
      return;
    }
  };

  private grantCTSWebRTC = (client: WebSocket) => {
    if (!this.listener || this.listener.readyState !== WebSocket.OPEN) return;
    const key = this.whichClient(client);
    if (!key) return;

    if (!this.sendQueue.hasPriority(client)) {
      this.sendQueue.removeClient(client);
      this.sendQueue.prependClient(client);
    }

    this.ensureBufferKey(key);
    this.storageBuffer[key].start = new Date();

    // Mark active BEFORE CTS so early frames are accepted
    this.currentCtsKey = key;
    this.lastSenderKey = key;

    const name = this.getClientName(client) || 'Speaker';
    try {
      this.listener.send(JSON.stringify({ type: 'clear' }));
      this.listener.send(JSON.stringify({ type: 'from', name }));
      client.send(JSON.stringify({ type: 'cts' }));
    } catch {}
  };

  private cleanupOnClose = (ws: WebSocket) => {
    const k = this.whichClient(ws);
    if (!k) return;

    const wasPriority = this.sendQueue.hasPriority(ws);
    this.sendQueue.removeClient(ws);

    if (wasPriority || this.lastSenderKey === k || this.currentCtsKey === k) {
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
      try { 
        if (this.listener) {
          this.listener.send(JSON.stringify({ type: 'clear' }));
        }
      } catch {}

      const next = this.sendQueue.peekClient?.();
      if (next && this.sendQueue.hasPriority(next) && this.listener && this.listener.readyState === WebSocket.OPEN) {
        this.grantCTSWebRTC(next);
      }
    }

    delete this.clientKeyMap[k];
    delete this.storageBuffer[k];
  };
}
