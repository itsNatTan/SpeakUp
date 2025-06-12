import base from './base';

// TODO: Deduplicate from room repository
export type Room = {
  code: string;
  persistent: boolean;
  expiredAt: Date;
};

type CreateRoomOptions = {
  enableCloudRecording?: boolean;
};

const createRoom = async ({
  enableCloudRecording = false,
}: CreateRoomOptions = {}): Promise<Room | null> => {
  try {
    const resp = await base.post('/api/v1/rooms', { enableCloudRecording });
    return { ...resp.data, expiredAt: new Date(resp.data.expiredAt) };
  } catch {
    return null;
  }
};

const joinRoom = async (roomId: string): Promise<Room | null> => {
  try {
    const resp = await base.post(`/api/v1/rooms/${roomId}/join`);
    return { ...resp.data, expiredAt: new Date(resp.data.expiredAt) };
  } catch {
    return null;
  }
};

const getTtl = async (roomId: string): Promise<number | null> => {
  try {
    const resp = await base.get(`/api/v1/rooms/${roomId}/ttl`);
    return resp.data.ttl;
  } catch {
    return null;
  }
};

// TODO: Remove endpoint and replace with
// proper download checking logic
const getCooldown = async (roomId: string): Promise<number | null> => {
  try {
    const resp = await base.get(`/api/v1/rooms/${roomId}/cooldown`);
    return resp.data.cooldown;
  } catch {
    return null;
  }
};

export const roomsApi = {
  createRoom,
  joinRoom,
  getTtl,
  getCooldown,
};
