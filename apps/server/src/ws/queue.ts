import { WebSocket as Client } from 'ws';

export class SendQueue {
  private clients: Client[] = [];

  public registerClient(client: Client): void {
    if (!this.contains(client)) this.clients.push(client);
  }

  public removeClient(client: Client): Client | undefined {
    const idx = this.clients.indexOf(client);
    if (idx === -1) {
      // Not in queue; nothing to remove
      return undefined;
    }

    let retVal: Client | undefined = undefined;
    if (idx === 0) {
      // Current sender is done transmitting → signal next if any
      retVal = this.clients[1];
    } else {
      // A waiting sender cancels transmission
      // (No noisy log here; this is expected sometimes)
      // console.log('Client cancelled RTS');
    }

    this.clients.splice(idx, 1);
    return retVal;
  }

  public hasPriority(client: Client): boolean {
    return this.clients[0] === client;
  }

  public peekClient(): Client | null {
    return this.clients.length > 0 ? this.clients[0] : null;
  }

  public prependClient(ws: Client) {
    // Remove it if it already exists
    this.clients = this.clients.filter((client) => client !== ws);
    // Add to front
    this.clients.unshift(ws);
  }

  public contains(client: Client): boolean {
    return this.clients.indexOf(client) !== -1;
  }

  public size(): number {
    return this.clients.length;
  }
}
