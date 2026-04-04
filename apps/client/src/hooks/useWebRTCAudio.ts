import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaProvider } from '../providers/media';

function pickPlaybackMime(): string | undefined {
  const MS = (window as any).MediaSource;
  if (!MS || typeof MS.isTypeSupported !== 'function') return undefined;
  const mp4 = ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'];
  const webm = ['audio/webm; codecs="opus"', 'audio/webm'];
  const ua = navigator.userAgent || '';
  const safari = /iPad|iPhone|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));
  const primary = safari ? mp4 : webm;
  const secondary = safari ? webm : mp4;
  for (const t of primary) if (MS.isTypeSupported(t)) return t;
  for (const t of secondary) if (MS.isTypeSupported(t)) return t;
  return undefined;
}

function detectAudioMimeFromBytes(data: ArrayBuffer): string | undefined {
  const bytes = new Uint8Array(data);
  if (bytes.length >= 8) {
    // MP4 boxes start with size (4 bytes) followed by "ftyp".
    if (
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return 'audio/mp4';
    }
  }
  if (bytes.length >= 4) {
    // WebM / Matroska EBML magic.
    if (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    ) {
      return 'audio/webm';
    }
  }
  return undefined;
}

type SignalingMessage = 
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'ready' }
  | { type: 'error'; error: string };

export type QueueUser = {
  username: string;
  key: string;
  priority?: number;
  joinTime?: string | number | Date;
};

export type QueueInfo = {
  queue: QueueUser[];
  currentSpeaker: string | null;
  queueSize: number;
  currentSpeakerPriority?: number;
  sortMode?: 'fifo' | 'priority';
};

// When true, skip WebRTC entirely and always receive via MediaRecorder binary.
// Flip back to false when WebRTC is working reliably again.
const FORCE_MEDIA_RECORDER = true;

const MAX_RECONNECT_ATTEMPTS = 50;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5000;

export const useWebRTCAudio = (wsEndpoint: string) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [audioPipelineMode, setAudioPipelineModeState] = useState<'live' | 'prerecord'>('live');
  const [audioMode, setAudioMode] = useState<'webrtc' | 'mediarecorder'>(FORCE_MEDIA_RECORDER ? 'mediarecorder' : 'webrtc');
  const [queueInfo, setQueueInfo] = useState<QueueInfo>({
    queue: [],
    currentSpeaker: null,
    queueSize: 0,
  });

  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const isOpenRef = useRef(false);
  const audioSetupRef = useRef(false);
  const currentStreamRef = useRef<MediaStream | null>(null);
  const providerRef = useRef<MediaProvider | null>(null);
  const fallbackModeRef = useRef(FORCE_MEDIA_RECORDER);
  const gotTrackForSpeakerRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedWebRTCRef = useRef(false);

  // Anti-screech output filter for WebRTC streams: bandpass (80 Hz – 3 kHz)
  // via createMediaStreamSource → filters → MediaStreamDestination.
  // The filtered stream is set on the <audio> element's srcObject so the
  // element only plays filtered audio for WebRTC paths.
  const outputCtxRef = useRef<AudioContext | null>(null);
  const filterInputRef = useRef<BiquadFilterNode | null>(null);
  const filteredStreamRef = useRef<MediaStream | null>(null);
  const webrtcSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const mountedRef = useRef(true);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasListeningRef = useRef(false);
  const shouldReconnectRef = useRef(true);
  const audioPipelineModeRef = useRef<'live' | 'prerecord'>('live');

  // Detect device types for specific handling (used throughout the hook)
  // iOS Safari with "Request Desktop Website" reports Mac-like UA (no "iPhone") - use platform + touch as fallback
  const isIPhoneUA = /iPhone/i.test(navigator.userAgent);
  const isIOSDesktopMode =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const deviceInfo = {
    isiPhone: isIPhoneUA || isIOSDesktopMode,
    isAndroid: /Android/i.test(navigator.userAgent),
    isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
  };
  
  // iOS 15+ has known WebRTC bugs on iPhone (not iPad) - prioritize TURN/relay
  // Android also needs TURN for NAT traversal (especially on mobile data)
  // WebRTC configuration with TURN servers prioritized for problematic devices
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      // For iPhone: Use TCP-only TURN servers first (iOS 15+ has UDP socket bugs)
      // Force relay mode to avoid direct connection issues
      ...(deviceInfo.isiPhone ? [
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
      ...(deviceInfo.isAndroid ? [
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
      // STUN servers for desktop/iPad (direct connection preferred)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // TURN servers as fallback for desktop/iPad
      ...(!deviceInfo.isiPhone && !deviceInfo.isAndroid ? [
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
    iceCandidatePoolSize: deviceInfo.isiPhone || deviceInfo.isAndroid ? 0 : 10, // Don't pre-gather on problematic devices
    // iPhone: force relay (iOS WebRTC bugs). Android 5G: force relay (CGNAT blocks UDP).
    iceTransportPolicy: deviceInfo.isiPhone || deviceInfo.isAndroid ? 'relay' : 'all',
  };

  // Audio codec preferences - Android Chrome needs specific codec order
  // Android often has issues with Opus, so we prioritize G.711 (PCMU/PCMA) for Android
  const audioCodecPreferences: any[] = deviceInfo.isAndroid ? [
    // Android: Prefer G.711 codecs first (better compatibility)
    { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { mimeType: 'audio/PCMA', clockRate: 8000, channels: 1 },
    // Then try Opus variants
    { mimeType: 'audio/opus', clockRate: 48000, channels: 1 },
    { mimeType: 'audio/opus', clockRate: 24000, channels: 1 },
    { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  ] : [
    // Desktop/iOS: Prefer Opus (better quality)
    { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { mimeType: 'audio/opus', clockRate: 48000, channels: 1 },
    { mimeType: 'audio/opus', clockRate: 24000, channels: 1 },
    // Fallback codecs
    { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { mimeType: 'audio/PCMA', clockRate: 8000, channels: 1 },
  ];

  const sendSignaling = useCallback((message: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const switchToBinaryMode = useCallback(() => {
    if (fallbackModeRef.current) return;
    setAudioMode('mediarecorder');
    const el = audioRef.current;
    if (!el) return;
    fallbackModeRef.current = true;
    el.srcObject = null;
    el.pause();
    if (!providerRef.current) {
      const fmt = pickPlaybackMime();
      providerRef.current = new MediaProvider(fmt);
      providerRef.current.attach(el);
    } else {
      providerRef.current.reinitialize();
    }
    console.log('[WebRTC] Switched to binary/MediaRecorder');
  }, []);

  const requestedWebRTCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prerecordBlobUrlRef = useRef<string | null>(null);

  const clearPrerecordBlobPlayback = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      try {
        el.load();
      } catch {}
    }
    if (prerecordBlobUrlRef.current) {
      try {
        URL.revokeObjectURL(prerecordBlobUrlRef.current);
      } catch {}
      prerecordBlobUrlRef.current = null;
    }
  }, []);

  const playPrerecordBlob = useCallback(async (payload: ArrayBuffer | Blob) => {
    const el = audioRef.current;
    if (!el) return;

    const blob = payload instanceof Blob
      ? payload
      : new Blob([payload], { type: detectAudioMimeFromBytes(payload) });

    clearPrerecordBlobPlayback();
    prerecordBlobUrlRef.current = URL.createObjectURL(blob);
    el.srcObject = null;
    el.src = prerecordBlobUrlRef.current;
    el.preload = 'auto';
    el.autoplay = true;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');
    try {
      await el.play();
    } catch (err) {
      console.warn('[Prerecord] Playback start failed:', err);
    }
  }, [clearPrerecordBlobPlayback]);

  const switchBackToWebRTC = useCallback(() => {
    const el = audioRef.current;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    fallbackModeRef.current = false;
    setAudioMode('webrtc');
    requestedWebRTCRef.current = true;
    if (requestedWebRTCTimerRef.current) clearTimeout(requestedWebRTCTimerRef.current);
    requestedWebRTCTimerRef.current = setTimeout(() => {
      requestedWebRTCRef.current = false;
      requestedWebRTCTimerRef.current = null;
    }, 5000);
    if (!el || !currentStreamRef.current) return;
    providerRef.current?.reinitialize();
    el.srcObject = filteredStreamRef.current || currentStreamRef.current;
    el.play().catch(() => {});
    requestedWebRTCRef.current = false;
    if (requestedWebRTCTimerRef.current) {
      clearTimeout(requestedWebRTCTimerRef.current);
      requestedWebRTCTimerRef.current = null;
    }
    console.log('[WebRTC] Switched back to WebRTC');
  }, []);

  const setupPeerConnection = useCallback(() => {
    const deviceLog = {
      isiPhone: deviceInfo.isiPhone,
      isAndroid: deviceInfo.isAndroid,
      iceTransportPolicy: rtcConfig.iceTransportPolicy,
      iceServersCount: rtcConfig.iceServers?.length,
    };

    // Don't recreate if we already have a working connection
    if (pcRef.current && pcRef.current.connectionState !== 'closed' && 
        pcRef.current.connectionState !== 'failed') {
      console.log('[WebRTC] Using existing peer connection', deviceLog);
      return pcRef.current;
    }

    if (pcRef.current) {
      pcRef.current.close();
    }

    // Create peer connection with device-specific config
    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;
    
    console.log('[WebRTC] Created peer connection', deviceLog);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignaling({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      gotTrackForSpeakerRef.current = true;
      requestedWebRTCRef.current = false;
      if (requestedWebRTCTimerRef.current) {
        clearTimeout(requestedWebRTCTimerRef.current);
        requestedWebRTCTimerRef.current = null;
      }
      setAudioMode('webrtc');
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (audioRef.current && event.streams[0]) {
        const audioElement = audioRef.current;
        const stream = event.streams[0];
        
        console.log('[WebRTC] Received audio track', {
          id: event.track.id,
          kind: event.track.kind,
          enabled: event.track.enabled,
          readyState: event.track.readyState,
        });
        
        // Only set up if this is a new stream (different from current)
        if (currentStreamRef.current === stream && audioSetupRef.current) {
          return; // Already set up for this stream
        }
        
        // Clean up previous stream if different
        if (currentStreamRef.current && currentStreamRef.current !== stream) {
          console.log('[WebRTC] Replacing previous stream');
          // Stop old tracks
          currentStreamRef.current.getTracks().forEach(track => track.stop());
          audioElement.srcObject = null;
          audioSetupRef.current = false;
        }
        
        currentStreamRef.current = stream;
        audioSetupRef.current = true;

        // Route the incoming WebRTC stream through the anti-screech filter
        // chain so high-frequency feedback never reaches the room speakers.
        const ctx = outputCtxRef.current;
        const filterIn = filterInputRef.current;
        const filteredStream = filteredStreamRef.current;
        let streamForElement: MediaStream = stream;

        if (ctx && filterIn && filteredStream) {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          if (webrtcSourceRef.current) {
            try { webrtcSourceRef.current.disconnect(); } catch {}
          }
          const src = ctx.createMediaStreamSource(stream);
          src.connect(filterIn);
          webrtcSourceRef.current = src;
          streamForElement = filteredStream;
          console.log('[AntiScreech] WebRTC stream connected to filter chain');
        }

        if (deviceInfo.isAndroid && audioElement.srcObject) {
          audioElement.srcObject = null;
          const s = streamForElement;
          setTimeout(() => {
            if (audioElement) audioElement.srcObject = s;
          }, 50);
        } else {
          audioElement.srcObject = streamForElement;
        }
        
        audioElement.preload = 'auto';
        audioElement.autoplay = true; // Important for mobile
        // Set playsInline attribute for iOS
        audioElement.setAttribute('playsinline', 'true');
        // Also set x5-playsinline for Android browsers (especially WeChat, QQ browser)
        audioElement.setAttribute('x5-playsinline', 'true');
        audioElement.setAttribute('webkit-playsinline', 'true');
        
        // Enhanced play attempt for mobile devices
        const attemptPlay = () => {
          if (!audioElement || !audioElement.srcObject) {
            console.warn('[WebRTC] Audio element or stream missing, cannot play');
            return;
          }
          
          if (audioElement.paused) {
            const playPromise = audioElement.play();
            if (playPromise !== undefined) {
              playPromise
                .then(() => {
                  console.log('[WebRTC] Audio playback started');
                })
                .catch((err) => {
                  console.warn('[WebRTC] Audio play failed, retrying:', err);
                  // Retry with longer delay for mobile
                  setTimeout(attemptPlay, 500);
                });
            }
          } else {
            console.log('[WebRTC] Audio already playing');
          }
        };
        
        // Simplified playback - similar to old hooks approach
        // Just try to play immediately, browser will handle buffering
        const delay = deviceInfo.isMobile ? 100 : 50; // Minimal delay, let browser handle it
        
        // Try to play when track is ready
        if (event.track.readyState === 'live') {
          setTimeout(attemptPlay, delay);
        } else {
          // Wait for track to become live, but don't wait too long
          let attempts = 0;
          const maxAttempts = 20; // Max 2 seconds
          const waitForLive = () => {
            if (event.track.readyState === 'live') {
              setTimeout(attemptPlay, delay);
            } else if (attempts < maxAttempts) {
              attempts++;
              setTimeout(waitForLive, 100);
            } else {
              // Give up waiting and try anyway
              console.warn('[WebRTC] Track not live after waiting, attempting play anyway');
              attemptPlay();
            }
          };
          waitForLive();
        }
        
        // Also try when track becomes active (mobile-specific)
        event.track.addEventListener('active', () => {
          console.log('[WebRTC] Track became active');
          attemptPlay();
        }, { once: true });
        
        // Handle track mute/unmute for mobile
        event.track.addEventListener('unmute', () => {
          console.log('[WebRTC] Track unmuted');
          attemptPlay();
        });
        
        // Cleanup when stream ends
        stream.getTracks().forEach(track => {
          const handleEnded = () => {
            console.log('[WebRTC] Track ended');
            if (currentStreamRef.current === stream) {
              audioSetupRef.current = false;
              currentStreamRef.current = null;
            }
          };
          track.addEventListener('ended', handleEnded, { once: true });
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WebRTC] Connection state:', state);
      
      if (state === 'failed' || state === 'disconnected') {
        console.error('[WebRTC] Connection failed or disconnected, cleaning up');
        // Clean up audio element
        if (audioRef.current) {
          audioRef.current.srcObject = null;
          audioRef.current.pause();
        }
        audioSetupRef.current = false;
        currentStreamRef.current = null;
        
        // Close and reset peer connection
        pc.close();
        pcRef.current = null;
        setPlaying(null);
        
        // Recreate peer connection immediately (no delay)
        // This ensures the audio pipeline is ready for the next connection
        if (isOpenRef.current) {
          console.log('[WebRTC] Recreating peer connection after failure');
          setupPeerConnection();
        }
      }
    };
    
    // Log ICE connection state for debugging and handle failures
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log('[WebRTC] ICE connection state:', iceState, {
        isiPhone: deviceInfo.isiPhone,
        iceTransportPolicy: rtcConfig.iceTransportPolicy,
      });
      
      // iPhone iOS 15+ has known DTLS/UDP issues - log candidate types for debugging
      if (deviceInfo.isiPhone) {
        const stats = pc.getStats();
        stats.then((report) => {
          const candidates: any[] = [];
          report.forEach((stat) => {
            if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
              candidates.push({
                type: stat.type,
                candidateType: (stat as any).candidateType,
                protocol: (stat as any).protocol,
                address: (stat as any).address,
                port: (stat as any).port,
              });
            }
          });
          if (candidates.length > 0) {
            console.log('[WebRTC iPhone] ICE candidates:', candidates);
            // Check if we're actually using relay (should be 'relay' type)
            const relayCandidates = candidates.filter(c => c.candidateType === 'relay');
            if (relayCandidates.length === 0 && iceState !== 'connected') {
              console.warn('[WebRTC iPhone] No relay candidates found! This may indicate relay mode is not working.');
            } else if (relayCandidates.length > 0) {
              console.log('[WebRTC iPhone] Using relay candidates:', relayCandidates);
            }
          }
        }).catch((err) => {
          console.error('[WebRTC iPhone] Failed to get stats:', err);
        });
      }
      
      // If ICE connection fails, we need to clean up and recover
      if (iceState === 'failed' || iceState === 'disconnected') {
        console.error('[WebRTC] ICE connection failed or disconnected');
        // Clean up audio
        if (audioRef.current) {
          audioRef.current.srcObject = null;
          audioRef.current.pause();
        }
        audioSetupRef.current = false;
        currentStreamRef.current = null;
        setPlaying(null);
        
        // Close and reset peer connection
        pc.close();
        pcRef.current = null;
        
        // Recreate for next speaker immediately (no delay)
        if (isOpenRef.current) {
          console.log('[WebRTC] Recreating peer connection after ICE failure');
          setupPeerConnection();
        }
      }
    };
    
    // Log ICE gathering state
    pc.onicegatheringstatechange = () => {
      console.log('[WebRTC] ICE gathering state:', pc.iceGatheringState);
    };

    return pc;
  }, [sendSignaling]);

  const handleOffer = useCallback(async (offer: RTCSessionDescriptionInit) => {
    fallbackModeRef.current = false;
    setAudioMode('webrtc');
    console.log('[WebRTC] Handling offer', {
      isiPhone: deviceInfo.isiPhone,
      isAndroid: deviceInfo.isAndroid,
      iceTransportPolicy: rtcConfig.iceTransportPolicy,
    });
    
    // ALWAYS ensure we have a clean peer connection before handling offers
    // This prevents issues when mobile fails and next speaker's offer arrives
    if (pcRef.current) {
      const currentState = pcRef.current.signalingState;
      const connectionState = pcRef.current.connectionState;
      console.log('[WebRTC] Current signaling state:', currentState, 'connection state:', connectionState);
      
      // If connection is in any non-stable state, close it immediately
      // Don't wait - we need a clean connection NOW for the new offer
      if (connectionState === 'connected' || connectionState === 'connecting' || 
          connectionState === 'failed' || connectionState === 'disconnected' ||
          (currentState !== 'stable' && currentState !== 'have-local-offer')) {
        console.log('[WebRTC] Closing existing connection to accept new offer');
        // Clean up audio immediately
        if (audioRef.current) {
          audioRef.current.srcObject = null;
          audioRef.current.pause();
        }
        audioSetupRef.current = false;
        currentStreamRef.current = null;
        
        // Close the peer connection immediately (synchronous)
        pcRef.current.close();
        pcRef.current = null;
      }
    }
    
    // ALWAYS create a fresh peer connection for each new offer
    // This ensures we never have a broken state
    setupPeerConnection();
    
    // No delay - the connection is ready immediately after setupPeerConnection
    if (pcRef.current) {
      try {
        // Set remote description first
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
        
        // Configure audio codec preferences AFTER setRemoteDescription but BEFORE createAnswer
        // This is the correct order for mobile compatibility
        const transceivers = pcRef.current.getTransceivers();
        transceivers.forEach(transceiver => {
          if (transceiver.receiver.track && transceiver.receiver.track.kind === 'audio') {
            // Get available codecs and filter our preferences to only include available ones
            try {
              const capabilities = (transceiver.receiver as any).getCapabilities?.();
              const availableCodecs = capabilities?.codecs || [];
              
              // Filter preferences to only include codecs that are actually available
              const validPreferences = audioCodecPreferences.filter((pref) => {
                return availableCodecs.some(
                  (codec: any) =>
                    codec.mimeType === pref.mimeType &&
                    codec.clockRate === pref.clockRate &&
                    (pref.channels === undefined || codec.channels === pref.channels)
                );
              });
              
              // Only set preferences if we have valid ones
              if (validPreferences.length > 0) {
                transceiver.setCodecPreferences(validPreferences);
              }
            } catch (e) {
              // Codec preferences might not be supported in all browsers
              // Silently fail - this is not critical
            }
          }
        });
        
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        sendSignaling({ type: 'answer', sdp: answer });
        console.log('[WebRTC] Answer created and sent', {
          isiPhone: deviceInfo.isiPhone,
          isAndroid: deviceInfo.isAndroid,
        });
      } catch (error) {
        console.error('[WebRTC] Error handling offer:', error);
        // If anything fails, reset everything immediately
        if (pcRef.current) {
          pcRef.current.close();
          pcRef.current = null;
        }
        // Reset audio element to ensure clean state
        if (audioRef.current) {
          audioRef.current.srcObject = null;
          audioRef.current.pause();
        }
        audioSetupRef.current = false;
        currentStreamRef.current = null;
        setPlaying(null);
        
        // Recreate peer connection immediately (no delay)
        if (isOpenRef.current) {
          console.log('[WebRTC] Recreating peer connection after offer error');
          setupPeerConnection();
        }
      }
    }
  }, [setupPeerConnection, sendSignaling, audioCodecPreferences]);

  const openSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    try { wsRef.current?.close(); } catch {}
    isOpenRef.current = false;

    const ws = new WebSocket(wsEndpoint);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    connectionTimeoutRef.current = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log('[WS] Connection timeout after 5s, retrying');
        try { ws.close(); } catch {}
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      isOpenRef.current = true;
      reconnectAttemptsRef.current = 0;
      shouldReconnectRef.current = true;
      console.log('[WS] open');

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

      if (!FORCE_MEDIA_RECORDER && !pcRef.current) {
        setupPeerConnection();
        console.log('[WebRTC] Peer connection initialized on socket open');
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`AUDIO_PIPELINE ${audioPipelineModeRef.current}`);
      }

      if (wasListeningRef.current) {
        console.log('[WS] Reconnected — restoring listening state');

        if (!FORCE_MEDIA_RECORDER) {
          providerRef.current?.reinitialize();
          fallbackModeRef.current = false;
          if (audioRef.current) {
            audioRef.current.srcObject = null;
            audioRef.current.pause();
          }
          audioSetupRef.current = false;
          currentStreamRef.current = null;
        }
        gotTrackForSpeakerRef.current = false;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`AUDIO_PIPELINE ${audioPipelineModeRef.current}`);
          ws.send('LISTEN');
          const fmt = pickPlaybackMime();
          if (fmt) ws.send(`FORMAT ${fmt}`);
        }
      }

      setTimeout(() => {
        if (wsRef.current && isOpenRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send('QUEUE_STATUS');
        }
      }, 100);
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        if (audioPipelineModeRef.current === 'prerecord') {
          await playPrerecordBlob(event.data);
          return;
        }
        if (!fallbackModeRef.current && !requestedWebRTCRef.current) switchToBinaryMode();
        if (providerRef.current && !requestedWebRTCRef.current) {
          if (audioRef.current) {
            providerRef.current.attach(audioRef.current);
          }
          const ab = event.data instanceof ArrayBuffer
            ? event.data
            : await (event.data as Blob).arrayBuffer();
          providerRef.current.buffer(ab).catch(() => {});
        }
        return;
      }
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'offer' && !FORCE_MEDIA_RECORDER) {
          console.log('[WebRTC] Received offer from server', {
            hasSdp: !!data.sdp,
            sdpType: data.sdp?.type,
            from: data.from || 'unknown',
          });
          await handleOffer(data.sdp);
        } else if (data.type === 'ice-candidate' && pcRef.current && !FORCE_MEDIA_RECORDER) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else if (data.type === 'from') {
          setPlaying(data.name || 'Speaker');
          if (FORCE_MEDIA_RECORDER) {
            providerRef.current?.reinitialize();
          } else {
            gotTrackForSpeakerRef.current = false;
            if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = setTimeout(() => {
              if (!gotTrackForSpeakerRef.current) switchToBinaryMode();
              fallbackTimerRef.current = null;
            }, 500);
          }
        } else if (data.type === 'queue-update' || data.type === 'queue-status') {
          setQueueInfo({
            queue: data.queue || [],
            currentSpeaker: data.currentSpeaker || null,
            currentSpeakerPriority: data.currentSpeakerPriority,
            queueSize: data.queueSize || 0,
            sortMode: data.sortMode || 'fifo',
          });
        } else if (data.type === 'force-webrtc' && !FORCE_MEDIA_RECORDER) {
          switchBackToWebRTC();
        } else if (data.type === 'clear') {
          console.log('[Audio] Received clear message');
          setPlaying(null);
          if (audioPipelineModeRef.current === 'prerecord') {
            clearPrerecordBlobPlayback();
          }
          if (fallbackTimerRef.current) {
            clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = null;
          }
          if (FORCE_MEDIA_RECORDER) {
            // Don't rebuild the MSE pipeline — it stays ready for the next speaker's data.
            // rebuild() revokes the blob URL, causing ERR_FILE_NOT_FOUND if called rapidly.
          } else {
            setAudioMode('webrtc');
            fallbackModeRef.current = false;
            providerRef.current?.reinitialize();
            if (audioRef.current) {
              audioRef.current.srcObject = null;
              audioRef.current.pause();
              try {
                audioRef.current.load();
              } catch (e) {
                // load() may fail for MediaStream sources, that's okay
              }
            }
            audioSetupRef.current = false;
            currentStreamRef.current = null;
            if (pcRef.current) {
              const connState = pcRef.current.connectionState;
              const sigState = pcRef.current.signalingState;
              if (connState === 'failed' || connState === 'disconnected' || 
                  (sigState !== 'stable' && sigState !== 'have-local-offer')) {
                console.log('[WebRTC] Clearing bad connection state, will recreate on next offer');
                pcRef.current.close();
                pcRef.current = null;
              }
            }
          }
        }
      } catch (error) {
        const message = event.data.toString();

        if (message === 'PONG') return;

        if (message === 'Invalid room code' || message === 'Room not found') {
          console.error('[WS]', message);
          shouldReconnectRef.current = false;
          return;
        }

        if (message === 'CLEAR' || message === 'STOP') {
          console.log('[Audio] Received clear/stop message:', message);
          setPlaying(null);
          if (audioPipelineModeRef.current === 'prerecord') {
            clearPrerecordBlobPlayback();
          }
          if (fallbackTimerRef.current) {
            clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = null;
          }
          if (FORCE_MEDIA_RECORDER) {
            // Don't rebuild — same as JSON clear above.
          } else {
            setAudioMode('webrtc');
            fallbackModeRef.current = false;
            providerRef.current?.reinitialize();
            if (audioRef.current) {
              audioRef.current.srcObject = null;
              audioRef.current.pause();
              try {
                audioRef.current.load();
              } catch (e) {
                // load() may fail for MediaStream sources, that's okay
              }
            }
            audioSetupRef.current = false;
            currentStreamRef.current = null;
            if (pcRef.current) {
              const connState = pcRef.current.connectionState;
              const sigState = pcRef.current.signalingState;
              if (connState === 'failed' || connState === 'disconnected' || 
                  (sigState !== 'stable' && sigState !== 'have-local-offer')) {
                console.log('[WebRTC] Clearing bad connection state, will recreate on next offer');
                pcRef.current.close();
                pcRef.current = null;
              }
            }
          }
        } else if (message.startsWith('FROM')) {
          setPlaying(message.slice(4));
          if (FORCE_MEDIA_RECORDER) {
            providerRef.current?.reinitialize();
          } else {
            gotTrackForSpeakerRef.current = false;
            if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = setTimeout(() => {
              if (!gotTrackForSpeakerRef.current) switchToBinaryMode();
              fallbackTimerRef.current = null;
            }, 500);
          }
        } else {
          // Log unexpected messages for debugging
          console.log('[WebRTC] Received unexpected message:', message.substring(0, 100));
        }
      }
    };

    ws.onclose = () => {
      console.log('[WS] close');
      isOpenRef.current = false;
      wsRef.current = null;

      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

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
      } else if (!mountedRef.current) {
        setListening(false);
      }
    };

    ws.onerror = () => {};
  }, [wsEndpoint, handleOffer, switchToBinaryMode, switchBackToWebRTC]);

  const requestQueueStatus = useCallback(() => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send('QUEUE_STATUS');
    }
  }, []);

  const kickUser = useCallback((username: string) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kick-user', username }));
    }
  }, []);

  const reorderUser = useCallback((username: string, direction: 'up' | 'down') => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'reorder-user', username, direction }));
    }
  }, []);

  const moveUserToPosition = useCallback((username: string, newPosition: number) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'move-user-to-position', username, position: newPosition }));
    }
  }, []);

  const setQueueSortMode = useCallback((mode: 'fifo' | 'priority') => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-queue-sort-mode', mode }));
    }
  }, []);

  const forceMediaRecorderFallback = useCallback(() => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'force-fallback' }));
    }
  }, []);

  const forceWebRTC = useCallback(() => {
    requestedWebRTCRef.current = true;
    if (requestedWebRTCTimerRef.current) clearTimeout(requestedWebRTCTimerRef.current);
    requestedWebRTCTimerRef.current = setTimeout(() => {
      requestedWebRTCRef.current = false;
      requestedWebRTCTimerRef.current = null;
    }, 5000);
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'force-webrtc' }));
    }
  }, []);

  const setDefaultAudioMode = useCallback((mode: 'webrtc' | 'mediarecorder') => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(`DEFAULT_MODE ${mode}`);
    }
  }, []);

  const setAudioPipelineMode = useCallback((mode: 'live' | 'prerecord') => {
    setAudioPipelineModeState(mode);
    audioPipelineModeRef.current = mode;
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(`AUDIO_PIPELINE ${mode}`);
    }
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => {
      if (audioPipelineModeRef.current !== 'prerecord' || !listening) {
        return;
      }
      const ws = wsRef.current;
      if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send('NEXT');
      }
    };

    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, [listening]);

  // Open socket for queue monitoring (even when not listening)
  useEffect(() => {
    openSocket();
    
    // Request queue status when socket opens and periodically
    const requestStatus = () => {
      if (wsRef.current && isOpenRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send('QUEUE_STATUS');
      }
    };
    
    // Request immediately when socket opens (handled in onopen)
    // Also poll every 2 seconds for queue updates
    const checkInterval = setInterval(requestStatus, 2000);
    
    // Request once after a short delay to ensure socket is ready
    const timeout = setTimeout(requestStatus, 500);
    
    return () => {
      clearInterval(checkInterval);
      clearTimeout(timeout);
    };
  }, [openSocket]);

  const listen = useCallback(() => {
    setListening(true);
    wasListeningRef.current = true;

    // Resume the anti-screech AudioContext (may be suspended until user gesture)
    if (outputCtxRef.current?.state === 'suspended') {
      outputCtxRef.current.resume().catch(() => {});
    }

    if (FORCE_MEDIA_RECORDER && audioRef.current) {
      if (!providerRef.current) {
        const fmt = pickPlaybackMime();
        providerRef.current = new MediaProvider(fmt);
        providerRef.current.attach(audioRef.current);
      }
      fallbackModeRef.current = true;
      console.log('[Audio] MediaRecorder pipeline ready');
    }
    
    setTimeout(() => {
      const ws = wsRef.current;
      if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(`AUDIO_PIPELINE ${audioPipelineModeRef.current}`);
        ws.send('LISTEN');
        const fmt = pickPlaybackMime();
        if (fmt) ws.send(`FORMAT ${fmt}`);
        
        if (!FORCE_MEDIA_RECORDER && !pcRef.current) {
          setupPeerConnection();
          console.log('[WebRTC] Peer connection created after LISTEN (fallback)');
        }
        
        // Request initial queue status
        if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
          ws.send('QUEUE_STATUS');
        }
      }
    }, 50); // Minimal delay - just to ensure socket is ready
    // Don't call play() here — MediaProvider.maybeStartPlayback() handles it
    // once enough data is buffered. Premature play() can cause element errors.
  }, [setupPeerConnection]);

  const stop = useCallback(() => {
    setListening(false);
    wasListeningRef.current = false;
    setPlaying(null);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('STOP');
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.pause();
    }
    audioSetupRef.current = false;
    currentStreamRef.current = null;
  }, []);

  const skip = useCallback(() => {
    // Skip should work immediately as long as socket is open
    // It doesn't require peer connection to be established
    console.log('[WebRTC] Skip called, socket state:', {
      wsExists: !!wsRef.current,
      readyState: wsRef.current?.readyState,
      isOpen: isOpenRef.current,
    });
    
    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('[WebRTC] Sending SKIP message');
        ws.send('SKIP');
        // Clear playing state immediately for better UX
        setPlaying(null);
      } else if (isOpenRef.current) {
        // Socket might be in a transitional state, try sending anyway
        console.log('[WebRTC] Socket not fully open but isOpenRef is true, attempting to send SKIP');
        try {
          ws.send('SKIP');
          setPlaying(null);
        } catch (err) {
          console.warn('[WebRTC] Failed to send SKIP, will retry:', err);
          // Retry after a short delay
          setTimeout(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              console.log('[WebRTC] Retrying SKIP message');
              wsRef.current.send('SKIP');
              setPlaying(null);
            }
          }, 200);
        }
      } else {
        // Socket not ready, queue it
        console.warn('[WebRTC] Socket not ready, will retry SKIP');
        setTimeout(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            console.log('[WebRTC] Sending queued SKIP message');
            wsRef.current.send('SKIP');
            setPlaying(null);
          }
        }, 300);
      }
    } else {
      console.error('[WebRTC] No WebSocket available for SKIP');
    }
  }, []);

  // Anti-screech filter chain for WebRTC streams only.
  // createMediaStreamSource → highpass(80) → lowpass(5k) × 2 → MediaStreamDestination
  // Connected per-speaker in ontrack; dest.stream is set on the <audio>
  // element's srcObject so the element only ever plays filtered audio.
  //
  // MSE / MediaRecorder binary audio plays through the <audio> element directly
  // (no Web Audio capture) — createMediaElementSource would permanently hijack
  // the element output and break MSE playback when the AudioContext suspends.
  useEffect(() => {
    if (outputCtxRef.current) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx: AudioContext = new AudioCtx();

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 80;
      hp.Q.value = 0.707;

      const lps = [0, 1].map(() => {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3000;
        lp.Q.value = 0.707;
        return lp;
      });

      hp.connect(lps[0]);
      lps[0].connect(lps[1]);

      const dest = ctx.createMediaStreamDestination();
      lps[1].connect(dest);
      filterInputRef.current = hp;
      filteredStreamRef.current = dest.stream;

      outputCtxRef.current = ctx;
      console.log('[AntiScreech] WebRTC filter chain ready');
    } catch (e) {
      console.warn('[AntiScreech] Failed to set up filter chain:', e);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      providerRef.current?.dispose();
      providerRef.current = null;
      clearPrerecordBlobPlayback();
      try { webrtcSourceRef.current?.disconnect(); } catch {}
      webrtcSourceRef.current = null;
      filterInputRef.current = null;
      filteredStreamRef.current = null;
      try { outputCtxRef.current?.close(); } catch {}
      outputCtxRef.current = null;
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      isOpenRef.current = false;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [clearPrerecordBlobPlayback]);

  return { 
    ref: audioRef, 
    listening, 
    playing, 
    listen, 
    stop, 
    skip,
    queueInfo,
    requestQueueStatus,
    kickUser,
    reorderUser,
    moveUserToPosition,
    setQueueSortMode,
    forceMediaRecorderFallback,
    forceWebRTC,
    setDefaultAudioMode,
    setAudioPipelineMode,
    audioPipelineMode,
    audioMode,
  };
};
