import { WebSocket as Client } from 'ws';

export class SendQueue {
  private clients: Client[] = [];

  public registerClient(client: Client): void {
    if (!this.contains(client)) this.clients.push(client);
  }

  public removeClient(client: Client): Client | undefined {
    const idx = this.clients.indexOf(client);
    if (idx === -1) {
      // not present; nothing to remove
      return undefined;
    }

    let retVal: Client | undefined = undefined;
    if (idx === 0) {
      // current head leaves → next becomes candidate
      retVal = this.clients[1];
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
    this.clients = this.clients.filter((c) => c !== ws);
    this.clients.unshift(ws);
  }

  public contains(client: Client): boolean {
    return this.clients.indexOf(client) !== -1;
  }

  public size(): number {
    return this.clients.length;
  }
}
