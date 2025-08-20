import { roomsApi } from '@api/client';
import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import stores from '../stores';

const Create: React.FC = () => {
  const [enableCloudRecording, setEnableCloudRecording] = useState(false);

  const createRoom = useCallback(async () => {
    const createdRoom = await roomsApi.createRoom({ enableCloudRecording });
    if (!createdRoom) {
      return;
    }
    return createdRoom.code;
  }, [enableCloudRecording]);

  // Note: this value is non-reactive!
  const recentRooms = stores.rooms.getRecentRooms();

  const navigate = useNavigate();
  return (
    <div
      className={clsx(
        'w-full h-screen flex items-center justify-center',
        'flex-col gap-y-8',
      )}
    >
      <p className="text-4xl font-semibold">Create a Room</p>
      <div className="flex flex-col items-center justify-center gap-y-2">
        <button
          className={clsx(
            'px-4 py-2 rounded-lg font-bold w-full',
            'bg-green-200 hover:bg-green-300',
          )}
          onClick={async () => {
            const roomCode = await createRoom();
            if (!roomCode) {
              return;
            }
            if (enableCloudRecording) {
              stores.rooms.addRecentRoom(roomCode);
            }
            navigate(`/listen/${roomCode}`);
          }}
        >
          Create New Room
        </button>
        {/* Note: this is a placeholder for future functionality.*/}

        <label className="flex items-center gap-x-2">
          <input
            type="checkbox"
            checked={enableCloudRecording}
            onChange={(e) => setEnableCloudRecording(e.target.checked)}
          />
          <span>Enable Cloud Recording</span>
        </label>
        <p>
          <strong>Note:</strong> You cannot change this later.
        </p>
      </div>
      <div className="flex gap-x-4 items-center">
        <hr className="w-40" />
        <span className="select-none">or</span>
        <hr className="w-40" />
      </div>
      <p className="text-4xl font-semibold">Recent Rooms</p>
      <p className="text-lg">
        Only rooms that have cloud recording enabled will be shown.
      </p>
      {recentRooms.length === 0 ? (
        <p className="text-lg">No recent rooms</p>
      ) : (
        <ul className="flex flex-col gap-y-3 w-96">
          <p className="text-gray-400 italic text-center select-none">
            Click to join
          </p>
          {recentRooms.map((room) => (
            <li
              key={room}
              className={clsx(
                'bg-gray-200 hover:bg-gray-300 rounded-xl',
                'w-full px-4 py-3',
                'cursor-pointer',
                'flex justify-between items-center',
                'group',
              )}
              onClick={() => navigate(`/listen/${room}`)}
            >
              <span>Room {room}</span>
              <Icon
                className={clsx(
                  'text-xl',
                  'transition-colors duration-500',
                  'group-hover:text-green-600',
                )}
                icon="tabler:arrow-right"
              />
            </li>
          ))}
        </ul>
      )}
      <button
        className={clsx(
          'px-4 py-2 border border-red-500',
          'font-medium text-red-500 hover:text-white',
          'transition-colors duration-500',
          'hover:bg-red-600 rounded-xl',
        )}
        onClick={() => navigate(-1)}
      >
        Back
      </button>
    </div>
  );
};

export default Create;
export const Component = Create;
Component.displayName = 'Create';
