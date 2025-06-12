import { BadRequestError, NotFoundError } from '../internal/errors';

export type Storage = {
  roomCode: string;
  filename: string;
  data: ArrayBuffer;
};

class StorageRepository {
  private storages: Record<string, Storage> = {};

  store(roomCode: string, filename: string, data: ArrayBuffer): Storage {
    const key = `${roomCode}/${filename}`;
    if (this.storages[key]) {
      throw new BadRequestError('File already exists');
    }
    this.storages[key] = { roomCode, filename, data };
    return this.storages[key];
  }

  load(roomCode: string, filename: string): Storage | undefined {
    return this.storages[`${roomCode}/${filename}`];
  }

  loadAll(roomCode: string): Storage[] {
    const files = Object.values(this.storages).filter(
      (storage) => storage.roomCode === roomCode,
    );
    if (!files.length) {
      throw new NotFoundError('Room', roomCode);
    }
    return files;
  }

  delete(roomCode: string, filename: string): Storage {
    const key = `${roomCode}/${filename}`;
    if (!this.storages[key]) {
      throw new NotFoundError('File', filename);
    }
    const storageToDelete = this.storages[key];
    delete this.storages[key];
    return storageToDelete;
  }

  deleteAll(roomCode: string): Storage[] {
    const storagesToDelete = Object.values(this.storages).filter(
      (storage) => storage.roomCode === roomCode,
    );
    storagesToDelete.forEach((storage) => {
      delete this.storages[`${storage.roomCode}/${storage.filename}`];
    });
    return storagesToDelete;
  }
}

export default new StorageRepository();
