import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useCallback, useState } from 'react';

type QueueUser = {
  username: string;
  key: string;
  priority: number;
  joinTime: string | Date;
};

type QueueInfo = {
  queue: QueueUser[];
  currentSpeaker: string | null;
  currentSpeakerPriority?: number;
  queueSize: number;
  sortMode?: 'fifo' | 'priority';
};

type Props = {
  queueInfo: QueueInfo;
  onKickUser: (username: string) => void;
  onReorderUser?: (username: string, direction: 'up' | 'down') => void;
  onMoveToPosition?: (username: string, newPosition: number) => void;
  onSetSortMode?: (mode: 'fifo' | 'priority') => void;
  isOpen: boolean;
  onToggle: () => void;
};

type SortMode = 'fifo' | 'priority';

const QueueManagement: React.FC<Props> = ({
  queueInfo,
  onKickUser,
  onReorderUser,
  onMoveToPosition,
  onSetSortMode,
  isOpen,
  onToggle,
}) => {
  const [draggedUser, setDraggedUser] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const sortMode = queueInfo.sortMode || 'fifo';

  const handleKick = useCallback(
    (username: string) => {
      if (window.confirm(`Are you sure you want to remove ${username} from the queue?`)) {
        onKickUser(username);
      }
    },
    [onKickUser]
  );

  const handleDragStart = useCallback((e: React.DragEvent, username: string) => {
    setDraggedUser(username);
    e.dataTransfer.effectAllowed = 'move';
    // Add a slight opacity to the dragged element
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setDraggedUser(null);
    setDragOverIndex(null);
    // Reset opacity
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    
    if (!draggedUser || !onMoveToPosition) return;
    
    // Calculate the actual queue position (accounting for current speaker)
    const actualQueueIndex = queueInfo.currentSpeaker ? dropIndex - 1 : dropIndex;
    
    // Don't allow dropping on current speaker or invalid positions
    if (dropIndex === 0 && queueInfo.currentSpeaker) return;
    if (actualQueueIndex < 0) return;
    
    onMoveToPosition(draggedUser, actualQueueIndex);
    setDraggedUser(null);
  }, [draggedUser, onMoveToPosition, queueInfo.currentSpeaker]);

  // Filter out current speaker from queue to avoid double counting
  // Queue is already sorted on server based on sortMode
  const queueWithoutCurrent = queueInfo.currentSpeaker
    ? queueInfo.queue.filter((u) => u.username !== queueInfo.currentSpeaker)
    : queueInfo.queue;

  // Combine current speaker (if any) with queue
  const allUsers = queueInfo.currentSpeaker
    ? [
        { 
          username: queueInfo.currentSpeaker, 
          isCurrentSpeaker: true, 
          key: `current-${queueInfo.currentSpeaker}`,
          priority: queueInfo.currentSpeakerPriority ?? 0,
        },
        ...queueWithoutCurrent.map((u) => ({ ...u, isCurrentSpeaker: false })),
      ]
    : queueWithoutCurrent.map((u) => ({ ...u, isCurrentSpeaker: false }));

  const getPriorityLabel = (priority: number) => {
    switch (priority) {
      case 3: return 'Urgent';
      case 2: return 'High';
      case 1: return 'Medium';
      default: return 'Normal';
    }
  };

  const getPriorityColor = (priority: number) => {
    switch (priority) {
      case 3: return 'bg-red-100 text-red-700 border-red-300';
      case 2: return 'bg-orange-100 text-orange-700 border-orange-300';
      case 1: return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      default: return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {/* Toggle Button */}
      <button
        onClick={onToggle}
        className={clsx(
          'w-14 h-14 rounded-full shadow-lg flex items-center justify-center',
          'transition-all duration-200',
          isOpen
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-white hover:bg-gray-100 text-gray-700 border-2 border-gray-300'
        )}
        aria-label={isOpen ? 'Close queue' : 'Open queue'}
        title={`Queue (${queueInfo.queueSize})`}
      >
        <Icon
          icon={isOpen ? 'tabler:x' : 'tabler:users'}
          className="w-6 h-6"
        />
        {!isOpen && queueInfo.queueSize > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
            {queueInfo.queueSize}
          </span>
        )}
      </button>

      {/* Queue Panel */}
      {isOpen && (
        <div className="absolute bottom-16 right-0 w-80 bg-white rounded-lg shadow-xl border border-gray-200 max-h-96 overflow-hidden flex flex-col">
          {/* Header */}
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="font-semibold text-gray-900">Speaker Queue</h3>
                <p className="text-sm text-gray-500">
                  {queueInfo.queueSize} {queueInfo.queueSize === 1 ? 'person' : 'people'} waiting
                </p>
              </div>
              {onSetSortMode && (
                <button
                  onClick={() => {
                    const newMode = sortMode === 'fifo' ? 'priority' : 'fifo';
                    onSetSortMode(newMode);
                  }}
                  className={clsx(
                    'px-3 py-1.5 rounded text-sm font-medium transition-colors',
                    'flex items-center gap-1.5',
                    sortMode === 'priority'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  )}
                  title={sortMode === 'fifo' ? 'Sort by priority' : 'Sort by join time'}
                >
                  <Icon icon={sortMode === 'priority' ? 'tabler:sort-descending' : 'tabler:clock'} className="w-4 h-4" />
                  <span>{sortMode === 'priority' ? 'Priority' : 'FIFO'}</span>
                </button>
              )}
            </div>
          </div>

          {/* Queue List */}
          <div className="flex-1 overflow-y-auto p-4">
            {allUsers.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                <Icon icon="tabler:users-off" className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No one in the queue</p>
              </div>
            ) : (
              <div className="space-y-2">
                {allUsers.map((user, index) => (
                  <div
                    key={user.key || user.username}
                    draggable={!user.isCurrentSpeaker && !!onMoveToPosition}
                    onDragStart={(e) => !user.isCurrentSpeaker && handleDragStart(e, user.username)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => !user.isCurrentSpeaker && handleDragOver(e, index)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => !user.isCurrentSpeaker && handleDrop(e, index)}
                    className={clsx(
                      'flex items-center justify-between p-3 rounded-lg border transition-colors',
                      user.isCurrentSpeaker
                        ? 'bg-green-50 border-green-200'
                        : 'bg-gray-50 border-gray-200 hover:bg-gray-100',
                      draggedUser === user.username && 'opacity-50',
                      dragOverIndex === index && !user.isCurrentSpeaker && 'border-blue-400 border-2',
                      !user.isCurrentSpeaker && onMoveToPosition && 'cursor-move'
                    )}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {user.isCurrentSpeaker ? (
                        <Icon
                          icon="tabler:microphone"
                          className="w-5 h-5 text-green-600 flex-shrink-0"
                        />
                      ) : (
                        <>
                          {onMoveToPosition && (
                            <Icon
                              icon="tabler:grip-vertical"
                              className="w-4 h-4 text-gray-400 flex-shrink-0 cursor-move"
                            />
                          )}
                          <span className="text-gray-400 font-semibold text-sm w-6 text-center flex-shrink-0">
                            {queueInfo.currentSpeaker ? index : index + 1}
                          </span>
                        </>
                      )}
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span
                          className={clsx(
                            'font-medium truncate',
                            user.isCurrentSpeaker ? 'text-green-900' : 'text-gray-900'
                          )}
                          title={user.username}
                        >
                          {user.username}
                        </span>
                        {!user.isCurrentSpeaker && user.priority > 0 && (
                          <span
                            className={clsx(
                              'px-1.5 py-0.5 rounded text-xs font-medium border flex-shrink-0',
                              getPriorityColor(user.priority)
                            )}
                            title={`Priority: ${getPriorityLabel(user.priority)}`}
                          >
                            {getPriorityLabel(user.priority)}
                          </span>
                        )}
                        {user.isCurrentSpeaker && (
                          <span className="text-xs text-green-600 font-medium flex-shrink-0">
                            Speaking
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {!user.isCurrentSpeaker && onReorderUser && (
                        <>
                          <button
                            onClick={() => onReorderUser(user.username, 'up')}
                            disabled={index === (queueInfo.currentSpeaker ? 1 : 0)}
                            className={clsx(
                              'p-1 rounded transition-colors flex-shrink-0',
                              index === (queueInfo.currentSpeaker ? 1 : 0)
                                ? 'text-gray-300 cursor-not-allowed'
                                : 'hover:bg-blue-100 text-blue-600 hover:text-blue-700',
                              'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1'
                            )}
                            aria-label={`Move ${user.username} up in queue`}
                            title="Move up"
                          >
                            <Icon icon="tabler:arrow-up" className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => onReorderUser(user.username, 'down')}
                            disabled={index === allUsers.length - 1}
                            className={clsx(
                              'p-1 rounded transition-colors flex-shrink-0',
                              index === allUsers.length - 1
                                ? 'text-gray-300 cursor-not-allowed'
                                : 'hover:bg-blue-100 text-blue-600 hover:text-blue-700',
                              'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1'
                            )}
                            aria-label={`Move ${user.username} down in queue`}
                            title="Move down"
                          >
                            <Icon icon="tabler:arrow-down" className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {!user.isCurrentSpeaker && (
                        <button
                          onClick={() => handleKick(user.username)}
                          className={clsx(
                            'p-1.5 rounded transition-colors flex-shrink-0',
                            'hover:bg-red-100 text-red-600 hover:text-red-700',
                            'focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1'
                          )}
                          aria-label={`Remove ${user.username} from queue`}
                          title="Remove from queue"
                        >
                          <Icon icon="tabler:x" className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default QueueManagement;
