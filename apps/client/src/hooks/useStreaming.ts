import { useCallback, useEffect, useRef, useState } from 'react';

type StreamingState = 'off' | 'on' | 'waiting';
type Outbound = string | Blob | ArrayBufferLike;

export const useStreaming = (wsEndpoint: string, username: string = '') => {
  const [state, setState] = useState<StreamingState>('off');
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const isOpenRef = useRef(false);
  const outboundRef = useRef<Outbound[]>([]);
  const wantSpeakRef = useRef(false); // true between beginStream() and endStream()

  const flushOutbound = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !isOpenRef.current || ws.readyState !== WebSocket.OPEN) return;
    while (outboundRef.current.length) {
      const msg = outboundRef.current.shift()!;
      if (msg instanceof Blob) ws.send(msg);
      else ws.send(msg as any);
    }
  }, []);

  const rawSend = useCallback((data: Outbound) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      if (data instanceof Blob) ws.send(data);
      else ws.send(data as any);
    } else {
      outboundRef.current.push(data);
    }
  }, []);

  const openSocket = useCallback(() => {
    try { wsRef.current?.close(); } catch {}
    isOpenRef.current = false;

    const ws = new WebSocket(wsEndpoint);
    wsRef.current = ws;

    ws.onopen = () => {
      isOpenRef.current = true;
      setConnected(true);

      // If user hit "Join" before socket opened, send RTS now
      if (wantSpeakRef.current && username) {
        rawSend(`RTS${username}`);
      }
      flushOutbound();
      // console.log('[WS] open (student)');
    };

    ws.onclose = () => {
      isOpenRef.current = false;
      setConnected(false);
      // Don't toggle state here; the server governs state with CTS/STOP.
      // Optional: auto-reconnect after a delay if your UX wants it.
      // setTimeout(() => openSocket(), 800);
    };

    ws.onerror = () => {
      // console.warn('[WS] error (student)', e);
    };

    ws.onmessage = ({ data }) => {
      if (typeof data !== 'string') return;

      if (data === 'CTS') {
        setState('on');
        return;
      }
      if (data === 'STOP') {
        // Soft stop; keep socket open so we can requeue
        setState('off');
        wantSpeakRef.current = false;
        return;
      }
      if (data === 'NEED_RTS') {
        // Server saw audio before registration — resend RTS if we're trying to speak
        if (wantSpeakRef.current && username) {
          rawSend(`RTS${username}`);
        }
        return;
      }

      // Listener-only frames; ignore on sender
      if (data === 'CLEAR' || data.startsWith('FROM')) return;
    };
  }, [flushOutbound, rawSend, wsEndpoint, username]);

  useEffect(() => {
    openSocket();
    return () => {
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      isOpenRef.current = false;
    };
  }, [openSocket]);

  // Public API ---------------------------------------------------------------

  const beginStream = useCallback(() => {
    wantSpeakRef.current = true;
    setState('waiting');
    if (username) rawSend(`RTS${username}`);
  }, [rawSend, username]);

  const endStream = useCallback(() => {
    wantSpeakRef.current = false;
    rawSend('STOP');
    setState('off');
  }, [rawSend]);

  // Send mic chunks only when actively allowed
  const send = useCallback((data: Blob | ArrayBufferLike) => {
    if (state !== 'on') return;
    rawSend(data);
  }, [rawSend, state]);

  return { state, connected, send, beginStream, endStream };
};
