import Cache from 'timed-cache';
import roomRepository, { Room } from '../repositories/room.repository';
import storageRepository from '../repositories/storage.repository';
import random from '../utils/random';
import { MessageHandler } from '../ws/handler';

const generateRoomCode = () => {
  return random.generateUppercase(3) + random.generateNumeric(3);
};

const oneHour = 60 * 60 * 1000;
const roomCache = new Cache<Room>({ defaultTtl: oneHour });

// Store cooldowns for each room to allow for file downloads
const sixHours = 6 * oneHour;
const cooldownCache = new Cache<Room & { cooldown: Date }>({
  defaultTtl: sixHours,
});

const wsHandlers: Record<string, MessageHandler> = {};

export default {
  create(enableCloudRecording: boolean = false) {
    const room: Room = {
      code: generateRoomCode(),
      persistent: false,
      expiredAt: new Date(Date.now() + oneHour),
    };

    // Make sure room code is unique
    let attempts = 1;
    while (this.find(room.code) || cooldownCache.get(room.code)) {
      room.code = generateRoomCode();
      attempts++;
    }
    console.log(`Found unused room code after ${attempts} attempts`);

    wsHandlers[room.code] = new MessageHandler(
      room.code,
      enableCloudRecording
        ? (filename, data) => storageRepository.store(room.code, filename, data)
        : undefined,
    );
    roomCache.put(room.code, room, {
      // @ts-expect-error incorrect type definition
      callback: (code: string, _value: Room) => {
        roomRepository.delete(code);
        delete wsHandlers[code];
      },
    });
    // Add cooldown to allow for file downloads
    // even after room has expired
    cooldownCache.put(
      room.code,
      { ...room, cooldown: new Date(new Date().getTime() + sixHours) },
      {
        // @ts-expect-error incorrect type definition
        callback: (code: string, _value: Room) => {
          // Delete all files in storage after cooldown
          storageRepository.deleteAll(code);
        },
      },
    );

    return roomRepository.create(room);
  },

  find(code: string) {
    const cachedRoom = roomCache.get(code);
    if (cachedRoom) {
      return cachedRoom;
    }

    const foundRoom = roomRepository.find(code);
    if (!foundRoom) {
      return null;
    }
    if (foundRoom.expiredAt.getTime() < Date.now()) {
      roomRepository.delete(code);
      return null;
    }
    // Room is present and active, instantiate message handler if missing
    if (!wsHandlers[code]) {
      wsHandlers[code] = new MessageHandler(code);
    }
    return foundRoom;
  },

  getTtl(code: string) {
    const room = this.find(code);
    if (!room) {
      return 0;
    }
    return room.expiredAt.getTime() - Date.now();
  },

  // TODO: Remove endpoint and replace with
  // proper download checking logic
  getCooldown(code: string) {
    const cooldown = cooldownCache.get(code)?.cooldown.getTime();
    if (!cooldown) {
      return 0;
    }
    return cooldown - Date.now();
  },

  getWsHandler(code: string): MessageHandler | undefined {
    return wsHandlers[code];
  },
};
