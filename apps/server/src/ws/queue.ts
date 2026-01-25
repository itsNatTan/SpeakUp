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

  public sortByPriority(
    getPriority: (client: Client) => number, 
    getJoinTime: (client: Client) => Date,
    getManualOrder: (client: Client) => number | undefined,
    excludeClient?: Client
  ): void {
    // If there's a client to exclude (current speaker), remove them temporarily
    let excludedClient: Client | undefined = undefined;
    let excludedIndex = -1;
    
    if (excludeClient) {
      excludedIndex = this.clients.indexOf(excludeClient);
      if (excludedIndex !== -1) {
        excludedClient = this.clients.splice(excludedIndex, 1)[0];
      }
    }
    
    // Sort by priority (descending), then by manual order (if exists), then by join time (ascending)
    this.clients.sort((a, b) => {
      const priorityA = getPriority(a);
      const priorityB = getPriority(b);
      if (priorityB !== priorityA) {
        return priorityB - priorityA;
      }
      // Within same priority, use manual order if available
      const manualOrderA = getManualOrder(a);
      const manualOrderB = getManualOrder(b);
      if (manualOrderA !== undefined && manualOrderB !== undefined) {
        return manualOrderA - manualOrderB;
      }
      // Fall back to join time
      const timeA = getJoinTime(a).getTime();
      const timeB = getJoinTime(b).getTime();
      return timeA - timeB;
    });
    
    // Re-insert excluded client at the beginning (they're the current speaker)
    if (excludedClient !== undefined) {
      this.clients.unshift(excludedClient);
    }
  }

  public sortByFifo(
    getJoinTime: (client: Client) => Date, 
    getManualOrder: (client: Client) => number | undefined,
    excludeClient?: Client
  ): void {
    // If there's a client to exclude (current speaker), remove them temporarily
    let excludedClient: Client | undefined = undefined;
    let excludedIndex = -1;
    
    if (excludeClient) {
      excludedIndex = this.clients.indexOf(excludeClient);
      if (excludedIndex !== -1) {
        excludedClient = this.clients.splice(excludedIndex, 1)[0];
      }
    }
    
    // Sort by manual order (if exists), then by join time (ascending) - FIFO order
    // This preserves manual reordering while falling back to join time for new clients
    this.clients.sort((a, b) => {
      const manualOrderA = getManualOrder(a);
      const manualOrderB = getManualOrder(b);
      
      // If both have manual order, use it
      if (manualOrderA !== undefined && manualOrderB !== undefined) {
        return manualOrderA - manualOrderB;
      }
      // If only one has manual order, prioritize it
      if (manualOrderA !== undefined) return -1;
      if (manualOrderB !== undefined) return 1;
      // Otherwise, use join time
      const timeA = getJoinTime(a).getTime();
      const timeB = getJoinTime(b).getTime();
      return timeA - timeB;
    });
    
    // Re-insert excluded client at the beginning (they're the current speaker)
    if (excludedClient !== undefined) {
      this.clients.unshift(excludedClient);
    }
  }
}
