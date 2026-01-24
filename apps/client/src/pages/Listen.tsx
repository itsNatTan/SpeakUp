// src/pages/Listen.tsx (or wherever this file lives)
import { roomsApi } from '@api/client';
import { Room } from '@api/client/types';
import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import QueueManagement from '../components/QueueManagement';
import RoomInfo from '../components/RoomInfo';
import { useWebRTCAudio } from '../hooks/useWebRTCAudio';
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
    queueInfo,
    kickUser,
    reorderUser,
    moveUserToPosition,
  } = useWebRTCAudio(`${WS_PROTOCOL}://${SERVER_HOST}/ws/${roomCode}`);
  
  const [queueOpen, setQueueOpen] = useState(false);

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

  // Optional: Keyboard shortcut "S" to skip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 's' || e.key === 'S') && listening) {
        e.preventDefault();
        skip(); // Skip works as long as listening, doesn't need playing
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening, skip]);

  // Optional UI guard to avoid spam clicking
  const [cooldown, setCooldown] = useState(false);
  const handleSkip = useCallback(() => {
    // Skip should work as long as we're listening - doesn't need playing to be set
    // This allows skipping even before first connection is established
    if (!listening || cooldown) return;
    skip();
    setCooldown(true);
    // brief cooldown to avoid accidental double-skips
    setTimeout(() => setCooldown(false), 500);
    // small haptic hint on supported devices
    (navigator as any).vibrate?.(10);
  }, [listening, cooldown, skip]);

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
          aria-label={listening ? 'Stop listening' : 'Start listening'}
        >
          <Icon icon={listening ? 'tabler:volume' : 'tabler:volume-off'} />
        </button>

        <p>{listening ? <>Tuning in&hellip;</> : 'Everyone is muted'}</p>

        {/* NEW: Skip Speaker button */}
        <button
          className={clsx(
            'px-4 py-2 rounded-lg font-semibold transition-colors',
            listening && !cooldown
              ? 'bg-amber-500 hover:bg-amber-600 text-white'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          )}
          disabled={!listening || cooldown}
          onClick={handleSkip}
          aria-disabled={!listening || cooldown}
          aria-label="Skip current speaker"
          title={listening ? 'Skip (S)' : 'Start listening to enable skip'}
        >
          <div className="flex items-center gap-2">
            <Icon icon="tabler:player-skip-forward" />
            <span>Skip speaker (S)</span>
          </div>
        </button>
      </div>

      {/* Hint who we're hearing */}
      {listening && playing && <p>Listening to {playing}&hellip;</p>}

      <audio ref={ref} preload="auto" />
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

      {/* Queue Management - Always visible */}
      <QueueManagement
        queueInfo={queueInfo}
        onKickUser={kickUser}
        onReorderUser={reorderUser}
        onMoveToPosition={moveUserToPosition}
        isOpen={queueOpen}
        onToggle={() => setQueueOpen(!queueOpen)}
      />
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
