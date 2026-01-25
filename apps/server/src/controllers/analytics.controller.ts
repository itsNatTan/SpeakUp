import { Hono } from 'hono';
import { NotFoundError } from '../internal/errors';
import { analyticsService } from '../services/analytics.service';

const r = new Hono().basePath('/api/v1/analytics');

// Get analytics stats for a room
r.get('/:code/stats', (c) => {
  const roomCode = c.req.param('code');
  const stats = analyticsService.getStats(roomCode);
  const uniqueSpeakers = analyticsService.getUniqueSpeakers(roomCode);
  const totalSpeakingTime = analyticsService.getTotalSpeakingTime(roomCode);
  
  return c.json({
    roomCode,
    uniqueSpeakers,
    totalSpeakingTime, // in milliseconds
    totalSpeakingTimeMinutes: totalSpeakingTime / 1000 / 60,
    stats,
  });
});

// Export analytics as CSV
r.get('/:code/export', (c) => {
  const roomCode = c.req.param('code');
  const csv = analyticsService.exportToCSV(roomCode);
  
  // Set headers for CSV download
  c.header('Content-Type', 'text/csv');
  c.header('Content-Disposition', `attachment; filename="analytics-${roomCode}-${Date.now()}.csv"`);
  
  return c.text(csv);
});

// Get summary metrics
r.get('/:code/summary', (c) => {
  const roomCode = c.req.param('code');
  const stats = analyticsService.getStats(roomCode);
  const uniqueSpeakers = analyticsService.getUniqueSpeakers(roomCode);
  const totalSpeakingTime = analyticsService.getTotalSpeakingTime(roomCode);
  const events = analyticsService.getAllEvents(roomCode);
  
  // Calculate additional metrics
  const totalSpeaks = stats.reduce((sum, s) => sum + s.totalSpeaks, 0);
  const averageSpeaksPerSpeaker = uniqueSpeakers > 0 ? totalSpeaks / uniqueSpeakers : 0;
  const averageSpeakingTime = totalSpeaks > 0 ? totalSpeakingTime / totalSpeaks : 0;
  const queueJoins = events.filter(e => e.eventType === 'queue_join').length;
  const queueLeaves = events.filter(e => e.eventType === 'queue_leave').length;
  const kicks = events.filter(e => e.eventType === 'kicked').length;
  const priorityChanges = events.filter(e => e.eventType === 'priority_change').length;
  
  return c.json({
    roomCode,
    uniqueSpeakers,
    totalSpeaks,
    averageSpeaksPerSpeaker: averageSpeaksPerSpeaker.toFixed(2),
    totalSpeakingTime, // milliseconds
    totalSpeakingTimeMinutes: (totalSpeakingTime / 1000 / 60).toFixed(2),
    averageSpeakingTime, // milliseconds
    averageSpeakingTimeSeconds: (averageSpeakingTime / 1000).toFixed(2),
    queueJoins,
    queueLeaves,
    kicks,
    priorityChanges,
    topSpeakers: stats.slice(0, 5).map(s => ({
      username: s.username,
      totalSpeaks: s.totalSpeaks,
      totalSpeakingTime: s.totalSpeakingTime,
      averageSpeakingTime: s.averageSpeakingTime,
    })),
  });
});

export default r;
