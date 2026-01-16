// src/hooks/useLiveAudio.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';

function pickPlaybackMime(): string | undefined {
  const MS = (window as any).MediaSource;
  if (!MS || typeof MS.isTypeSupported !== 'function') return undefined;

  const mp4 = ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'];
  const webm = ['audio/webm; codecs="opus"', 'audio/webm'];

  const ua = navigator.userAgent || '';
  const isSafari =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));

  const primary = isSafari ? mp4 : webm;
  const secondary = isSafari ? webm : mp4;

  for (const t of primary) if (MS.isTypeSupported(t)) return t;
  for (const t of secondary) if (MS.isTypeSupported(t)) return t;
  return undefined;
}

type QueuedMsg = string | ArrayBufferLike | Blob;

export const useLiveAudio = (wsEndpoint: string) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const providerRef = useRef<MediaProvider | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const isOpenRef = useRef(false);
  const outboundQueueRef = useRef<QueuedMsg[]>([]);

  const FORMAT = useRef<string | undefined>(pickPlaybackMime()).current;

  // ---- Media pipeline (once) ----
  useEffect(() => {
    if (!audioRef.current) return;
    providerRef.current = new MediaProvider(FORMAT);
    providerRef.current.attach(audioRef.current);

    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
  }, [FORMAT]);

  // ---- Open WebSocket ONLY when explicitly requested ----
  const openSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(wsEndpoint);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    isOpenRef.current = false;

    ws.onopen = () => {
      isOpenRef.current = true;

      while (outboundQueueRef.current.length) {
        const msg = outboundQueueRef.current.shift()!;
        ws.send(msg as any);
      }

      console.log('[WS] open');
    };

    ws.onmessage = async (event) => {
      const data = event.data;

      if (data === 'CLEAR' || data === 'STOP') {
        setPlaying(null);
        await providerRef.current?.reinitialize();
        return;
      }

      if (typeof data === 'string' && data.startsWith('FROM')) {
        setPlaying(data.slice(4));
        return;
      }

      if (typeof data === 'string') return;

      try {
        if (data instanceof ArrayBuffer) {
          await providerRef.current?.buffer(data);
        } else if (data instanceof Blob) {
          await providerRef.current?.buffer(await data.arrayBuffer());
        }
      } catch {
        await providerRef.current?.reinitialize();
      }
    };

    ws.onclose = () => {
      console.log('[WS] close');
      isOpenRef.current = false;
      wsRef.current = null;
      setListening(false);
    };

    ws.onerror = () => {};
  }, [wsEndpoint]);

  // ---- Safe send (queue until open) ----
  const send = useCallback((msg: QueuedMsg) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(msg as any);
    } else {
      outboundQueueRef.current.push(msg);
    }
  }, []);

  // ---- Public controls ----
  const listen = useCallback(() => {
    setListening(true);
    openSocket();
    send('LISTEN');
    if (FORMAT) send(`FORMAT ${FORMAT}`);
    audioRef.current?.play().catch(() => {});
  }, [openSocket, send, FORMAT]);

  const stop = useCallback(() => {
    setListening(false);
    setPlaying(null);
    send('STOP');
  }, [send]);

  const skip = useCallback(() => {
    setPlaying(null);
    send('SKIP');
  }, [send]);

  // ---- Cleanup on unmount only ----
  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      isOpenRef.current = false;
    };
  }, []);

  return { ref: audioRef, listening, playing, listen, stop, skip };
};
