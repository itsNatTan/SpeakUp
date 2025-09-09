// src/hooks/useLiveAudio.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';
import { MIMETYPE } from '../utils/constants';

export const useLiveAudio = (wsEndpoint: string) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [wsClient, setWsClient] = useState<WebSocket | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const providerRef = useRef<MediaProvider | null>(null);

  // (1) Create / attach the MediaProvider once
  useEffect(() => {
    if (!audioRef.current) return;

    // Create only once per mount
    if (!providerRef.current) {
      providerRef.current = new MediaProvider(MIMETYPE);
      providerRef.current.attach(audioRef.current);
    }

    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
  }, []);

  // (2) Create WS client whenever endpoint changes (or when you “stop” and recreate)
  useEffect(() => {
    const ws = new WebSocket(wsEndpoint);
    setWsClient(ws);

    ws.onopen = () => {
      console.log('Connected to server');
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
      setListening(false);
    };

    ws.onmessage = async (event) => {
      // Control messages
      if (event.data === 'CLEAR' || event.data === 'STOP') {
        console.log('Received message =>', event.data);
        setPlaying(null);
        // Rebuild the pipeline cleanly instead of removing/changing type mid-session
        await providerRef.current?.reinitialize();
        return;
      }

      if (typeof event.data === 'string' && event.data.startsWith('FROM')) {
        const sender = event.data.slice(4);
        console.log('Receiving stream from  =>', sender);
        setPlaying(sender);
        return;
      }

      // Audio data
      if (event.data instanceof Blob) {
        const ab = await (event.data as Blob).arrayBuffer();
        await providerRef.current?.buffer(ab);
      } else if (event.data instanceof ArrayBuffer) {
        await providerRef.current?.buffer(event.data as ArrayBuffer);
      }
    };

    return () => {
      try {
        ws.close();
      } catch {}
    };
  }, [wsEndpoint]);

  // (3) Start listening: send command and perform one play() from a user gesture
  const listen = useCallback(() => {
    if (wsClient?.readyState === WebSocket.OPEN) {
      wsClient.send('LISTEN');
    }
    setListening(true);

    // One user-gesture-triggered play() to satisfy mobile autoplay policy.
    audioRef.current?.play().catch(() => {
      // If it rejects (no gesture), the next user interaction will succeed.
    });
  }, [wsClient]);

  // (4) Stop: flip state and recreate the WS (provider stays attached)
  const stop = useCallback(() => {
    setListening(false);
    setPlaying(null);
    // Recreate a fresh WS connection; provider remains for future playback
    setWsClient(new WebSocket(wsEndpoint));
  }, [wsEndpoint]);

  return { ref: audioRef, listening, playing, listen, stop };
};
