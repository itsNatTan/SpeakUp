import { Icon } from '@iconify/react/dist/iconify.js';
import clsx from 'clsx';
import { useMemo } from 'react';
import { getColor, getColorClasses, getIcon } from '../utils/names';

type Props = {
  username: string;
};

const Header: React.FC<Props> = ({ username }) => {
  const icon = useMemo(() => getIcon(username), [username]);
  const { background, foreground, border } = useMemo(
    () => getColorClasses(getColor(username)),
    [username],
  );

  return (
    <div className="w-full h-28 flex gap-x-4 justify-start items-center px-4 py-3 shadow">
      <div
        className={clsx(
          'transition-colors duration-500',
          'text-5xl rounded-full w-16 h-16 flex justify-center items-center',
          'overflow-clip',
          background,
          'border-2',
          border,
        )}
      >
        <Icon inline icon={icon} className={foreground} />
      </div>
      <div className="flex flex-col justify-center items-start gap-y-1">
        <strong className="text-lg leading-none">Hello,</strong>
        <span className="text-2xl leading-none">{username}</span>
      </div>
    </div>
  );
};

export default Header;
