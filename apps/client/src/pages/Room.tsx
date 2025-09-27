import { roomsApi } from '@api/client';
import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import Header from '../components/Header';
import RoomInfo from '../components/RoomInfo';
import { useAudioRecording } from '../hooks/useAudioRecording';
import { useStreaming } from '../hooks/useStreaming';
import stores from '../stores';
import { SERVER_HOST, WS_PROTOCOL } from '../utils/constants';

const Room: React.FC = () => {
  const { room: roomCode } = useParams<{ room: string }>();
  const username = stores.common.getUsername();
  const { state, send, beginStream, endStream } = useStreaming(
    `${WS_PROTOCOL}://${SERVER_HOST}/ws/${roomCode}`,
    username ?? '',
  );
  const { start, stop } = useAudioRecording({ onData: send });
  const navigate = useNavigate();

  const [timeRemaining, setTimeRemaining] = useState(Number.MAX_SAFE_INTEGER);
  useEffect(() => {
    const getTtl = async () => {
      const ttl = await roomsApi.getTtl(roomCode!);
      if (!ttl) {
        stores.common.setUsername(null);
        navigate('/');
        return;
      }
      setTimeRemaining(ttl);
    };
    getTtl();
    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1000) {
          stores.common.setUsername(null);
          navigate('/');
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
    return () => {
      clearInterval(interval);
      // Clean up in case of async races
      setTimeRemaining(Number.MAX_SAFE_INTEGER);
    };
  }, [navigate, roomCode]);

  const [transmitting, setTransmitting] = useState(false);
  useEffect(() => {
    if (transmitting && state === 'on') {
      start();
    } else {
      stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, transmitting]);

  if (!username) {
    return <Navigate to="/join" />;
  }

  return (
    <div className="space-y-4 text-center">
      <Header username={username} />
      <RoomInfo roomCode={roomCode!} timeRemaining={timeRemaining} />
      <hr className="w-96 mx-auto" />
      <div className="flex flex-col gap-y-4 justify-center items-center h-96">
        <button
          className={clsx(
            'w-40 h-40 rounded-full text-white font-bold',
            'text-7xl flex justify-center items-center',
            state === 'on' && 'bg-green-500',
            state === 'waiting' && 'bg-orange-500',
            state === 'off' && 'bg-blue-500',
          )}
          onClick={() => {
            if (!transmitting) {
              beginStream();
            } else {
              endStream();
            }
            setTransmitting((prev) => !prev);
          }}
        >
          <Icon icon="tabler:microphone" />
        </button>
        <p>{state}</p>
      </div>
      <button
        className={clsx(
          'px-4 py-2 bg-red-500 text-white',
          'font-semibold',
          'hover:bg-red-600 rounded-lg',
        )}
        onClick={() => {
          stores.common.setUsername(null);
          navigate('/');
        }}
      >
        Leave
      </button>
    </div>
  );
};
export default Room;
export const Component = Room;
Component.displayName = 'Room';
