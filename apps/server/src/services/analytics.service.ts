type SpeakerEvent = {
  username: string;
  eventType: 'speak_start' | 'speak_end' | 'queue_join' | 'queue_leave' | 'kicked' | 'priority_change';
  timestamp: Date;
  priority?: number;
  duration?: number; // in milliseconds, for speak_end events
};

type SpeakerStats = {
  username: string;
  totalSpeaks: number;
  totalSpeakingTime: number; // in milliseconds
  averageSpeakingTime: number; // in milliseconds
  queueJoins: number;
  queueLeaves: number;
  timesKicked: number;
  priorityChanges: number;
  lastSpokeAt?: Date;
  firstSpokeAt?: Date;
};

class AnalyticsService {
  private events: Map<string, SpeakerEvent[]> = new Map(); // roomCode -> events
  private currentSpeakers: Map<string, Map<string, Date>> = new Map(); // roomCode -> username -> startTime

  recordEvent(roomCode: string, event: SpeakerEvent): void {
    if (!this.events.has(roomCode)) {
      this.events.set(roomCode, []);
    }
    this.events.get(roomCode)!.push(event);

    // Track speaking start/end for duration calculation
    if (event.eventType === 'speak_start') {
      if (!this.currentSpeakers.has(roomCode)) {
        this.currentSpeakers.set(roomCode, new Map());
      }
      this.currentSpeakers.get(roomCode)!.set(event.username, event.timestamp);
    } else if (event.eventType === 'speak_end') {
      const roomSpeakers = this.currentSpeakers.get(roomCode);
      if (roomSpeakers) {
        const startTime = roomSpeakers.get(event.username);
        if (startTime) {
          event.duration = event.timestamp.getTime() - startTime.getTime();
          roomSpeakers.delete(event.username);
        }
      }
    }
  }

  getStats(roomCode: string): SpeakerStats[] {
    const events = this.events.get(roomCode) || [];
    const statsMap = new Map<string, SpeakerStats>();

    events.forEach((event) => {
      if (!statsMap.has(event.username)) {
        statsMap.set(event.username, {
          username: event.username,
          totalSpeaks: 0,
          totalSpeakingTime: 0,
          averageSpeakingTime: 0,
          queueJoins: 0,
          queueLeaves: 0,
          timesKicked: 0,
          priorityChanges: 0,
        });
      }

      const stats = statsMap.get(event.username)!;

      switch (event.eventType) {
        case 'speak_start':
          stats.totalSpeaks++;
          if (!stats.firstSpokeAt) {
            stats.firstSpokeAt = event.timestamp;
          }
          stats.lastSpokeAt = event.timestamp;
          break;
        case 'speak_end':
          if (event.duration) {
            stats.totalSpeakingTime += event.duration;
          }
          break;
        case 'queue_join':
          stats.queueJoins++;
          break;
        case 'queue_leave':
          stats.queueLeaves++;
          break;
        case 'kicked':
          stats.timesKicked++;
          break;
        case 'priority_change':
          stats.priorityChanges++;
          break;
      }
    });

    // Calculate averages
    statsMap.forEach((stats) => {
      if (stats.totalSpeaks > 0) {
        stats.averageSpeakingTime = stats.totalSpeakingTime / stats.totalSpeaks;
      }
    });

    return Array.from(statsMap.values()).sort((a, b) => b.totalSpeaks - a.totalSpeaks);
  }

  getUniqueSpeakers(roomCode: string): number {
    const events = this.events.get(roomCode) || [];
    const uniqueUsernames = new Set(events.map((e) => e.username));
    return uniqueUsernames.size;
  }

  getTotalSpeakingTime(roomCode: string): number {
    const stats = this.getStats(roomCode);
    return stats.reduce((sum, s) => sum + s.totalSpeakingTime, 0);
  }

  getParticipationRate(roomCode: string, totalStudents?: number): number {
    const uniqueSpeakers = this.getUniqueSpeakers(roomCode);
    if (!totalStudents || totalStudents === 0) return 0;
    return (uniqueSpeakers / totalStudents) * 100;
  }

  getAllEvents(roomCode: string): SpeakerEvent[] {
    return this.events.get(roomCode) || [];
  }

  exportToCSV(roomCode: string): string {
    const stats = this.getStats(roomCode);
    const events = this.getAllEvents(roomCode);

    // CSV Header
    let csv = 'Speaker Analytics Export\n';
    csv += `Room Code: ${roomCode}\n`;
    csv += `Export Date: ${new Date().toISOString()}\n`;
    csv += `Unique Speakers: ${this.getUniqueSpeakers(roomCode)}\n`;
    csv += `Total Speaking Time: ${(this.getTotalSpeakingTime(roomCode) / 1000 / 60).toFixed(2)} minutes\n`;
    csv += '\n';

    // Summary Statistics
    csv += '=== Summary Statistics ===\n';
    csv += 'Username,Total Speaks,Total Speaking Time (ms),Average Speaking Time (ms),Queue Joins,Queue Leaves,Times Kicked,Priority Changes,First Spoke At,Last Spoke At\n';
    stats.forEach((stat) => {
      csv += `${stat.username},${stat.totalSpeaks},${stat.totalSpeakingTime},${stat.averageSpeakingTime.toFixed(2)},${stat.queueJoins},${stat.queueLeaves},${stat.timesKicked},${stat.priorityChanges},${stat.firstSpokeAt?.toISOString() || ''},${stat.lastSpokeAt?.toISOString() || ''}\n`;
    });

    csv += '\n';

    // Event Log
    csv += '=== Event Log ===\n';
    csv += 'Timestamp,Username,Event Type,Priority,Duration (ms)\n';
    events.forEach((event) => {
      csv += `${event.timestamp.toISOString()},${event.username},${event.eventType},${event.priority || ''},${event.duration || ''}\n`;
    });

    return csv;
  }

  clearRoom(roomCode: string): void {
    this.events.delete(roomCode);
    this.currentSpeakers.delete(roomCode);
  }
}

export const analyticsService = new AnalyticsService();
export type { SpeakerEvent, SpeakerStats };
