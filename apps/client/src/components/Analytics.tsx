import { Icon } from '@iconify/react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { SERVER_HOST, SERVER_PROTOCOL } from '../utils/constants';

type SpeakerStats = {
  username: string;
  totalSpeaks: number;
  totalSpeakingTime: number;
  averageSpeakingTime: number;
  queueJoins: number;
  queueLeaves: number;
  timesKicked: number;
  priorityChanges: number;
  firstSpokeAt?: string;
  lastSpokeAt?: string;
};

type AnalyticsSummary = {
  roomCode: string;
  uniqueSpeakers: number;
  totalSpeaks: number;
  averageSpeaksPerSpeaker: string;
  totalSpeakingTime: number;
  totalSpeakingTimeMinutes: string;
  averageSpeakingTime: number;
  averageSpeakingTimeSeconds: string;
  queueJoins: number;
  queueLeaves: number;
  kicks: number;
  priorityChanges: number;
  topSpeakers: Array<{
    username: string;
    totalSpeaks: number;
    totalSpeakingTime: number;
    averageSpeakingTime: number;
  }>;
};

type AnalyticsProps = {
  roomCode: string;
  isOpen: boolean;
  onToggle: () => void;
};

const Analytics: React.FC<AnalyticsProps> = ({ roomCode, isOpen, onToggle }) => {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [stats, setStats] = useState<SpeakerStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, statsRes] = await Promise.all([
        fetch(`${SERVER_PROTOCOL}://${SERVER_HOST}/api/v1/analytics/${roomCode}/summary`),
        fetch(`${SERVER_PROTOCOL}://${SERVER_HOST}/api/v1/analytics/${roomCode}/stats`),
      ]);

      if (!summaryRes.ok || !statsRes.ok) {
        throw new Error('Failed to fetch analytics');
      }

      const summaryData = await summaryRes.json();
      const statsData = await statsRes.json();

      setSummary(summaryData);
      setStats(statsData.stats || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
      console.error('Analytics fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchAnalytics();
      // Refresh every 5 seconds when open
      const interval = setInterval(fetchAnalytics, 5000);
      return () => clearInterval(interval);
    }
  }, [isOpen, roomCode]);

  const handleExportCSV = async () => {
    try {
      const response = await fetch(`${SERVER_PROTOCOL}://${SERVER_HOST}/api/v1/analytics/${roomCode}/export`);
      if (!response.ok) throw new Error('Failed to export CSV');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `analytics-${roomCode}-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('CSV export error:', err);
      alert('Failed to export CSV');
    }
  };

  const formatTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  };

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className={clsx(
          'w-14 h-14 rounded-full shadow-lg flex items-center justify-center',
          'transition-all duration-200',
          'bg-white hover:bg-gray-100 text-gray-700 border-2 border-gray-300'
        )}
        aria-label="Open analytics"
        title="Analytics"
      >
        <Icon icon="tabler:chart-bar" className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b bg-gray-50">
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Icon icon="tabler:chart-bar" className="w-6 h-6" />
            Analytics Dashboard
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 bg-green-500 text-white rounded hover:bg-green-600 flex items-center gap-2 text-sm"
              title="Export to CSV"
            >
              <Icon icon="tabler:download" className="w-4 h-4" />
              Export CSV
            </button>
            <button
              onClick={onToggle}
              className="px-3 py-1.5 bg-gray-300 hover:bg-gray-400 rounded text-sm"
            >
              Close
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && !summary && (
            <div className="flex items-center justify-center py-8">
              <div className="text-gray-500">Loading analytics...</div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          {summary && (
            <>
              {/* Summary Cards - 3x2 Grid */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                {/* Top Row */}
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                  <div className="text-sm text-gray-600">Unique Speakers</div>
                  <div className="text-2xl font-bold text-blue-600">{summary.uniqueSpeakers}</div>
                </div>
                <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                  <div className="text-sm text-gray-600">Total Speaks</div>
                  <div className="text-2xl font-bold text-green-600">{summary.totalSpeaks}</div>
                </div>
                <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                  <div className="text-sm text-gray-600">Total Speaking Time</div>
                  <div className="text-2xl font-bold text-purple-600">{summary.totalSpeakingTimeMinutes} min</div>
                </div>
                
                {/* Bottom Row */}
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <div className="text-sm text-gray-600">Queue Joins</div>
                  <div className="text-2xl font-bold text-gray-700">{summary.queueJoins}</div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <div className="text-sm text-gray-600">Queue Leaves</div>
                  <div className="text-2xl font-bold text-gray-700">{summary.queueLeaves}</div>
                </div>
                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                  <div className="text-sm text-gray-600">Avg Speaking Time</div>
                  <div className="text-2xl font-bold text-orange-600">{summary.averageSpeakingTimeSeconds}s</div>
                </div>
              </div>

              {/* Top Speakers */}
              {summary.topSpeakers.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-lg font-semibold mb-3">Top 5 Speakers</h3>
                  <div className="space-y-2">
                    {summary.topSpeakers.map((speaker, idx) => (
                      <div key={speaker.username} className="flex items-center justify-between p-3 bg-gray-50 rounded border">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold">
                            {idx + 1}
                          </div>
                          <div>
                            <div className="font-semibold">{speaker.username}</div>
                            <div className="text-sm text-gray-600">
                              {speaker.totalSpeaks} speaks • {formatTime(speaker.totalSpeakingTime)} total
                            </div>
                          </div>
                        </div>
                        <div className="text-sm text-gray-600">
                          Avg: {formatTime(speaker.averageSpeakingTime)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Detailed Stats Table */}
              <div>
                <h3 className="text-lg font-semibold mb-3">Detailed Statistics</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full border-collapse border border-gray-300">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="border border-gray-300 px-4 py-2 text-left">Username</th>
                        <th className="border border-gray-300 px-4 py-2 text-center">Speaks</th>
                        <th className="border border-gray-300 px-4 py-2 text-center">Total Time</th>
                        <th className="border border-gray-300 px-4 py-2 text-center">Avg Time</th>
                        <th className="border border-gray-300 px-4 py-2 text-center">Queue Joins</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((stat) => (
                        <tr key={stat.username} className="hover:bg-gray-50">
                          <td className="border border-gray-300 px-4 py-2 font-medium">{stat.username}</td>
                          <td className="border border-gray-300 px-4 py-2 text-center">{stat.totalSpeaks}</td>
                          <td className="border border-gray-300 px-4 py-2 text-center">{formatTime(stat.totalSpeakingTime)}</td>
                          <td className="border border-gray-300 px-4 py-2 text-center">{formatTime(stat.averageSpeakingTime)}</td>
                          <td className="border border-gray-300 px-4 py-2 text-center">{stat.queueJoins}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Analytics;
