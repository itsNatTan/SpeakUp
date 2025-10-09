// src/hooks/useLiveAudio.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';

// Decide playback MIME (what the server should send & MediaProvider should buffer).
// Use MediaSource.isTypeSupported() since this is the *playback* pipeline.
function pickPlaybackMime(): string | undefined {
  const MS = (window as any).MediaSource;
  // If MSE isn't available, let the provider decide (or fallback to <audio> src).
  if (!MS || typeof MS.isTypeSupported !== 'function') return undefined;

  const mp4Candidates = [
    'audio/mp4; codecs="mp4a.40.2"', // AAC-LC
    'audio/mp4', // broad
  ];
  const webmCandidates = [
    'audio/webm; codecs="opus"',
    'audio/webm',
  ];

  // Lightweight UA hint: prefer MP4 on iOS/iPadOS Safari.
  const ua = navigator.userAgent || '';
  const seemsSafariIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));

  const primary = seemsSafariIOS ? mp4Candidates : webmCandidates;
  const secondary = seemsSafariIOS ? webmCandidates : mp4Candidates;

  for (const t of primary) if (MS.isTypeSupported(t)) return t;
  for (const t of secondary) if (MS.isTypeSupported(t)) return t;

  // No strong support signaled; let provider fall back.
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

  // --- Decide format once (you can also recompute per mount if you prefer)
  const FORMAT: string | undefined = pickPlaybackMime();

  // ---- Media pipeline: create once and attach to <audio> ----
  useEffect(() => {
    if (!audioRef.current) return;
    // Pass the chosen format into MediaProvider
    providerRef.current = new MediaProvider(FORMAT ?? 'audio/webm; codecs="opus"');
    providerRef.current.attach(audioRef.current);

    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
    // FORMAT is stable for a session; if you want hot-swap, add it to deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(() => {
    // Clean any previous
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

      // Tell the server which container to stream (important if it can do both)
      // Example protocol: "FORMAT audio/mp4; codecs=\"mp4a.40.2\"" or "FORMAT audio/webm; codecs=opus"
      if (FORMAT) {
        try {
          ws.send(`FORMAT ${FORMAT}`);
        } catch {}
      }

      // Flush any queued messages (e.g., early LISTEN click)
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
        // Rebuild playback chain safely (no remove()/changeType() races)
        await providerRef.current?.reinitialize();
        return;
      }
      if (typeof data === 'string' && data.startsWith('FROM')) {
        const sender = (data as string).slice(4);
        setPlaying(sender);
        return;
      }
      if (typeof data === 'string') {
        // Unknown text message; ignore
        return;
      }

      // Audio payloads
      try {
        if (data instanceof ArrayBuffer) {
          await providerRef.current?.buffer(data);
        } else if (data instanceof Blob) {
          const ab = await (data as Blob).arrayBuffer();
          await providerRef.current?.buffer(ab);
        }
      } catch (e) {
        console.warn('[Audio] buffer error, rebuilding pipeline', e);
        await providerRef.current?.reinitialize();
      }
    };

    ws.onerror = (e) => {
      console.warn('[WS] error', e);
    };

    ws.onclose = () => {
      console.log('[WS] close');
      isOpenRef.current = false;
      setListening(false);
      // Attempt auto-reconnect after short backoff (desktop convenience)
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

    // One user-gesture-triggered play for mobile autoplay policy
    audioRef.current?.play().catch(() => {});
  }, [send]);

  const stop = useCallback(() => {
    setListening(false);
    setPlaying(null);
    // Tell server to stop; keep the same socket (no new WS here!)
    send('STOP');
  }, [send]);

  return { ref: audioRef, listening, playing, listen, stop };
};
