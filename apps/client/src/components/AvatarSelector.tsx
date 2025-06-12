import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import {
  generateName,
  getColor,
  getColorClasses,
  getIcon,
} from '../utils/names';

type Props = {
  onSubmit: (username: string) => void;
  onCancel?: () => void;
};

const AvatarSelector: React.FC<Props> = ({ onSubmit, onCancel }) => {
  const [username, setUsername] = useState(generateName());
  const [value, setValue] = useState('');
  const icon = useMemo(() => getIcon(username), [username]);
  const { background, foreground, border } = getColorClasses(
    getColor(username),
  );

  useEffect(() => {
    setValue('');
    // Print letter by letter
    let i = 0;
    const interval = setInterval(() => {
      setValue(username.slice(0, i));
      i++;
      if (i > username.length) {
        clearInterval(interval);
      }
    }, 20);
  }, [username]);

  return (
    <div className="flex flex-col gap-y-8 items-center justify-center">
      <div
        className={clsx(
          'transition-colors duration-500',
          'text-9xl rounded-full w-48 h-48 flex justify-center items-center',
          'overflow-clip',
          background,
          'border-8',
          border,
        )}
      >
        <Icon
          inline
          icon={icon}
          style={{ opacity: value.length / username.length }}
          className={foreground}
        />
      </div>
      <div className="flex gap-x-2">
        <input
          className="text-lg font-medium bg-gray-100 rounded-lg px-4 py-2 text-gray-500"
          type="text"
          readOnly
          value={value}
        />
        <button
          className={clsx(
            'text-2xl text-white rounded-lg px-3 py-2',
            'bg-blue-500 hover:bg-blue-700',
          )}
          onClick={() => setUsername(generateName())}
        >
          <Icon icon="tabler:refresh" className="text-white" />
        </button>
      </div>
      <div className="flex gap-x-2">
        <button
          className={clsx(
            'px-4 py-2 bg-blue-500 text-white',
            'rounded-lg font-medium',
            'hover:bg-blue-600 rounded-xl',
          )}
          onClick={() => onSubmit(username)}
        >
          Let's Go!
        </button>
        {onCancel && (
          <button
            className={clsx(
              'px-4 py-2 bg-red-500 text-white',
              'rounded-lg font-medium',
              'hover:bg-red-600 rounded-xl',
            )}
            onClick={onCancel}
          >
            Back
          </button>
        )}
      </div>
    </div>
  );
};

export default AvatarSelector;
