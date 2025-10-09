import { useCallback, useEffect, useRef, useState } from 'react';

export type AudioRecordingOptions = {
  onStart?: () => void;
  onStop?: () => void;
  onData: (data: Blob) => void;
};

// Prefer AAC/MP4 on Safari-like environments, otherwise WebM/Opus.
// We *feature-detect* (isTypeSupported) instead of relying on UA,
// but keep a tiny UA hint to bias toward MP4 on iOS if both report true.
function pickSupportedMime(): string | undefined {
  const mr = (window as any).MediaRecorder;
  if (!mr || typeof mr.isTypeSupported !== 'function') return undefined;

  const candidatesMP4 = [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4', // broad check for iPadOS/Safari
  ];
  const candidatesWebM = [
    'audio/webm;codecs=opus',
    'audio/webm',
  ];

  // Lightweight hint: iOS/iPadOS Safari tends to behave better with MP4
  const ua = navigator.userAgent || '';
  const seemsSafariIOS =
    /iPad|iPhone|iPod/.test(ua) || // iOS/iPadOS
    (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));

  const primary = seemsSafariIOS ? candidatesMP4 : candidatesWebM;
  const secondary = seemsSafariIOS ? candidatesWebM : candidatesMP4;

  for (const t of primary) if (mr.isTypeSupported(t)) return t;
  for (const t of secondary) if (mr.isTypeSupported(t)) return t;

  // As a last resort, let the browser choose.
  return undefined;
}

const getAudioStream = async () =>
  navigator.mediaDevices.getUserMedia({ audio: true });

export const useAudioRecording = ({
  onStart,
  onStop,
  onData,
}: AudioRecordingOptions) => {
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const ignoreChunksRef = useRef(false);
  const stopTimeoutRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Wire/rewire data handler whenever recorder or onData changes.
  useEffect(() => {
    if (!mediaRecorder) return;

    const handleData = (event: BlobEvent) => {
      if (ignoreChunksRef.current) return; // drop late chunks during/after stop
      if (event.data && event.data.size > 0) {
        onData(event.data);
      }
    };

    mediaRecorder.ondataavailable = handleData;

    return () => {
      // Clean up handlers on unmount/change
      mediaRecorder.ondataavailable = null as any;
      mediaRecorder.onstop = null as any;
      mediaRecorder.onerror = null as any;
    };
  }, [mediaRecorder, onData]);

  const startRecording = useCallback(async () => {
    try {
      // Reset state in case we’re restarting
      ignoreChunksRef.current = false;

      const stream = await getAudioStream();
      streamRef.current = stream;

      // Pick a safe MIME. If construction with mimeType fails, retry without it.
      const mimeType = pickSupportedMime();

      let recorder: MediaRecorder | null = null;

      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch (e) {
        // Some Safari 16 builds throw even when isTypeSupported says true.
        // Retry with no mimeType to let the browser decide.
        try {
          recorder = new MediaRecorder(stream);
        } catch (e2) {
          console.error('MediaRecorder construction failed:', e2);
          // Cleanup on fatal failure
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          return;
        }
      }

      // A small timeslice keeps buffers draining; 250–1000ms works well in Safari.
      recorder.start(500);

      // Add robust stop handler (but *don’t* rely on it to fire)
      recorder.onstop = () => {
        onStop?.();
      };

      // Optional: log chosen container for debugging
      // console.log('Recording with:', mimeType ?? '(browser default)');

      setMediaRecorder(recorder);
      onStart?.();
    } catch (error) {
      console.error('Error accessing microphone:', error);
    }
  }, [onStart, onStop]);

  const stopRecording = useCallback(() => {
    const mr = mediaRecorder;
    const stream = streamRef.current;

    // Stop accepting new data immediately
    ignoreChunksRef.current = true;

    // Try to flush any buffered data quickly; swallow invalid state errors.
    try {
      (mr as any)?.requestData?.();
    } catch {}

    // Some Safari builds never dispatch final events; don’t await them.
    try {
      if (mr && mr.state === 'recording') mr.stop();
    } catch {}

    // Hard-stop all tracks so iPad reports the mic as ended
    try {
      if (stream) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
      }
    } catch {}

    // Safety timer: clear recorder ref even if no onstop arrives
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    stopTimeoutRef.current = window.setTimeout(() => {
      setMediaRecorder(null);
      streamRef.current = null;
      stopTimeoutRef.current && clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
      // Call onStop here as a fallback in case 'onstop' never fired
      onStop?.();
    }, 350) as unknown as number;
  }, [mediaRecorder, onStop]);

  const handleStart = useCallback(() => {
    startRecording();
  }, [startRecording]);

  const handleStop = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  return { start: handleStart, stop: handleStop };
};
