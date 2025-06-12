import { storageApi } from '@api/client';
import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import stores from '../stores';

const Download: React.FC = () => {
  const [recentRooms, setRecentRooms] = useState(stores.rooms.getRecentRooms());
  const refreshRooms = useCallback(
    () => setRecentRooms(stores.rooms.getRecentRooms()),
    [],
  );

  const navigate = useNavigate();
  return (
    <div
      className={clsx(
        'w-full h-screen flex items-center justify-center',
        'flex-col gap-y-8',
      )}
    >
      <p className="text-4xl font-semibold">My Recent Recordings</p>
      <hr className="w-96" />
      {recentRooms.length === 0 ? (
        <p className="text-lg">No recent recordings</p>
      ) : (
        <ul className="flex flex-col gap-y-3 w-96">
          <p className="text-gray-400 italic text-center select-none">
            Click to download as ZIP file
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
              onClick={() => storageApi.downloadRecordings(room)}
            >
              <span>Room {room}</span>
              <Icon
                className={clsx(
                  'text-xl',
                  'transition-colors duration-500',
                  'group-hover:text-blue-600',
                )}
                icon="tabler:download"
              />
            </li>
          ))}
        </ul>
      )}
      {recentRooms.length > 0 && (
        <button
          className={clsx(
            'bg-red-500 hover:bg-red-600 text-white',
            'flex gap-x-2 items-center',
            'px-4 py-2 rounded-lg font-semibold',
          )}
          onClick={() => {
            if (
              window.confirm('Are you sure you want to clear all recordings?')
            ) {
              stores.rooms.clearRecentRooms();
              refreshRooms();
            }
          }}
        >
          <Icon icon="tabler:trash" className="text-xl" />
          <span>Clear All</span>
        </button>
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

export default Download;
export const Component = Download;
Component.displayName = 'Download';
