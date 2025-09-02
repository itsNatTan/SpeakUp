import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';
import { MIMETYPE } from '../utils/constants';

export const useLiveAudio = (wsEndpoint: string) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [wsClient, setWsClient] = useState<WebSocket | null>(null);

  const ref = useRef<HTMLAudioElement>(null);
  const resetAudio = useCallback(() => {
    // Safe as we only call this function when ref is not null
    ref.current!.pause();
    ref.current!.currentTime = 0;
  }, []);

  useEffect(() => {
    setWsClient(new WebSocket(wsEndpoint));
  }, [wsEndpoint]);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) {
      return;
    }

    const provider = new MediaProvider(MIMETYPE);
    audio.src = provider.sourceUrl;

    const client = wsClient;
    if (!client) {
      return;
    }

    client.onopen = () => {
      console.log('Connected to server');
    };

    client.onclose = () => {
      console.log('Disconnected from server');
      setListening(false);
    };

    client.onmessage = async (event) => {
      if (event.data === 'CLEAR' || event.data === 'STOP') {
        console.log('Received message =>', event.data);
        // New stream coming next, reset
        setPlaying(null);
        resetAudio();
        await provider.reinitialize();
        return;
      }

      if (typeof event.data === 'string' && event.data.startsWith('FROM')) {
        const sender = event.data.slice(4);
        console.log('Receiving stream from  =>', sender);
        setPlaying(sender);
        return;
      }

      // Guard clause
      if (typeof event.data === 'string') {
        return;
      }
      const blob = event.data as Blob;
      await provider.buffer(await blob.arrayBuffer());
      audio.play();
    };

    return () => {
      provider.dispose();
      client.close();
    };
  }, [resetAudio, wsClient]);

  const listen = useCallback(() => {
    if (wsClient?.readyState === WebSocket.OPEN) {
      wsClient.send('LISTEN');
    }
    setListening(true);
  }, [wsClient]);

  const stop = useCallback(() => {
    setListening(false);
    setPlaying(null);
    // Recreate new client
    setWsClient(new WebSocket(wsEndpoint));
  }, [wsEndpoint]);

  return { ref, listening, playing, listen, stop };
};
