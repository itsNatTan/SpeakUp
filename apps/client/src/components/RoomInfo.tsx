import { msToHMS } from '../utils/time';

type Props = {
  roomCode: string;
  timeRemaining: number;
};

const RoomInfo: React.FC<Props> = ({ roomCode, timeRemaining }) => {
  const [hours, minutes, seconds] = msToHMS(timeRemaining);
  return (
    <>
      <h1 className="text-xl font-bold">Room Code:</h1>
      <p className="font-mono text-4xl">{roomCode}</p>
      <p>Time Remaining:</p>
      <p className="font-bold text-2xl">
        {hours.toString().padStart(2, '0')}:
        {minutes.toString().padStart(2, '0')}:
        {seconds.toString().padStart(2, '0')}
      </p>
    </>
  );
};

export default RoomInfo;
