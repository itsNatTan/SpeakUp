import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<string, { start: Date | null; data: ArrayBuffer[] }>;

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

  private flushBuffer(client: WebSocket) {
    const clientKey = this.whichClient(client);
    if (!clientKey) return;

    const buffer = this.storageBuffer[clientKey];
    if (!buffer.start) return;

    const filename = `${buffer.start.getTime()}-${clientKey}.wav`;
    const data = Buffer.concat(buffer.data.map((d) => Buffer.from(d)));

    // Reset buffer
    this.storageBuffer[clientKey] = { start: null, data: [] };
    return { filename, data };
  }

  private handleRTS = (ws: WebSocket) => {
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);
    this.storageBuffer[this.whichClient(ws)!] = { start: null, data: [] };

    const isFirstInQueue = this.sendQueue.hasPriority(ws);
    const hasListener = this.listener && this.listener.readyState === WebSocket.OPEN;

    if (isFirstInQueue && hasListener) {
      this.storageBuffer[this.whichClient(ws)!].start = new Date();
      ws.send('CTS');
    }
  };

  public handleSTOP = (ws: WebSocket) => {
    // If the listener disconnected
    if (this.listener === ws) {
      this.listener = null;

      if (this.lastSenderKey) {
        const senderWs = this.clientKeyMap[this.lastSenderKey];
        if (senderWs) {
          this.sendQueue.prependClient(senderWs);
          senderWs.send('STOP');
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
        this.storageBuffer[key].start = new Date();
        nextClient.send('CTS');
      }
    }
  };

  private handleLISTEN = (ws: WebSocket) => {
    this.listener?.close();
    this.listener = ws;

    ws.on('close', () => {
      if (this.listener === ws) {
        this.listener = null;

        if (this.lastSenderKey) {
          const senderWs = this.clientKeyMap[this.lastSenderKey];
          if (senderWs) {
            this.sendQueue.prependClient(senderWs);
            senderWs.send('STOP');
          }
          this.lastSenderKey = undefined;
        }
      }
    });

    const currentSenderKey = this.lastSenderKey;
    if (currentSenderKey) {
      const clientName = currentSenderKey.slice(0, currentSenderKey.length - 6);
      ws.send(`FROM${clientName}`);
    }

    const nextClient = this.sendQueue.peekClient?.();
    if (nextClient && this.sendQueue.hasPriority(nextClient)) {
      const key = this.whichClient(nextClient);
      if (key) {
        this.storageBuffer[key].start = new Date();
        nextClient.send('CTS');
      }
    }
  };

  private handleAudio = (ws: WebSocket, data: RawData) => {
    const sender = this.whichClient(ws);
    if (!this.sendQueue.hasPriority(ws)) return;

    if (sender !== this.lastSenderKey) {
      this.listener?.send(`FROM${this.getClientName(ws)}`);
      this.lastSenderKey = sender!;
    }

    this.storageBuffer[sender!].data.push(data as ArrayBuffer);
    this.listener?.send(data);
  };
}

