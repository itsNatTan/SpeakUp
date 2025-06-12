import { useCallback, useEffect, useState } from 'react';
import { MIMETYPE } from '../utils/constants';

const getAudioStream = () =>
  navigator.mediaDevices.getUserMedia({ audio: true });

export type AudioRecordingOptions = {
  onStart?: () => void;
  onStop?: () => void;
  onData: (data: Blob) => void;
};

export const useAudioRecording = ({
  onStart,
  onStop,
  onData,
}: AudioRecordingOptions) => {
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(
    null,
  );

  useEffect(() => {
    if (!mediaRecorder) {
      return;
    }

    const handleData = (event: BlobEvent) => {
      if (event.data.size > 0) {
        onData(event.data);
      }
    };
    mediaRecorder.ondataavailable = handleData;
  }, [mediaRecorder, onData]);

  // Adapted from
  // https://www.cybrosys.com/blog/how-to-implement-audio-recording-in-a-react-application

  const startRecording = useCallback(async () => {
    try {
      const stream = await getAudioStream();
      const recorder = new MediaRecorder(stream, { mimeType: MIMETYPE });
      setMediaRecorder(recorder);
      recorder.start(100);
    } catch (error) {
      console.error('Error accessing microphone:', error);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.stop();
    }
    mediaRecorder?.stream.getTracks().forEach((t) => t.stop());
  }, [mediaRecorder]);

  const handleStart = useCallback(() => {
    startRecording();
    onStart?.();
  }, [onStart, startRecording]);

  const handleStop = useCallback(() => {
    stopRecording();
    onStop?.();
  }, [onStop, stopRecording]);

  return { start: handleStart, stop: handleStop };
};
