import { persistentAtom } from '@nanostores/persistent';

const $recentRooms = persistentAtom<string>('recentRooms', '');

export const store = {
  getRecentRooms: () => $recentRooms.get().split(',').filter(Boolean),
  setRecentRooms: (rooms: string[]) => $recentRooms.set(rooms.join(',')),
  addRecentRoom: (room: string) => {
    const recentRooms = $recentRooms.get().split(',').filter(Boolean);
    recentRooms.unshift(room);
    $recentRooms.set(recentRooms.join(','));
  },
  clearRecentRooms: () => $recentRooms.set(''),
};
