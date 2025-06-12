import clsx from 'clsx';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_REGEX = /^[A-Z]{3}[0-9]{3}$/;
const ROOM_CODE_ALLOWED_CHARACTERS = /^[A-Za-z0-9]+$/;

const errorMessages = {
  invalid:
    'Invalid room code. Room code must be 3 letters followed by 3 numbers.',
  invalidParam: 'Invalid room code in URL. Please enter a room code manually.',
  invalidCharacter: 'Invalid character. Room code must be alphanumeric.',
  length: `Room code must be ${ROOM_CODE_LENGTH} characters`,
};

export type RoomInputApi = { clear: () => void };

type Props = {
  defaultValue: string | null;
  onSubmit: (roomCode: string) => void;
  submitText?: string;
  api?: React.RefObject<RoomInputApi>;
};

const RoomCodeInput: React.FC<Props> = ({
  defaultValue,
  onSubmit,
  submitText,
  api,
}) => {
  const [error, setError] = useState<string>();
  const ref = useRef<Record<number, HTMLInputElement>>({});

  useEffect(() => {
    // Check if the room code is valid
    if (defaultValue && !ROOM_CODE_REGEX.test(defaultValue)) {
      setError(errorMessages.invalidParam);
      Object.values(ref.current).forEach((el) => {
        el.value = '';
      });
    }
  }, [defaultValue]);

  useImperativeHandle(api, () => ({
    clear() {
      Object.values(ref.current).forEach((el) => {
        el.value = '';
      });
      setError(undefined);
    },
  }));

  const getRoomCode = useCallback(() => {
    setError(undefined);

    const roomCode = Array.from({ length: ROOM_CODE_LENGTH })
      .map((_, i) => {
        const value = ref.current[i]?.value;
        if (!value) {
          setError(errorMessages.length);
          return '';
        }
        return value;
      })
      .join('');

    if (!ROOM_CODE_REGEX.test(roomCode)) {
      setError(errorMessages.invalid);
      return;
    }

    return roomCode;
  }, []);

  const handleSubmit = useCallback(() => {
    const roomCode = getRoomCode();
    if (roomCode) {
      onSubmit(roomCode);
    }
  }, [getRoomCode, onSubmit]);

  return (
    <div className="flex flex-col gap-y-4 justify-center items-center">
      <div className="flex gap-x-4 justify-center items-center">
        {Array.from({ length: ROOM_CODE_LENGTH }).map((_, i) => (
          <input
            key={i}
            autoFocus={i === 0}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={clsx(
              'px-3 py-2 rounded-lg border border-gray-300',
              'font-mono text-3xl',
              'bg-gray-200 text-center rounded-xl',
              'tracking-wider',
            )}
            defaultValue={defaultValue?.[i] ?? ''}
            maxLength={1}
            ref={(el) => {
              if (el) {
                ref.current[i] = el;
              }
            }}
            readOnly={!submitText}
            size={1}
            type="text"
            onKeyDown={(e) => {
              // Backspace
              if (
                e.currentTarget.value === '' &&
                e.key === 'Backspace' &&
                i > 0
              ) {
                ref.current[i - 1]?.focus();
                return;
              }
              // Enter
              if (e.key === 'Enter' && submitText) {
                handleSubmit();
              }
            }}
            onInput={(e) => {
              setError(undefined);
              if (e.currentTarget.value.length > 1) {
                e.currentTarget.value = e.currentTarget.value[0];
                return;
              }
              if (
                e.currentTarget.value &&
                !ROOM_CODE_ALLOWED_CHARACTERS.test(e.currentTarget.value)
              ) {
                e.currentTarget.value = '';
                setError(errorMessages.invalidCharacter);
                return;
              }

              // Valid Input
              e.currentTarget.value = e.currentTarget.value.toUpperCase();
              if (e.currentTarget.value.length === 1) {
                ref.current[i + 1]?.focus();
              }
            }}
            onPaste={(e) => {
              e.preventDefault();
              setError(undefined);
              const pasteData = e.clipboardData.getData('text').toUpperCase();
              // Only check for invalid characters, rest is checked when submitting
              if (!ROOM_CODE_ALLOWED_CHARACTERS.test(pasteData)) {
                setError(errorMessages.invalidCharacter);
                return;
              }
              Array.from(pasteData).forEach((char, i) => {
                if (ref.current[i]) {
                  ref.current[i].value = char;
                }
              });
              ref.current[
                pasteData.length >= ROOM_CODE_LENGTH
                  ? ROOM_CODE_LENGTH - 1
                  : pasteData.length
              ]?.focus();
            }}
          />
        ))}
      </div>
      {error && <p className="text-red-500">{error}</p>}
      {submitText && (
        <button
          className={clsx(
            'px-4 py-2 bg-blue-500 text-white',
            'rounded-lg font-medium',
            'hover:bg-blue-600 w-96 rounded-xl',
          )}
          onClick={handleSubmit}
        >
          {submitText}
        </button>
      )}
    </div>
  );
};

export default RoomCodeInput;
