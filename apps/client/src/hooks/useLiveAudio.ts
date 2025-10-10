// src/hooks/useLiveAudio.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';

// Decide playback MIME (what the server should send & MediaProvider should buffer).
function pickPlaybackMime(): string | undefined {
  const MS = (window as any).MediaSource;
  if (!MS || typeof MS.isTypeSupported !== 'function') return undefined;

  const mp4Candidates = [
    'audio/mp4; codecs="mp4a.40.2"', // AAC-LC
    'audio/mp4',
  ];
  const webmCandidates = [
    'audio/webm; codecs="opus"',
    'audio/webm',
  ];

  const ua = navigator.userAgent || '';
  const seemsSafariIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));

  const primary = seemsSafariIOS ? mp4Candidates : webmCandidates;
  const secondary = seemsSafariIOS ? webmCandidates : mp4Candidates;

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
  const reconnectTimerRef = useRef<number | null>(null);

  const FORMAT: string | undefined = pickPlaybackMime();

  // ---- Media pipeline: create once and attach to <audio> ----
  useEffect(() => {
    if (!audioRef.current) return;
    providerRef.current = new MediaProvider(FORMAT);
    providerRef.current.attach(audioRef.current);

    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- WebSocket connection mgmt with auto-reconnect ----
  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try { wsRef.current.close(); } catch {}
    }
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const ws = new WebSocket(wsEndpoint);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    isOpenRef.current = false;

    ws.onopen = () => {
      isOpenRef.current = true;

      // Let server know the preferred container
      if (FORMAT) {
        try {
          ws.send(`FORMAT ${FORMAT}`);
        } catch {}
      }

      while (outboundQueueRef.current.length) {
        const msg = outboundQueueRef.current.shift()!;
        if (msg instanceof Blob) ws.send(msg);
        else ws.send(msg as string | ArrayBufferLike);
      }
      console.log('[WS] open');
    };

    ws.onmessage = async (event) => {
      const data = event.data;

      // Control messages
      if (data === 'CLEAR' || data === 'STOP') {
        console.log('[WS] control =>', data);
        setPlaying(null);
        await providerRef.current?.reinitialize();
        return;
      }
      if (typeof data === 'string' && data.startsWith('FROM')) {
        const sender = (data as string).slice(4);
        setPlaying(sender);
        return;
      }
      if (typeof data === 'string') {
        return; // ignore unknown text frames
      }

      // Audio payloads
      try {
        if (data instanceof ArrayBuffer) {
          await providerRef.current?.buffer(data);
        } else if (data instanceof Blob) {
          const ab = await (data as Blob).arrayBuffer();
          await providerRef.current?.buffer(ab);
        }
      } catch {
        await providerRef.current?.reinitialize();
      }
    };

    ws.onerror = () => {
      // console.warn('[WS] error', e);
    };

    ws.onclose = () => {
      console.log('[WS] close');
      isOpenRef.current = false;
      setListening(false);
      reconnectTimerRef.current = window.setTimeout(() => connect(), 800);
    };
  }, [wsEndpoint, FORMAT]);

  // Connect on mount / when endpoint changes
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try { wsRef.current?.close(); } catch {}
    };
  }, [connect]);

  // ---- Safe send with queueing until OPEN ----
  const send = useCallback((msg: QueuedMsg) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      if (msg instanceof Blob) ws.send(msg);
      else ws.send(msg as string | ArrayBufferLike);
    } else {
      outboundQueueRef.current.push(msg);
    }
  }, []);

  // ---- Public controls ----
  const listen = useCallback(() => {
    setListening(true);
    send('LISTEN');
    audioRef.current?.play().catch(() => {});
  }, [send]);

  const stop = useCallback(() => {
    setListening(false);
    setPlaying(null);
    send('STOP');
  }, [send]);

  // NEW: Skip current speaker without toggling deafen/undeafen
  const skip = useCallback(() => {
    // Server should immediately revoke current speaker and advance the queue
    setPlaying(null);
    send('SKIP');
  }, [send]);

  return { ref: audioRef, listening, playing, listen, stop, skip };
};
