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

  const { state, connected, send, beginStream, endStream } = useStreaming(
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
      setTimeRemaining(Number.MAX_SAFE_INTEGER);
    };
  }, [navigate, roomCode]);

  // Start/stop the local recorder only when actively allowed by the server
  const [transmitting, setTransmitting] = useState(false);
  useEffect(() => {
    if (transmitting && state === 'on') {
      start();   // begin timesliced chunks -> send()
    } else {
      stop();    // stop recorder + tracks
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, transmitting]);

  if (!username) {
    return <Navigate to="/join" />;
  }

  // Mic prewarm: on first "Join queue" tap, ask for permission so CTS can start instantly
  const prewarmMic = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop()); // release immediately; actual recorder starts on CTS
    } catch {
      // user denied; your UI may want to show a tip
    }
  };

  const buttonDisabled =
    !connected || (state === 'waiting' && transmitting) || timeRemaining <= 0;

  return (
    <div className="space-y-4 text-center">
      <Header username={username} />
      <RoomInfo roomCode={roomCode!} timeRemaining={timeRemaining} />
      <hr className="w-96 mx-auto" />

      <div className="flex flex-col gap-y-4 justify-center items-center h-96">
        <button
          className={clsx(
            'w-40 h-40 rounded-full text-white font-bold',
            'text-7xl flex justify-center items-center transition-colors',
            state === 'on' && 'bg-green-500',
            state === 'waiting' && 'bg-orange-500',
            state === 'off' && 'bg-blue-500',
          )}
          disabled={buttonDisabled}
          onClick={async () => {
            if (!transmitting) {
              await prewarmMic();  // iOS: request once, then CTS starts instantly
              beginStream();       // sends RTS<username>, state -> 'waiting'
            } else {
              endStream();         // sends STOP, state -> 'off'
            }
            setTransmitting(prev => !prev);
          }}
          title={!connected ? 'Connecting to server…' : undefined}
        >
          <Icon icon="tabler:microphone" />
        </button>

        <p className="text-sm opacity-70">
          WS: {connected ? 'connected' : 'connecting…'} • State: {state}
        </p>
      </div>

      <button
        className={clsx(
          'px-4 py-2 bg-red-500 text-white font-semibold hover:bg-red-600 rounded-lg',
        )}
        onClick={() => {
          try { endStream(); } catch {}
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
