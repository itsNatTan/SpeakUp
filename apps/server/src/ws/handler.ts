import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

type BufferSlot = { start: Date | null; data: ArrayBuffer[] };
type ClientInfo = { ws: WebSocket; priority: number; joinTime: Date; manualOrder?: number };

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private clientInfoMap: Record<string, ClientInfo>; // Store client info including priority
  private storageBuffer: Record<string, BufferSlot>;
  
  // Track all instructor connections (for queue updates even when not listening)
  private instructorConnections: Set<WebSocket> = new Set();
  
  // Queue sort mode: 'fifo' or 'priority'
  private queueSortMode: 'fifo' | 'priority' = 'fifo';

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
    this.clientInfoMap = {};
    this.storageBuffer = {};
  }

  public getMessageHandler(data: RawData) {
    const message = data.toString();

    // Check if it's a JSON WebRTC signaling message
    if (message.startsWith('{')) {
      try {
        const signal = JSON.parse(message);
        if (signal.type) {
          // Handle queue management messages
          if (signal.type === 'kick-user') {
            return this.handleKickUser.bind(this, signal.username);
          }
          if (signal.type === 'reorder-user') {
            return this.handleReorderUser.bind(this, signal.username, signal.direction);
          }
          if (signal.type === 'move-user-to-position') {
            return this.handleMoveUserToPosition.bind(this, signal.username, signal.position);
          }
          if (signal.type === 'set-queue-sort-mode') {
            return this.handleSetQueueSortMode.bind(this, signal.mode);
          }
          if (signal.type === 'update-priority') {
            return this.handleUpdatePriority.bind(this, signal.priority);
          }
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
      case 'QUEUE_STATUS':
        return this.handleQueueStatus;
      default:
        return this.handleAudio;
    }
  }

  private trackClient(ws: WebSocket, key: string, priority: number = 0) { 
    this.clientKeyMap[key] = ws;
    // Use existing manualOrder if client already exists (e.g., reconnecting)
    const existingInfo = this.clientInfoMap[key];
    this.clientInfoMap[key] = { 
      ws, 
      priority, 
      joinTime: existingInfo?.joinTime ?? new Date(),
      manualOrder: existingInfo?.manualOrder,
    };
  }
  
  private updateManualOrder() {
    // Update manual order for all clients based on their current position
    const queueClients = this.sendQueue.getAllClients();
    queueClients.forEach((client, index) => {
      const key = this.whichClient(client);
      if (key && this.clientInfoMap[key]) {
        this.clientInfoMap[key].manualOrder = index;
      }
    });
  }
  private whichClient(ws: WebSocket) { return Object.entries(this.clientKeyMap).find(([, c]) => c === ws)?.[0]; }
  private getClientName(ws: WebSocket) { const k = this.whichClient(ws); return k ? k.slice(0, k.length - 6) : undefined; }
  private getClientPriority(ws: WebSocket): number {
    const key = this.whichClient(ws);
    return key ? (this.clientInfoMap[key]?.priority ?? 0) : 0;
  }
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
    
    // Send queue update when speaker changes
    this.sendQueueUpdate();
  };

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    // RTS doesn't include priority, default to 0
    this.trackClient(ws, this.bufferKey!, 0);
    const key = this.whichClient(ws)!;
    this.ensureBufferKey(key);

    ws.on('close', () => this.cleanupOnClose(ws));

    const isFirst = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;
    if (isFirst && hasListener) this.grantCTS(ws);
    
    // Send queue update
    this.sendQueueUpdate();
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
    // Send queue update
    this.sendQueueUpdate();
  };

  private handleLISTEN = (ws: WebSocket) => {
    try { this.listener?.close(); } catch {}
    this.listener = ws;
    
    // Also track as instructor connection
    if (ws.readyState === WebSocket.OPEN) {
      this.instructorConnections.add(ws);
    }

    ws.on('close', () => {
      this.instructorConnections.delete(ws);
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
      // Send initial queue status
      this.sendQueueUpdate();
      return;
    }

    if (this.lastSenderKey) {
      const clientName = this.lastSenderKey.slice(0, this.lastSenderKey.length - 6);
      try { 
        ws.send(JSON.stringify({ type: 'from', name: clientName }));
      } catch {}
    }

    // Send initial queue status when listener connects
    this.sendQueueUpdate();
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
    if (this.listener !== ws || !this.listener || this.listener.readyState !== WebSocket.OPEN) {
      console.log('[Server] Skip rejected - not listener or listener not open');
      return;
    }

    console.log('[Server] Skip called, queue size:', this.sendQueue.size());
    console.log('[Server] Current CTS key:', this.currentCtsKey, 'Last sender:', this.lastSenderKey);

    try { 
      this.listener.send(JSON.stringify({ type: 'clear' }));
    } catch {}

    let activeStudentWs: WebSocket | undefined;
    // First check if there's an active speaker (has CTS)
    if (this.currentCtsKey) {
      activeStudentWs = this.clientKeyMap[this.currentCtsKey];
      console.log('[Server] Found active speaker with CTS:', this.currentCtsKey);
    } else if (this.lastSenderKey) {
      // Check if there's a last sender (might be finishing up)
      activeStudentWs = this.clientKeyMap[this.lastSenderKey];
      console.log('[Server] Found last sender:', this.lastSenderKey);
    }

    let nextClient: WebSocket | undefined;

    if (activeStudentWs) {
      // There's an active speaker - stop them and remove from queue
      console.log('[Server] Stopping active speaker');
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
      // No active speaker - remove the head of the queue (next waiting person)
      const head = this.sendQueue.peekClient?.();
      if (head) {
        console.log('[Server] No active speaker, removing head of queue');
        // Send stop to the waiting person
        if (head.readyState === WebSocket.OPEN) {
          try {
            head.send(JSON.stringify({ type: 'stop' }));
          } catch {}
        }
        nextClient = this.sendQueue.removeClient(head);
      } else {
        console.log('[Server] Queue is empty, nothing to skip');
      }
      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;
    }

    if (nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      console.log('[Server] Granting CTS to next client after skip');
      this.grantCTSWebRTC(nextClient);
    } else {
      console.log('[Server] No next client after skip');
    }
    // Send queue update
    this.sendQueueUpdate();
  };

  private sendQueueUpdate = () => {
    const queueInfo = this.getQueueInfo();
    
    // Send to all instructor connections (including when not actively listening)
    this.instructorConnections.forEach((instructorWs: WebSocket) => {
      if (instructorWs.readyState === WebSocket.OPEN) {
        try {
          instructorWs.send(JSON.stringify({ type: 'queue-update', ...queueInfo }));
        } catch {
          // Remove dead connections
          this.instructorConnections.delete(instructorWs);
        }
      } else {
        // Remove closed connections
        this.instructorConnections.delete(instructorWs);
      }
    });
  };

  private getQueueInfo = () => {
    const queueClients = this.sendQueue.getAllClients();
    const queue: Array<{ username: string; key: string; priority: number; joinTime: Date }> = [];
    
    const currentSpeaker = this.currentCtsKey 
      ? this.currentCtsKey.slice(0, this.currentCtsKey.length - 6)
      : null;
    
    const currentSpeakerPriority = this.currentCtsKey 
      ? (this.clientInfoMap[this.currentCtsKey]?.priority ?? 0)
      : 0;
    
    // Build queue, excluding current speaker
    queueClients.forEach((client) => {
      const key = this.whichClient(client);
      if (key) {
        const username = key.slice(0, key.length - 6);
        // Only add to queue if not the current speaker
        if (username !== currentSpeaker) {
          const info = this.clientInfoMap[key];
          queue.push({ 
            username, 
            key,
            priority: info?.priority ?? 0,
            joinTime: info?.joinTime ?? new Date(),
          });
        }
      }
    });

    return {
      queue,
      currentSpeaker,
      currentSpeakerPriority,
      queueSize: queue.length, // Queue size excludes current speaker
      sortMode: this.queueSortMode,
    };
  };

  private handleQueueStatus = (ws: WebSocket) => {
    // Track this as an instructor connection (for queue updates)
    if (ws.readyState === WebSocket.OPEN) {
      this.instructorConnections.add(ws);
      
      // Clean up on close
      ws.on('close', () => {
        this.instructorConnections.delete(ws);
        if (this.listener === ws) {
          this.listener = null;
        }
      });
    }

    const queueInfo = this.getQueueInfo();
    try {
      ws.send(JSON.stringify({ type: 'queue-status', ...queueInfo }));
    } catch {}
  };

  private handleKickUser = (username: string, ws: WebSocket) => {
    // Only instructor can kick users (not just active listener)
    if (!this.instructorConnections.has(ws) || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Find the client by username
    let targetClient: WebSocket | null = null;
    let targetKey: string | null = null;

    for (const [key, client] of Object.entries(this.clientKeyMap)) {
      const clientUsername = key.slice(0, key.length - 6);
      if (clientUsername === username) {
        targetClient = client;
        targetKey = key;
        break;
      }
    }

    if (!targetClient || !targetKey) {
      // User not found
      try {
        ws.send(JSON.stringify({ type: 'kick-error', message: 'User not found in queue' }));
      } catch {}
      return;
    }

    // Check if this is the current speaker
    const isCurrentSpeaker = targetKey === this.currentCtsKey || targetKey === this.lastSenderKey;

    if (isCurrentSpeaker) {
      // Stop the current speaker
      const file = this.flushBuffer(targetClient);
      if (file) { try { this.onIncomingFile?.(file.filename, file.data); } catch {} }
      
      if (targetClient.readyState === WebSocket.OPEN) {
        try {
          targetClient.send(JSON.stringify({ type: 'stop' }));
        } catch {}
      }

      this.lastSenderKey = undefined;
      this.currentCtsKey = undefined;

      try {
        if (this.listener && this.listener.readyState === WebSocket.OPEN) {
          this.listener.send(JSON.stringify({ type: 'clear' }));
        }
      } catch {}
    }

    // Remove from queue
    const nextClient = this.sendQueue.removeClient(targetClient);
    
    // If this was the current speaker, grant CTS to next in queue
    if (isCurrentSpeaker && nextClient && this.listener && this.listener.readyState === WebSocket.OPEN) {
      this.grantCTSWebRTC(nextClient);
    }

    // Send kicked message to user (this will turn off their speaker)
    if (targetClient.readyState === WebSocket.OPEN) {
      try {
        targetClient.send(JSON.stringify({ type: 'kicked' }));
        // Also send stop to ensure they're fully stopped
        targetClient.send(JSON.stringify({ type: 'stop' }));
      } catch {}
    }

    // Send queue update
    this.sendQueueUpdate();
  };

  private handleReorderUser = (username: string, direction: 'up' | 'down', ws: WebSocket) => {
    // Only instructor can reorder users
    if (!this.instructorConnections.has(ws) || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Find the client by username
    let targetClient: WebSocket | null = null;

    for (const [key, client] of Object.entries(this.clientKeyMap)) {
      const clientUsername = key.slice(0, key.length - 6);
      if (clientUsername === username) {
        targetClient = client;
        break;
      }
    }

    if (!targetClient) {
      // User not found
      try {
        ws.send(JSON.stringify({ type: 'reorder-error', message: 'User not found in queue' }));
      } catch {}
      return;
    }

    // Don't allow reordering if user is the current speaker
    const targetKey = this.whichClient(targetClient);
    if (targetKey && (targetKey === this.currentCtsKey || targetKey === this.lastSenderKey)) {
      try {
        ws.send(JSON.stringify({ type: 'reorder-error', message: 'Cannot reorder current speaker' }));
      } catch {}
      return;
    }

    // Move the client in the queue
    const moved = this.sendQueue.moveClient(targetClient, direction);
    if (moved) {
      // Update manual order after manual reordering
      this.updateManualOrder();
      // Send queue update
      this.sendQueueUpdate();
    } else {
      try {
        ws.send(JSON.stringify({ type: 'reorder-error', message: 'Cannot move user in that direction' }));
      } catch {}
    }
  };

  private handleMoveUserToPosition = (username: string, position: number, ws: WebSocket) => {
    // Only instructor can move users
    if (!this.instructorConnections.has(ws) || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Find the client by username
    let targetClient: WebSocket | null = null;

    for (const [key, client] of Object.entries(this.clientKeyMap)) {
      const clientUsername = key.slice(0, key.length - 6);
      if (clientUsername === username) {
        targetClient = client;
        break;
      }
    }

    if (!targetClient) {
      try {
        ws.send(JSON.stringify({ type: 'move-error', message: 'User not found in queue' }));
      } catch {}
      return;
    }

    // Don't allow moving if user is the current speaker
    const targetKey = this.whichClient(targetClient);
    if (targetKey && (targetKey === this.currentCtsKey || targetKey === this.lastSenderKey)) {
      try {
        ws.send(JSON.stringify({ type: 'move-error', message: 'Cannot move current speaker' }));
      } catch {}
      return;
    }

    // Move the client to the specified position
    const moved = this.sendQueue.moveClientToPosition(targetClient, position);
    if (moved) {
      // Update manual order after manual reordering
      this.updateManualOrder();
      // Send queue update
      this.sendQueueUpdate();
    } else {
      try {
        ws.send(JSON.stringify({ type: 'move-error', message: 'Cannot move user to that position' }));
      } catch {}
    }
  };

  private handleWebRTCSignaling = (signal: any, ws: WebSocket) => {
    // Handle WebRTC signaling messages
    if (signal.type === 'ready') {
      // Student wants to speak (WebRTC version of RTS)
      const senderKey = this.whichClient(ws);
      const priority = signal.priority ?? 0;
      
      if (!senderKey) {
        // Need to register this client first
        const username = signal.username || 'WebRTC';
        const key = `${username}-${random.generateLowercase(5)}`;
        this.bufferKey = key;
        this.trackClient(ws, key, priority);
        this.ensureBufferKey(key);
        ws.on('close', () => this.cleanupOnClose(ws));
      } else {
        // Update priority if client already exists
        if (this.clientInfoMap[senderKey]) {
          this.clientInfoMap[senderKey].priority = priority;
        }
      }

      // Re-register client in queue if not already there (in case they were removed after stop)
      if (!this.sendQueue.contains(ws)) {
        this.sendQueue.registerClient(ws);
        
        // Initialize manual order for new client if they don't have one
        const senderKey = this.whichClient(ws);
        if (senderKey && this.clientInfoMap[senderKey] && this.clientInfoMap[senderKey].manualOrder === undefined) {
          const queueClients = this.sendQueue.getAllClients();
          const currentIndex = queueClients.indexOf(ws);
          if (currentIndex !== -1) {
            this.clientInfoMap[senderKey].manualOrder = currentIndex;
          }
        }
        
        // If in priority mode, re-sort after adding (excluding current speaker)
        if (this.queueSortMode === 'priority') {
          const currentSpeakerWs = this.currentCtsKey 
            ? this.clientKeyMap[this.currentCtsKey] 
            : undefined;
          this.sendQueue.sortByPriority(
            (client) => this.getClientPriority(client),
            (client) => {
              const clientKey = this.whichClient(client);
              return clientKey ? (this.clientInfoMap[clientKey]?.joinTime ?? new Date()) : new Date();
            },
            (client) => {
              const clientKey = this.whichClient(client);
              return clientKey ? this.clientInfoMap[clientKey]?.manualOrder : undefined;
            },
            currentSpeakerWs // Exclude current speaker from sort
          );
        }
        
        // Send queue update to listener
        this.sendQueueUpdate();
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
        console.log('[Server] Forwarding offer to listener', {
          from: name,
          hasSdp: !!signal.sdp,
          sdpType: signal.sdp?.type,
        });
        try {
          this.listener.send(JSON.stringify({ type: 'offer', sdp: signal.sdp, from: name }));
        } catch (err) {
          console.error('[Server] Failed to send offer to listener:', err);
        }
      } else {
        console.warn('[Server] Cannot forward offer - missing senderKey or listener', {
          hasSenderKey: !!senderKey,
          hasListener: !!this.listener,
          listenerOpen: this.listener?.readyState === WebSocket.OPEN,
        });
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
    
    // Send queue update when speaker changes
    this.sendQueueUpdate();
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
    delete this.clientInfoMap[k];
    delete this.storageBuffer[k];
    
    // Send queue update when client leaves
    this.sendQueueUpdate();
  };

  private handleSetQueueSortMode = (mode: 'fifo' | 'priority', ws: WebSocket) => {
    // Only instructor can set sort mode
    if (!this.instructorConnections.has(ws) || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.queueSortMode = mode;
    
    // Get current speaker's WebSocket to exclude from sorting
    const currentSpeakerWs = this.currentCtsKey 
      ? this.clientKeyMap[this.currentCtsKey] 
      : undefined;
    
    // Before sorting, ensure all clients have a manual order (based on current position)
    // This preserves the current order when switching modes
    const queueClients = this.sendQueue.getAllClients();
    queueClients.forEach((client, index) => {
      const key = this.whichClient(client);
      if (key && this.clientInfoMap[key] && this.clientInfoMap[key].manualOrder === undefined) {
        this.clientInfoMap[key].manualOrder = index;
      }
    });
    
    // Reorder the actual queue based on mode (excluding current speaker)
    if (mode === 'priority') {
      this.sendQueue.sortByPriority(
        (client) => this.getClientPriority(client),
        (client) => {
          const key = this.whichClient(client);
          return key ? (this.clientInfoMap[key]?.joinTime ?? new Date()) : new Date();
        },
        (client) => {
          const key = this.whichClient(client);
          return key ? this.clientInfoMap[key]?.manualOrder : undefined;
        },
        currentSpeakerWs // Exclude current speaker from sort
      );
    } else {
      // FIFO mode - use manual order if available, otherwise join time (excluding current speaker)
      this.sendQueue.sortByFifo(
        (client) => {
          const key = this.whichClient(client);
          return key ? (this.clientInfoMap[key]?.joinTime ?? new Date()) : new Date();
        },
        (client) => {
          const key = this.whichClient(client);
          return key ? this.clientInfoMap[key]?.manualOrder : undefined;
        },
        currentSpeakerWs // Exclude current speaker from sort
      );
    }

    // Send queue update
    this.sendQueueUpdate();
  };

  private handleUpdatePriority = (priority: number, ws: WebSocket) => {
    // Student updating their priority
    const key = this.whichClient(ws);
    if (!key) return;

    // Update priority
    if (this.clientInfoMap[key]) {
      this.clientInfoMap[key].priority = priority;
    }

    // If in priority mode, re-sort the queue (excluding current speaker)
    if (this.queueSortMode === 'priority') {
      const currentSpeakerWs = this.currentCtsKey 
        ? this.clientKeyMap[this.currentCtsKey] 
        : undefined;
      this.sendQueue.sortByPriority(
        (client) => this.getClientPriority(client),
        (client) => {
          const clientKey = this.whichClient(client);
          return clientKey ? (this.clientInfoMap[clientKey]?.joinTime ?? new Date()) : new Date();
        },
        (client) => {
          const clientKey = this.whichClient(client);
          return clientKey ? this.clientInfoMap[clientKey]?.manualOrder : undefined;
        },
        currentSpeakerWs // Exclude current speaker from sort
      );
    }

    // Send queue update
    this.sendQueueUpdate();
  };
}
