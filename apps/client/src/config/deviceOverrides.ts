/**
 * Devices that should always default to MediaRecorder instead of WebRTC.
 *
 * Each entry is a regex tested against `navigator.userAgent`.
 * Add or remove patterns here to control which devices get the override.
 */
export const MEDIARECORDER_FORCED_DEVICES: { pattern: RegExp; label: string }[] = [
  { pattern: /iPhone/i, label: 'iPhone' },
];

/** Check whether the current device should be forced to MediaRecorder. */
export function shouldForceMediaRecorder(ua: string = navigator.userAgent): boolean {
  return MEDIARECORDER_FORCED_DEVICES.some(d => d.pattern.test(ua));
}

/** Return human-readable label of the matched device, or null if no match. */
export function getMatchedDeviceLabel(ua: string = navigator.userAgent): string | null {
  const match = MEDIARECORDER_FORCED_DEVICES.find(d => d.pattern.test(ua));
  return match?.label ?? null;
}
