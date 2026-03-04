// src/pages/Listen.tsx (or wherever this file lives)
import { roomsApi } from '@api/client';
import { Room } from '@api/client/types';
import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Analytics from '../components/Analytics';
import DefaultModeModal from '../components/DefaultModeModal';
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
    setQueueSortMode,
    forceMediaRecorderFallback,
    forceWebRTC,
    setDefaultAudioMode,
    audioMode,
  } = useWebRTCAudio(`${WS_PROTOCOL}://${SERVER_HOST}/ws/${roomCode}`);
  
  const [queueOpen, setQueueOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [defaultModeOpen, setDefaultModeOpen] = useState(false);
  const [defaultMode, setDefaultMode] = useState<'webrtc' | 'mediarecorder'>('webrtc');

  const handleDefaultModeChange = useCallback((mode: 'webrtc' | 'mediarecorder') => {
    setDefaultMode(mode);
    setDefaultAudioMode(mode);
  }, [setDefaultAudioMode]);

  const handleClick = useCallback(() => {
    if (listening) {
      stopListening();
    } else {
      setDefaultAudioMode(defaultMode);
      listen();
    }
  }, [listen, listening, stopListening, setDefaultAudioMode, defaultMode]);

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

        {/* Skip Speaker button */}
        <button
          type="button"
          className={clsx(
            'px-5 py-2.5 rounded-lg font-semibold transition-all duration-200 shadow-sm border',
            listening && !cooldown
              ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-600'
              : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
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
        {/* Switch current speaker: MediaRecorder / WebRTC */}
        {listening && playing && (
          <div className="flex flex-col gap-1.5 items-center">
            <span className="text-sm text-gray-500">Switch current speaker:</span>
            <div className="flex gap-2">
              <button
                type="button"
                className={clsx(
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                  audioMode === 'webrtc'
                    ? 'bg-slate-500 hover:bg-slate-600 text-white border-slate-600'
                    : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                )}
                disabled={audioMode === 'mediarecorder'}
                onClick={forceMediaRecorderFallback}
                title={audioMode === 'webrtc' ? 'Force MediaRecorder' : 'Already using MediaRecorder'}
              >
                <span className="flex items-center gap-1.5">
                  <Icon icon="tabler:record" className="w-4 h-4" />
                  MediaRecorder
                </span>
              </button>
              <button
                type="button"
                className={clsx(
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                  audioMode === 'mediarecorder'
                    ? 'bg-blue-500 hover:bg-blue-600 text-white border-blue-600'
                    : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                )}
                disabled={audioMode === 'webrtc'}
                onClick={forceWebRTC}
                title={audioMode === 'mediarecorder' ? 'Switch to WebRTC' : 'Already using WebRTC'}
              >
                <span className="flex items-center gap-1.5">
                  <Icon icon="tabler:antenna" className="w-4 h-4" />
                  WebRTC
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Hint who we're hearing */}
      {listening && playing && <p>Listening to {playing}&hellip;</p>}

      <audio ref={ref} preload="auto" />
      <button
        type="button"
        className="px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-lg transition-all duration-200 shadow-sm border border-red-600"
        onClick={() => navigate('/')}
      >
        Leave
      </button>

      {/* Queue Management, Analytics, and Settings - Stacked */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-3">
        <QueueManagement
          queueInfo={queueInfo}
          onKickUser={kickUser}
          onReorderUser={reorderUser}
          onMoveToPosition={moveUserToPosition}
          onSetSortMode={setQueueSortMode}
          isOpen={queueOpen}
          onToggle={() => setQueueOpen(!queueOpen)}
        />
        <Analytics
          roomCode={roomCode}
          isOpen={analyticsOpen}
          onToggle={() => setAnalyticsOpen(!analyticsOpen)}
        />
        <DefaultModeModal
          defaultMode={defaultMode}
          onDefaultModeChange={handleDefaultModeChange}
          isOpen={defaultModeOpen}
          onToggle={() => setDefaultModeOpen(!defaultModeOpen)}
        />
      </div>
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
