import { useCallback, useEffect, useState } from 'react';

export type AudioRecordingOptions = {
  onStart?: () => void;
  onStop?: () => void;
  onData: (data: Blob) => void;
  mimeOverride?: string; // <<— NEW: respects REC_MIME from server
};

const getAudioStream = () => navigator.mediaDevices.getUserMedia({ audio: true });

function pickRecorderMime(): string | undefined {
  const MR: any = (window as any).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return undefined;

  const mp4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  const webm = ['audio/webm;codecs=opus', 'audio/webm'];

  const ua = navigator.userAgent || '';
  const safari =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));

  const primary = safari ? mp4 : webm;
  const secondary = safari ? webm : mp4;

  for (const t of primary) if (MR.isTypeSupported(t)) return t;
  for (const t of secondary) if (MR.isTypeSupported(t)) return t;
  return undefined;
}

export const useAudioRecording = ({ onStart, onStop, onData, mimeOverride }: AudioRecordingOptions) => {
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);

  useEffect(() => {
    if (!mediaRecorder) return;
    mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) onData(event.data);
    };
  }, [mediaRecorder, onData]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await getAudioStream();
      const candidate = mimeOverride || pickRecorderMime();
      let recorder: MediaRecorder;

      try {
        recorder = candidate ? new MediaRecorder(stream, { mimeType: candidate }) : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream); // final fallback
      }

      setMediaRecorder(recorder);
      recorder.start(500);               // smaller timeslices help latency/stability
      onStart?.();
    } catch (error) {
      console.error('Error accessing microphone:', error);
    }
  }, [mimeOverride, onStart]);

  const stopRecording = useCallback(() => {
    if (mediaRecorder?.state === 'recording') {
      try { (mediaRecorder as any).requestData?.(); } catch {}
      mediaRecorder.stop();
    }
    mediaRecorder?.stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    onStop?.();
  }, [mediaRecorder, onStop]);

  return { start: startRecording, stop: stopRecording };
};
