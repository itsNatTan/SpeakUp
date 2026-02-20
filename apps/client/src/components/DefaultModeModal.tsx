import { Icon } from '@iconify/react';
import clsx from 'clsx';

type Props = {
  defaultMode: 'webrtc' | 'mediarecorder';
  onDefaultModeChange: (mode: 'webrtc' | 'mediarecorder') => void;
  isOpen: boolean;
  onToggle: () => void;
};

const DefaultModeModal: React.FC<Props> = ({
  defaultMode,
  onDefaultModeChange,
  isOpen,
  onToggle,
}) => {
  return (
    <div className="relative">
      {/* Toggle Button - Same style as Analytics/Queue */}
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'w-14 h-14 rounded-full shadow-lg flex items-center justify-center',
          'transition-all duration-200',
          isOpen
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-white hover:bg-gray-100 text-gray-700 border-2 border-gray-300'
        )}
        aria-label={isOpen ? 'Close settings' : 'Open settings'}
        title="Audio settings"
      >
        <Icon icon="tabler:settings" className="w-6 h-6" />
      </button>

      {/* Modal - Above button when open */}
      {isOpen && (
        <div className="absolute bottom-16 right-0 w-72 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden flex flex-col z-50">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Icon icon="tabler:antenna" className="w-5 h-5" />
                Default audio mode
              </h3>
              <button
                type="button"
                onClick={onToggle}
                className="px-3 py-1.5 bg-gray-300 hover:bg-gray-400 rounded text-sm"
              >
                Close
              </button>
            </div>
          </div>
          <div className="p-4">
            <p className="text-sm text-gray-600 mb-3">
              Choose the default for new speakers when they join:
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={clsx(
                  'flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200',
                  'border',
                  defaultMode === 'webrtc'
                    ? 'bg-blue-500 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400 hover:bg-gray-50'
                )}
                onClick={() => onDefaultModeChange('webrtc')}
              >
                <span className="flex items-center justify-center gap-2">
                  <Icon icon="tabler:antenna" className="w-4 h-4" />
                  WebRTC
                </span>
              </button>
              <button
                type="button"
                className={clsx(
                  'flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200',
                  'border',
                  defaultMode === 'mediarecorder'
                    ? 'bg-blue-500 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400 hover:bg-gray-50'
                )}
                onClick={() => onDefaultModeChange('mediarecorder')}
              >
                <span className="flex items-center justify-center gap-2">
                  <Icon icon="tabler:record" className="w-4 h-4" />
                  MediaRecorder
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DefaultModeModal;
