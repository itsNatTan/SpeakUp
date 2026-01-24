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

  public getAllClients(): Client[] {
    return [...this.clients];
  }

  public moveClient(client: Client, direction: 'up' | 'down'): boolean {
    const idx = this.clients.indexOf(client);
    if (idx === -1) return false;

    if (direction === 'up') {
      if (idx === 0) return false; // Already at top
      // Swap with previous
      [this.clients[idx - 1], this.clients[idx]] = [this.clients[idx], this.clients[idx - 1]];
    } else {
      if (idx === this.clients.length - 1) return false; // Already at bottom
      // Swap with next
      [this.clients[idx], this.clients[idx + 1]] = [this.clients[idx + 1], this.clients[idx]];
    }
    return true;
  }

  public moveClientToPosition(client: Client, newPosition: number): boolean {
    const idx = this.clients.indexOf(client);
    if (idx === -1) return false;
    if (newPosition < 0 || newPosition >= this.clients.length) return false;
    if (idx === newPosition) return false; // Already at that position

    // Remove from current position
    this.clients.splice(idx, 1);
    // Insert at new position
    this.clients.splice(newPosition, 0, client);
    return true;
  }
}
