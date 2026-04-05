import { useCallback, useEffect, useRef, useState } from 'react';

/** Pick best MediaRecorder mime based on browser/platform support. */
function pickRecorderMime(serverHint?: string): string | undefined {
  const MR = (window as any).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return undefined;
  if (serverHint && MR.isTypeSupported(serverHint)) return serverHint;
  const mp4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  const webm = ['audio/webm;codecs=opus', 'audio/webm'];
  const ua = navigator.userAgent || '';
  const safari = /iPad|iPhone|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));
  const primary = safari ? mp4 : webm;
  const secondary = safari ? webm : mp4;
  for (const t of primary) if (MR.isTypeSupported(t)) return t;
  for (const t of secondary) if (MR.isTypeSupported(t)) return t;
  return undefined;
}

export type AudioConfig = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

type StreamingState = 'off' | 'on' | 'waiting' | 'blocked';

type SignalingMessage =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'ready'; username?: string; priority?: number }
  | { type: 'stop' }
  | { type: 'update-priority'; priority: number }
  | { type: 'error'; error: string };

// When true, skip WebRTC entirely and always use MediaRecorder for sending.
// Flip back to false when WebRTC is working reliably again.
const FORCE_MEDIA_RECORDER = true;

// Reduce mic sensitivity to weaken feedback loops.
// 0.2 ≈ −14 dB; balances feedback suppression with audibility.
const MIC_GAIN = 0.2;

type GainHandle = { stream: MediaStream; dispose: () => void };

async function applyMicGain(raw: MediaStream): Promise<GainHandle | null> {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx: AudioContext = new AudioCtx();
    try { await ctx.resume(); } catch {
      try { ctx.close(); } catch {}
      return null;
    }
    if (ctx.state !== 'running') {
      try { ctx.close(); } catch {}
      return null;
    }
    const src = ctx.createMediaStreamSource(raw);
    const gain = ctx.createGain();
    gain.gain.value = MIC_GAIN;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gain).connect(dest);
    return {
      stream: dest.stream,
      dispose: () => {
        try { src.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        try { dest.disconnect(); } catch {}
        try { ctx.close(); } catch {}
      },
    };
  } catch (e) {
    console.warn('[MicGain] Failed, using raw stream:', e);
    return null;
  }
}

const MAX_RECONNECT_ATTEMPTS = 50;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5000;

export const useWebRTCStreaming = (
  wsEndpoint: string,
  username: string = '',
  audioConfig?: AudioConfig,
  priority: number = 0,
) => {
  const [state, setState] = useState<StreamingState>('off');
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Stream acquired on user gesture (required for iPhone Safari). */
  const streamFromUserGestureRef = useRef<MediaStream | null>(null);

  const isOpenRef = useRef(false);
  const wantSpeakRef = useRef(false);
  const pendingOfferRef = useRef(false);
  const priorityRef = useRef(priority);
  const recMimeRef = useRef<string | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fallbackModeRef = useRef(false);
  const micGainRef = useRef<GainHandle | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const sendFullBlobOnStopRef = useRef(false);
  const prerecordCaptureRef = useRef(false);
  const pendingStopAfterRecorderRef = useRef(false);
  const pendingTeardownAfterRecorderRef = useRef(false);
  const isStoppingRecorderRef = useRef(false);

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const mountedRef = useRef(true);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  
  // Update priority ref when it changes
  useEffect(() => {
    priorityRef.current = priority;
  }, [priority]);

  // Detect device types for specific handling
  const isiPhone = /iPhone/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  // iOS 15+ has known WebRTC bugs on iPhone - prioritize TURN/relay
  // Android also needs TURN for NAT traversal (especially on mobile data)
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      // For iPhone: Use TCP-only TURN servers first (iOS 15+ has UDP socket bugs)
      // Force relay mode to avoid direct connection issues
      ...(isiPhone ? [
        {
          // TCP-only TURN for iPhone (iOS 15+ UDP issues)
          urls: [
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:80?transport=tcp',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          // UDP TURN as fallback (though may fail on iOS 15+)
          urls: [
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:80',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
      ] : []),
      // For Android: Prioritize TURN servers (needed for mobile data NAT traversal)
      ...(isAndroid ? [
        {
          urls: [
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:80?transport=tcp',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:80',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: [
            'stun:stun.relay.metered.ca:80'
          ]
        },
      ] : []),
      // STUN servers for desktop/iPad
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // TURN as fallback for desktop/iPad
      ...(!isiPhone && !isAndroid ? [
        {
          urls: [
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:80?transport=tcp',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:80',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
      ] : []),
    ],
    iceCandidatePoolSize: isiPhone || isAndroid ? 0 : 10, // Don't pre-gather on problematic devices
    // iPhone: force relay (iOS WebRTC bugs). Android 5G: force relay (CGNAT blocks UDP).
    iceTransportPolicy: isiPhone || isAndroid ? 'relay' : 'all',
  };

  const teardownCapture = useCallback(() => {
    micGainRef.current?.dispose();
    micGainRef.current = null;

    pcRef.current?.close();
    pcRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    streamFromUserGestureRef.current?.getTracks().forEach(t => t.stop());
    streamFromUserGestureRef.current = null;

    pendingOfferRef.current = false;
  }, []);

  const cleanup = useCallback(() => {
    // Stop MediaRecorder fallback if active
    if (mediaRecorderRef.current?.state === 'recording') {
      try { (mediaRecorderRef.current as any).requestData?.(); } catch {}
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    recorderChunksRef.current = [];
    sendFullBlobOnStopRef.current = false;
    prerecordCaptureRef.current = false;
    pendingStopAfterRecorderRef.current = false;
    pendingTeardownAfterRecorderRef.current = false;
    isStoppingRecorderRef.current = false;
    fallbackModeRef.current = false;
    teardownCapture();
  }, [teardownCapture]);

  const send = useCallback((msg: SignalingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const startMediaRecorder = useCallback((stream: MediaStream, sendFullBlobOnStop: boolean = false) => {
    if (fallbackModeRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const mime = pickRecorderMime(recMimeRef.current);
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorderChunksRef.current = [];
    sendFullBlobOnStopRef.current = sendFullBlobOnStop;
    recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data || e.data.size === 0) return;
      if (sendFullBlobOnStopRef.current) {
        recorderChunksRef.current.push(e.data);
        return;
      }
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(e.data);
    };
    recorder.onstop = () => {
      const shouldSendStopAfterRecorder = pendingStopAfterRecorderRef.current;
      const shouldTeardownAfterRecorder = pendingTeardownAfterRecorderRef.current;
      pendingStopAfterRecorderRef.current = false;
      pendingTeardownAfterRecorderRef.current = false;
      isStoppingRecorderRef.current = false;
      fallbackModeRef.current = false;
      mediaRecorderRef.current = null;

      if (!sendFullBlobOnStopRef.current) {
        recorderChunksRef.current = [];
        if (shouldSendStopAfterRecorder && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'stop' }));
        }
        if (shouldTeardownAfterRecorder) {
          teardownCapture();
        }
        if (shouldSendStopAfterRecorder) {
          // Prerecord chunked stop path: return to idle immediately after flush.
          setState('off');
        }
        return;
      }
      const chunks = recorderChunksRef.current;
      recorderChunksRef.current = [];
      if (chunks.length) {
        const type = recorder.mimeType || mime || 'audio/webm';
        const fullBlob = new Blob(chunks, { type });
        if (fullBlob.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(fullBlob);
        }
      }
      if (shouldSendStopAfterRecorder && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
      }
      if (shouldTeardownAfterRecorder) {
        teardownCapture();
      }
      if (shouldSendStopAfterRecorder) {
        setState('off');
      }
      sendFullBlobOnStopRef.current = false;
    };
    if (sendFullBlobOnStopRef.current) {
      recorder.start();
    } else {
      recorder.start(250);
    }
    mediaRecorderRef.current = recorder;
    fallbackModeRef.current = true;
  }, []);

  const fallbackToMediaRecorder = useCallback(() => {
    if (fallbackModeRef.current || !streamRef.current) return;
    startMediaRecorder(micGainRef.current?.stream ?? streamRef.current);
    console.log('[WebRTC Streaming] Switched to MediaRecorder');
  }, [startMediaRecorder]);

  const stopMediaRecorderAndUseWebRTC = useCallback(async () => {
    if (!fallbackModeRef.current) return;
    if (mediaRecorderRef.current?.state === 'recording') {
      try { (mediaRecorderRef.current as any).requestData?.(); } catch {}
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    fallbackModeRef.current = false;
    if (!streamRef.current) return;
    const stream = streamRef.current;
    const hadWebRTC = pcRef.current?.getSenders().some(s => s.track);
    if (hadWebRTC) {
      console.log('[WebRTC Streaming] Swapped to WebRTC (was using both, stopped MediaRecorder)');
      return;
    }
    if (!pcRef.current) {
      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;
      pc.onicecandidate = ev => { if (ev.candidate) send({ type: 'ice-candidate', candidate: ev.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.close(); };
      pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.close(); };
    }
    const outStream = micGainRef.current?.stream ?? stream;
    pcRef.current!.addTrack(outStream.getAudioTracks()[0], outStream);
    const offer = await pcRef.current!.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pcRef.current!.setLocalDescription(offer);
    send({ type: 'offer', sdp: offer });
    console.log('[WebRTC Streaming] Swapped to WebRTC (created new connection)');
  }, [send, rtcConfig]);

  const startWithMediaRecorderOnly = useCallback(async () => {
    let stream: MediaStream | null = streamFromUserGestureRef.current;
    streamFromUserGestureRef.current = null;
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: audioConfig?.echoCancellation ?? true,
          noiseSuppression: audioConfig?.noiseSuppression ?? true,
          autoGainControl: audioConfig?.autoGainControl ?? true,
        },
      });
    }

    streamRef.current = stream;
    micGainRef.current?.dispose();
    const gh = await applyMicGain(stream);
    micGainRef.current = gh;
    startMediaRecorder(gh?.stream ?? stream, false);
    console.log('[Streaming] Started with MediaRecorder (default mode)');
  }, [audioConfig, startMediaRecorder]);

  const openSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      wsRef.current?.close();
    } catch {}

    const ws = new WebSocket(wsEndpoint);
    wsRef.current = ws;

    connectionTimeoutRef.current = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log('[WS] Connection timeout after 5s, retrying');
        try { ws.close(); } catch {}
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      isOpenRef.current = true;
      setConnected(true);
      reconnectAttemptsRef.current = 0;
      shouldReconnectRef.current = true;

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send('PING');
        }
      }, HEARTBEAT_INTERVAL_MS);

      if (wantSpeakRef.current) {
        send({ type: 'ready', username, priority: priorityRef.current });
      }
    };

    ws.onclose = () => {
      isOpenRef.current = false;
      setConnected(false);

      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      if (mediaRecorderRef.current?.state === 'recording') {
        try { (mediaRecorderRef.current as any).requestData?.(); } catch {}
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }
      recorderChunksRef.current = [];
      sendFullBlobOnStopRef.current = false;
      pendingStopAfterRecorderRef.current = false;
      pendingTeardownAfterRecorderRef.current = false;
      fallbackModeRef.current = false;
      pcRef.current?.close();
      pcRef.current = null;
      pendingOfferRef.current = false;

      if (mountedRef.current && shouldReconnectRef.current &&
          reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current),
          RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttemptsRef.current++;
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) openSocket();
        }, delay);
      }
    };

    ws.onerror = () => {};

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'answer' && pcRef.current) {
          await pcRef.current.setRemoteDescription(
            new RTCSessionDescription(data.sdp),
          );
        }

        if (data.type === 'ice-candidate' && pcRef.current) {
          await pcRef.current.addIceCandidate(
            new RTCIceCandidate(data.candidate),
          );
        }

        if (data.type === 'cts') {
          recMimeRef.current = data.recMime;
          setState('on');

          try {
            const prerecordMode = data.audioPipeline === 'prerecord';
            if (prerecordMode) {
              prerecordCaptureRef.current = true;
              let stream: MediaStream | null = streamFromUserGestureRef.current;
              streamFromUserGestureRef.current = null;
              if (!stream) {
                stream = await navigator.mediaDevices.getUserMedia({
                  audio: {
                    echoCancellation: audioConfig?.echoCancellation ?? true,
                    noiseSuppression: audioConfig?.noiseSuppression ?? true,
                    autoGainControl: audioConfig?.autoGainControl ?? true,
                  },
                });
              }
              streamRef.current = stream;
              micGainRef.current?.dispose();
              const gh = await applyMicGain(stream);
              micGainRef.current = gh;
              // Match live pipeline behavior by streaming chunks continuously.
              // This avoids iPhone full-blob container incompatibilities in playback.
              startMediaRecorder(gh?.stream ?? stream, false);
              console.log('[Streaming] Started prerecord capture (chunked upload)');
            } else {
              prerecordCaptureRef.current = false;
              await startWithMediaRecorderOnly();
            }
          } catch (err) {
            console.error('[WebRTC Streaming] startWithMediaRecorderOnly failed:', err);
            cleanup();
            setState('off');
          }
        }

        if (data.type === 'stop' || data.type === 'kicked') {
          cleanup();
          if (data.reason === 'paused') {
            setState('waiting');
          } else if (data.reason === 'blocked') {
            setState('blocked');
          } else {
            setState('off');
            wantSpeakRef.current = false;
          }
        }

        if (data.type === 'force-fallback') {
          fallbackToMediaRecorder();
        }

        if (data.type === 'force-webrtc' && !FORCE_MEDIA_RECORDER) {
          stopMediaRecorderAndUseWebRTC();
        }

        if (data.type === 'need_rts') {
          if (wantSpeakRef.current) {
            send({ type: 'ready', username, priority: priorityRef.current });
          }
        }
      } catch {
        const msg = event.data.toString();

        if (msg === 'PONG') return;

        if (msg === 'Invalid room code' || msg === 'Room not found') {
          console.error('[WS]', msg);
          shouldReconnectRef.current = false;
          return;
        }

        if (msg === 'CTS') {
          setState('on');

          try {
            await startWithMediaRecorderOnly();
          } catch (err) {
            console.error('[WebRTC Streaming] startWithMediaRecorderOnly failed (plain CTS):', err);
            cleanup();
            setState('off');
          }
        }

        if (msg === 'STOP') {
          setState('off');
          wantSpeakRef.current = false;
          cleanup();
        }

        if (msg === 'NEED_RTS') {
          if (wantSpeakRef.current) {
            send({ type: 'ready', username, priority: priorityRef.current });
          }
        }
      }
    };
  }, [cleanup, fallbackToMediaRecorder, send, startWithMediaRecorderOnly, stopMediaRecorderAndUseWebRTC, username, wsEndpoint]);

  useEffect(() => {
    mountedRef.current = true;
    openSocket();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsEndpoint]);

  /** Call with a stream acquired on user gesture (required for iPhone). If omitted, mic is requested when CTS arrives (desktop). */
  const beginStream = useCallback((streamFromUserGesture?: MediaStream) => {
    if (isStoppingRecorderRef.current) {
      return;
    }
    if (streamFromUserGesture) {
      streamFromUserGestureRef.current = streamFromUserGesture;
    }
    wantSpeakRef.current = true;
    setState('waiting');
    send({ type: 'ready', username, priority: priorityRef.current });
  }, [send, username]);

  // Update priority while in queue (skip initial mount)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    
    // If waiting and priority changes, send update
    if (state === 'waiting' && wantSpeakRef.current && isOpenRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      send({ type: 'update-priority', priority });
    }
  }, [priority, state, send]);

  const endStream = useCallback(() => {
    wantSpeakRef.current = false;
    const recorder = mediaRecorderRef.current;
    if (
      prerecordCaptureRef.current &&
      recorder &&
      recorder.state === 'recording'
    ) {
      isStoppingRecorderRef.current = true;
      pendingStopAfterRecorderRef.current = true;
      pendingTeardownAfterRecorderRef.current = true;
      try { (recorder as any).requestData?.(); } catch {}
      recorder.stop();
      mediaRecorderRef.current = null;
      setState('waiting');
      return;
    }
    if (
      sendFullBlobOnStopRef.current &&
      recorder &&
      recorder.state === 'recording'
    ) {
      isStoppingRecorderRef.current = true;
      pendingStopAfterRecorderRef.current = true;
      pendingTeardownAfterRecorderRef.current = true;
      try { (recorder as any).requestData?.(); } catch {}
      recorder.stop();
      mediaRecorderRef.current = null;
      // Keep UI non-off while recorder flushes final blob and sends STOP.
      setState('waiting');
      return;
    }
    send({ type: 'stop' });
    cleanup();
    setState('off');
  }, [cleanup, send]);

  return { state, connected, beginStream, endStream };
};
