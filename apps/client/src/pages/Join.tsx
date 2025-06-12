import { roomsApi } from '@api/client';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AvatarSelector from '../components/AvatarSelector';
import RoomCodeInput, { RoomInputApi } from '../components/RoomCodeInput';
import stores from '../stores';

const ROOM_CODE_PARAM = 'code';

const Join: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    // Clear the URL
    setSearchParams(new URLSearchParams());
  }, [setSearchParams]);

  const [roomCode, setRoomCode] = useState<string>();
  const checkIsRoomValid = useCallback(async (code: string) => {
    const room = await roomsApi.joinRoom(code);
    if (!room) {
      alert('Room not found!');
      return;
    }
    setRoomCode(code);
  }, []);

  const inputControl = useRef<RoomInputApi>(null);
  const navigate = useNavigate();
  return (
    <div
      className={clsx(
        'w-full h-screen flex items-center justify-center',
        'flex-col gap-y-8',
      )}
    >
      <p className="text-4xl font-semibold">Join a Room</p>
      <RoomCodeInput
        defaultValue={searchParams.get(ROOM_CODE_PARAM)}
        onSubmit={checkIsRoomValid}
        submitText={roomCode ? undefined : 'Join'}
        api={inputControl}
      />
      {roomCode && (
        <>
          <p className="text-2xl font-semibold">
            Now, choose an avatar for yourself&hellip;
          </p>
          <AvatarSelector
            onSubmit={(username) => {
              stores.common.setUsername(username);
              navigate(`/${roomCode}`);
            }}
            // Reset page on cancel
            onCancel={() => {
              setRoomCode(undefined);
              inputControl.current?.clear();
            }}
          />
        </>
      )}
    </div>
  );
};

export default Join;
export const Component = Join;
Component.displayName = 'Join';
