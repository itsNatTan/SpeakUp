import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldForceMediaRecorder } from '../config/deviceOverrides';

/** Pick MediaRecorder mime for WebRTC→MediaRecorder fallback (e.g. iPhone). */
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

type StreamingState = 'off' | 'on' | 'waiting';

type SignalingMessage =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'ready'; username?: string; priority?: number }
  | { type: 'stop' }
  | { type: 'update-priority'; priority: number }
  | { type: 'error'; error: string };

// Reduce mic sensitivity to weaken feedback loops. 0.5 = −6 dB; close-mic
// speech stays intelligible while room speaker bleed is halved each round-trip.
const MIC_GAIN = 0.5;

type GainHandle = { stream: MediaStream; dispose: () => void };

function applyMicGain(raw: MediaStream): GainHandle | null {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx: AudioContext = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
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
  /** Server hint for MediaRecorder format when falling back from WebRTC (e.g. iPhone). */
  const recMimeRef = useRef<string | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fallbackModeRef = useRef(false);
  const micGainRef = useRef<GainHandle | null>(null);
  /** Consecutive polls where bytesSent was below threshold (muted/failed mic or broken WebRTC). */
  const lowBytesSentCountRef = useRef(0);
  const lastBytesSentRef = useRef(0);

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

  const cleanup = useCallback(() => {
    // Stop MediaRecorder fallback if active
    if (mediaRecorderRef.current?.state === 'recording') {
      try { (mediaRecorderRef.current as any).requestData?.(); } catch {}
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    fallbackModeRef.current = false;
    lowBytesSentCountRef.current = 0;
    lastBytesSentRef.current = 0;

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

  const send = useCallback((msg: SignalingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const startMediaRecorder = useCallback((stream: MediaStream) => {
    if (fallbackModeRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const mime = pickRecorderMime(recMimeRef.current);
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data?.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(e.data);
    };
    recorder.start(500);
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
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    let stream: MediaStream | null = streamFromUserGestureRef.current;
    streamFromUserGestureRef.current = null;
    if (!stream) {
      const ac = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      stream = await navigator.mediaDevices.getUserMedia({ audio: isMobile ? ac : ac });
    }

    streamRef.current = stream;
    micGainRef.current?.dispose();
    const gh = applyMicGain(stream);
    micGainRef.current = gh;
    startMediaRecorder(gh?.stream ?? stream);
    console.log('[WebRTC Streaming] Started with MediaRecorder (default mode)');
  }, [startMediaRecorder]);

  const createOffer = useCallback(async () => {
    if (!pcRef.current || pendingOfferRef.current) {
      console.log('[WebRTC Streaming] Skipping offer creation - no PC or pending offer');
      return;
    }

    const isAndroid = /Android/i.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    console.log('[WebRTC Streaming] Creating offer', { isAndroid, isMobile, userAgent: navigator.userAgent });

    try {
      // Prefer stream acquired on user gesture (required for iPhone Safari — mic + audio must be tied to tap).
      let stream: MediaStream | null = streamFromUserGestureRef.current;
      streamFromUserGestureRef.current = null;

      if (!stream) {
        // Desktop/fallback: get mic here. No sampleRate/channelCount — let browser choose (iPhone-safe).
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: audioConfig?.echoCancellation ?? true,
          noiseSuppression: audioConfig?.noiseSuppression ?? true,
          autoGainControl: audioConfig?.autoGainControl ?? true,
        };
        stream = await navigator.mediaDevices.getUserMedia({
          audio: isMobile ? {
            echoCancellation: audioConfig?.echoCancellation ?? true,
            noiseSuppression: audioConfig?.noiseSuppression ?? true,
            autoGainControl: audioConfig?.autoGainControl ?? true,
          } : audioConstraints,
        });
      }

      console.log('[WebRTC Streaming] Got user media stream', {
        tracks: stream.getAudioTracks().length,
        trackIds: stream.getAudioTracks().map(t => t.id),
      });

      streamRef.current = stream;
      micGainRef.current?.dispose();
      const gh = applyMicGain(stream);
      micGainRef.current = gh;
      const outStream = gh?.stream ?? stream;

      outStream.getAudioTracks().forEach(track => {
        console.log('[WebRTC Streaming] Adding track to peer connection', {
          id: track.id,
          enabled: track.enabled,
          readyState: track.readyState,
        });
        pcRef.current!.addTrack(track, outStream);
      });

      pendingOfferRef.current = true;

      const offer = await pcRef.current.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });

      console.log('[WebRTC Streaming] Created offer', {
        type: offer.type,
        sdpLength: offer.sdp?.length,
        isiPhone,
        isAndroid,
        iceTransportPolicy: rtcConfig.iceTransportPolicy,
      });
      
      // For iPhone, log if we're using relay mode correctly
      if (isiPhone) {
        const stats = await pcRef.current.getStats();
        stats.forEach((stat) => {
          if (stat.type === 'local-candidate') {
            const candidateType = (stat as any).candidateType;
            const protocol = (stat as any).protocol;
            console.log('[WebRTC Streaming iPhone] Local candidate:', {
              candidateType,
              protocol,
              address: (stat as any).address,
            });
          }
        });
      }

      await pcRef.current.setLocalDescription(offer);
      send({ type: 'offer', sdp: offer });
      console.log('[WebRTC Streaming] Offer sent successfully');
      // Offer created successfully - connection is being established
      // State will be set to 'on' when CTS is received
    } catch (err) {
      console.error('[WebRTC Streaming] Offer creation failed:', err);
      cleanup();
      setState('off');
    }
  }, [audioConfig, cleanup, send]);

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
      fallbackModeRef.current = false;
      lowBytesSentCountRef.current = 0;
      lastBytesSentRef.current = 0;
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

          const effectiveMode = shouldForceMediaRecorder()
            ? 'mediarecorder'
            : data.defaultMode;

          if (effectiveMode === 'mediarecorder') {
            try {
              await startWithMediaRecorderOnly();
            } catch (err) {
              console.error('[WebRTC Streaming] startWithMediaRecorderOnly failed:', err);
              cleanup();
              setState('off');
            }
            return;
          }

          if (!pcRef.current) {
            pcRef.current = new RTCPeerConnection(rtcConfig);

            pcRef.current.onicecandidate = ev => {
              if (ev.candidate) {
                send({
                  type: 'ice-candidate',
                  candidate: ev.candidate.toJSON(),
                });
              }
            };

            pcRef.current.onconnectionstatechange = () => {
              const connState = pcRef.current?.connectionState;
              console.log('[WebRTC Streaming] Connection state:', connState);
              
              if (connState === 'failed') {
                console.warn('[WebRTC Streaming] Connection failed — trying MediaRecorder fallback');
                fallbackToMediaRecorder();
              } else if (connState === 'disconnected') {
                // Don't cleanup immediately; wait for polling to detect no audio
                console.log('[WebRTC Streaming] Disconnected, will monitor');
              }
            };
            
            pcRef.current.oniceconnectionstatechange = () => {
              const iceState = pcRef.current?.iceConnectionState;
              console.log('[WebRTC Streaming] ICE connection state:', iceState);
              if (iceState === 'failed') {
                console.warn('[WebRTC Streaming] ICE failed — trying MediaRecorder fallback');
                fallbackToMediaRecorder();
              }
            };
            
            // Log ICE gathering state
            pcRef.current.onicegatheringstatechange = () => {
              console.log('[WebRTC Streaming] ICE gathering state:', pcRef.current?.iceGatheringState);
            };

            createOffer();
            // State will be set to 'on' after offer is created successfully
            // If it fails, createOffer will handle cleanup and set state to 'off'
          } else {
            // Connection already exists, set state to 'on'
            setState('on');
          }
        }

        if (data.type === 'stop' || data.type === 'kicked') {
          cleanup();
          if (data.reason === 'paused') {
            setState('waiting');
          } else {
            setState('off');
            wantSpeakRef.current = false;
          }
        }

        if (data.type === 'force-fallback') {
          fallbackToMediaRecorder();
        }

        if (data.type === 'force-webrtc') {
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

          if (shouldForceMediaRecorder()) {
            try {
              await startWithMediaRecorderOnly();
            } catch (err) {
              console.error('[WebRTC Streaming] startWithMediaRecorderOnly failed (plain CTS):', err);
              cleanup();
              setState('off');
            }
            return;
          }

          if (!pcRef.current) {
            pcRef.current = new RTCPeerConnection(rtcConfig);
            createOffer();
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
  }, [cleanup, createOffer, fallbackToMediaRecorder, send, startWithMediaRecorderOnly, stopMediaRecorderAndUseWebRTC, username, wsEndpoint]);

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

  /** Detect when WebRTC isn't transmitting audio (muted mic, iPhone failure) or never connects (no listener) and fall back to MediaRecorder. */
  useEffect(() => {
    if (state !== 'on' || fallbackModeRef.current) return;
    const POLL_MS = 500;
    const LOW_BYTES_THRESHOLD = 1100; // bytes per 0.5s — muted ~850B, speech ~1.65KB
    const POLLS_BEFORE_FALLBACK = 2; // ~1s before switching on low audio
    const POLLS_BEFORE_FALLBACK_NOT_CONNECTED = 2; // ~1s before switching if WebRTC not connected
    lastBytesSentRef.current = 0;
    let notConnectedCount = 0;
    const iv = setInterval(async () => {
      if (fallbackModeRef.current) return;
      if (!pcRef.current || !streamRef.current) {
        return;
      }
      try {
        const connState = pcRef.current.connectionState;
        const iceState = pcRef.current.iceConnectionState;
        if (connState === 'failed' || iceState === 'failed') {
          console.warn('[WebRTC Streaming] Connection/ICE failed — MediaRecorder fallback');
          fallbackToMediaRecorder();
          return;
        }
        if (connState !== 'connected' || iceState !== 'connected') {
          notConnectedCount++;
          if (notConnectedCount >= POLLS_BEFORE_FALLBACK_NOT_CONNECTED) {
            console.warn('[WebRTC Streaming] Not connected after', notConnectedCount * POLL_MS / 1000, 's — MediaRecorder fallback');
            fallbackToMediaRecorder();
          }
          return;
        }
        notConnectedCount = 0;

        // Direct muted detection: track.enabled=false or track.muted
        const audioTracks = streamRef.current.getAudioTracks();
        const trackInfo = audioTracks.map(t => ({ enabled: t.enabled, muted: t.muted }));
        const anyMuted = audioTracks.some(t => !t.enabled || t.muted);
        if (anyMuted) {
          console.warn('[WebRTC Streaming] Mic muted (track)', trackInfo, '— MediaRecorder fallback');
          fallbackToMediaRecorder();
          return;
        }

        let bytesSent = 0;
        let anyInactive = false;
        const stats = await pcRef.current.getStats();
        stats.forEach((s) => {
          const stat = s as any;
          if (s.type === 'outbound-rtp') {
            if (stat.bytesSent != null || stat.bytes_sent != null) {
              bytesSent += stat.bytesSent ?? stat.bytes_sent ?? 0;
            }
            if (stat.active === false) anyInactive = true;
          }
        });
        if (anyInactive) {
          console.warn('[WebRTC Streaming] RTP inactive (stats.active=false) — MediaRecorder fallback');
          fallbackToMediaRecorder();
          return;
        }

        const delta = bytesSent - lastBytesSentRef.current;
        lastBytesSentRef.current = bytesSent;

        if (delta >= LOW_BYTES_THRESHOLD) {
          lowBytesSentCountRef.current = 0;
        } else {
          lowBytesSentCountRef.current++;
          if (lowBytesSentCountRef.current >= POLLS_BEFORE_FALLBACK) {
            console.warn('[WebRTC Streaming] Low bytes for', POLLS_BEFORE_FALLBACK * POLL_MS / 1000, 's (delta=', delta, ') — MediaRecorder fallback');
            fallbackToMediaRecorder();
          }
        }
      } catch (e) {
        console.warn('[WebRTC Streaming] Fallback monitor error:', e);
      }
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [state, fallbackToMediaRecorder]);

  /** Call with a stream acquired on user gesture (required for iPhone). If omitted, mic is requested when CTS arrives (desktop). */
  const beginStream = useCallback((streamFromUserGesture?: MediaStream) => {
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
    send({ type: 'stop' });
    cleanup();
    setState('off');
  }, [cleanup, send]);

  return { state, connected, beginStream, endStream };
};
