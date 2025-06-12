import { RawData, WebSocket } from 'ws';
import random from '../utils/random';
import { SendQueue } from './queue';

export class MessageHandler {
  private readonly sendQueue: SendQueue;
  private listener: WebSocket | null;
  private clientKeyMap: Record<string, WebSocket>;
  private storageBuffer: Record<
    string,
    { start: Date | null; data: ArrayBuffer[] }
  >;

  private lastSenderKey: string | undefined = undefined;
  // TODO: Make this less hacky
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
      // TODO: Make this less hacky
      // Add 'hash' to prevent duplicate names from erroring
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
        console.log('Received binary audio data');
        return this.handleAudio;
    }
  }

  private trackClient(ws: WebSocket, key: string) {
    this.clientKeyMap[key] = ws;
  }

  private whichClient(ws: WebSocket) {
    // TODO: Figure out a better data structure
    return Object.entries(this.clientKeyMap).find(
      ([, client]) => client === ws,
    )?.[0];
  }

  private getClientName(ws: WebSocket) {
    const key = this.whichClient(ws);
    if (!key) {
      return;
    }
    return key.slice(0, key.length - 6);
  }

  private flushBuffer(client: WebSocket) {
    const clientKey = this.whichClient(client);
    if (!clientKey) {
      return;
    }
    const buffer = this.storageBuffer[clientKey];
    if (!buffer.start) {
      return;
    }
    const duration = new Date().getTime() - buffer.start.getTime();
    console.log(`Client ${clientKey} transmitted for ${duration}ms`);
    const filename = `${buffer.start.getTime()}-${clientKey}.wav`;
    const data = Buffer.concat(buffer.data.map((d) => Buffer.from(d)));

    // Reset buffer
    this.storageBuffer[clientKey] = { start: null, data: [] };
    return { filename, data };
  }

  private handleRTS(ws: WebSocket) {
    // Register client
    this.sendQueue.registerClient(ws);
    this.trackClient(ws, this.bufferKey!);
    // Initialize storage buffer
    this.storageBuffer[this.whichClient(ws)!] = { start: null, data: [] };
    // Signal client to transmit
    if (this.sendQueue.hasPriority(ws)) {
      this.storageBuffer[this.whichClient(ws)!].start = new Date();
      ws.send('CTS');
    }
  }

  public handleSTOP(ws: WebSocket) {
    if (this.listener === ws) {
      this.listener = null;
      console.log(`Disconnected listener for room ${this.roomCode}`);
      return;
    }
    const hasPriority = this.sendQueue.hasPriority(ws);
    if (hasPriority) {
      // Client is currently transmitting
      // Remove client from queue
      this.lastSenderKey = undefined;
      // Flush buffer and push file to callback
      const file = this.flushBuffer(ws);
      if (file) {
        this.onIncomingFile?.(file.filename, file.data);
      }
      // Signal listener that current client is done
      this.listener?.send('CLEAR');
    }
    const nextClient = this.sendQueue.removeClient(ws);
    // Signal next client to transmit
    if (nextClient) {
      this.storageBuffer[this.whichClient(nextClient)!].start = new Date();
      nextClient.send('CTS');
    }
  }

  private handleLISTEN(ws: WebSocket) {
    // Only allow one listener at a time
    this.listener?.close();
    this.listener = ws;
    console.log(`Registered listener for room ${this.roomCode}`);
  }

  private handleAudio(ws: WebSocket, data: RawData) {
    const sender = this.whichClient(ws);
    // Guard clause
    if (!this.sendQueue.hasPriority(ws)) {
      console.log('Client has no priority');
      return;
    }
    // Whenever a new client starts transmitting,
    // let the listener know
    if (sender !== this.lastSenderKey) {
      this.listener?.send(`FROM${this.getClientName(ws)}`);
      this.lastSenderKey = sender!;
    }
    this.storageBuffer[sender!].data.push(data as ArrayBuffer);
    this.listener?.send(data);
  }
}
