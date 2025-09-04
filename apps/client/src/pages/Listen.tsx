import { roomsApi } from '@api/client';
import { Room } from '@api/client/types';
import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import RoomInfo from '../components/RoomInfo';
import { useLiveAudio } from '../hooks/useLiveAudio';
import { SERVER_HOST, WS_PROTOCOL } from '../utils/constants';

type Props = {
  roomCode: string;
  expiresAt: Date;
};

const ListenBody: React.FC<Props> = ({ roomCode, expiresAt }) => {
  const {
    ref,
    listening,
    playing,
    listen,
    stop: stopListening,
    skip,
  } = useLiveAudio(`${WS_PROTOCOL}://${SERVER_HOST}/${roomCode}`);

  const handleClick = useCallback(() => {
    if (listening) {
      stopListening();
    } else {
      listen();
    }
  }, [listen, listening, stopListening]);

  const navigate = useNavigate();
  const [timeRemaining, setTimeRemaining] = useState(
    expiresAt.getTime() - Date.now(),
  );
  useEffect(() => {
    const interval = setInterval(() => {
      const updated = expiresAt.getTime() - Date.now();
      setTimeRemaining(updated);
      if (updated <= 0) {
        stopListening();
        navigate('/');
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, navigate, stopListening]);

  return (
    <div className="w-full h-screen flex flex-col justify-center items-center gap-y-4">
      <RoomInfo roomCode={roomCode} timeRemaining={timeRemaining} />
      <hr className="w-96 mx-auto" />
      <div className="flex flex-col gap-y-4 justify-center items-center h-96">
        <button
          className={clsx(
            'w-40 h-40 rounded-full text-white font-bold',
            'text-7xl flex justify-center items-center',
            'transition-colors duration-500',
            listening ? 'bg-green-500' : 'bg-red-500',
          )}
          onClick={handleClick}
        >
          <Icon icon={listening ? 'tabler:volume' : 'tabler:volume-off'} />
        </button>
        <button
          className={clsx(
            'w-40 h-40 rounded-full text-white font-bold',
            'text-7xl flex justify-center items-center',
            'transition-colors duration-500',
          )}
          onClick={skip}
        >
          Skip 
        </button>
        <p>{listening ? <>Tuning in&hellip;</> : 'Everyone is muted'}</p>
      </div>
      {/*
        TODO: Find better way to resolve premature audio cutting,
        causing indication despite absence of audio playing.
       */}
      {listening && playing && <p>Listening to {playing}&hellip;</p>}
      <audio ref={ref} />
      <button
        className={clsx(
          'px-4 py-2 bg-red-500 text-white',
          'font-semibold',
          'hover:bg-red-600 rounded-lg',
        )}
        onClick={() => navigate('/')}
      >
        Leave
      </button>
    </div>
  );
};

const Listen: React.FC = () => {
  const { room: roomCode } = useParams<{ room: string }>();

  const navigate = useNavigate();
  const [room, setRoom] = useState<Room>();
  useEffect(() => {
    const getTtl = async () => {
      const room = await roomsApi.joinRoom(roomCode!);
      if (!room) {
        navigate('/create');
      }
      setRoom(room!);
    };
    getTtl();
  }, [navigate, roomCode]);

  if (!room) {
    return (
      <div className="w-full h-screen flex flex-col justify-center items-center gap-y-4">
        <p>Loading&hellip;</p>
      </div>
    );
  }

  return <ListenBody roomCode={room.code} expiresAt={room.expiredAt} />;
};

export default Listen;
export const Component = Listen;
Component.displayName = 'Listen';
