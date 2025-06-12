import { BadRequestError, NotFoundError } from '../internal/errors';

export type Room = {
  code: string;
  persistent: boolean;
  expiredAt: Date;
};

class RoomRepository {
  private rooms: Record<string, Room> = {};

  create(room: Room): Room {
    if (this.rooms[room.code]) {
      throw new BadRequestError('Room already exists');
    }
    this.rooms[room.code] = room;
    return room;
  }

  find(code: string): Room | undefined {
    return this.rooms[code];
  }

  update(room: Room): Room {
    if (!this.rooms[room.code]) {
      throw new NotFoundError('Room not found');
    }
    this.rooms[room.code] = room;
    return room;
  }

  delete(code: string): Room {
    if (!this.rooms[code]) {
      throw new NotFoundError('Room not found');
    }
    const roomToDelete = this.rooms[code];
    delete this.rooms[code];
    return roomToDelete;
  }
}

export default new RoomRepository();
