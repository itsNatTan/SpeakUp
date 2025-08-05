import { WebSocket as Client } from 'ws';

export class SendQueue {
  private clients: Client[] = [];

  public registerClient(client: Client): void {
    this.clients.push(client);
  }

  public removeClient(client: Client): Client | undefined {
    let retVal: Client | undefined = undefined;
    if (this.hasPriority(client)) {
      // Current sender is done transmitting,
      // we need to signal the next client
      retVal = this.clients[1];
    } else {
      // A waiting sender cancels transmission
      // No need to signal anything
      console.log('Client cancelled RTS');
    }
    // Remove the client from the queue
    this.clients = this.clients.filter((c) => c !== client);
    return retVal;
  }

  public hasPriority(client: Client): boolean {
    return this.clients[0] === client;
  }

  public peekClient(): WebSocket | null {
    return this.clients.length > 0 ? this.clients[0] : null;
  }

  public prependClient(ws: WebSocket) {
    // Remove it if it already exists
    this.clients = this.clients.filter((client) => client !== ws);
    // Add to front
    this.clients.unshift(ws);
  }

}
