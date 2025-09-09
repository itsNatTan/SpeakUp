// src/hooks/useLiveAudio.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';
import { MIMETYPE } from '../utils/constants';

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

  // ---- Media pipeline: create once and attach to <audio> ----
  useEffect(() => {
    if (!audioRef.current) return;
    providerRef.current = new MediaProvider(MIMETYPE);
    providerRef.current.attach(audioRef.current);

    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
  }, []);

  // ---- WebSocket connection mgmt with auto-reconnect ----
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
      // Flush any queued messages (e.g., early LISTEN click)
      while (outboundQueueRef.current.length) {
        const msg = outboundQueueRef.current.shift()!;
        if (msg instanceof Blob) {
          ws.send(msg);
        } else {
          ws.send(msg as string | ArrayBufferLike);
        }
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
  }, [wsEndpoint]);

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
    // Mark UI state
    setListening(true);
    // Send LISTEN now or when socket opens
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
