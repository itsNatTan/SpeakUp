import { useCallback, useEffect, useRef, useState } from 'react';

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
  | { type: 'ready'; username?: string }
  | { type: 'stop' }
  | { type: 'error'; error: string };

export const useWebRTCStreaming = (
  wsEndpoint: string,
  username: string = '',
  audioConfig?: AudioConfig,
) => {
  const [state, setState] = useState<StreamingState>('off');
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const isOpenRef = useRef(false);
  const wantSpeakRef = useRef(false);
  const pendingOfferRef = useRef(false);

  // Detect device types for specific handling
  const isiPhone = /iPhone/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  // iOS 15+ has known WebRTC bugs on iPhone - prioritize TURN/relay
  // Android also needs TURN for NAT traversal
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      // For iPhone and Android, prioritize TURN servers (relay)
      ...(isiPhone || isAndroid ? [
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
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
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
      ] : []),
    ],
    iceCandidatePoolSize: isiPhone || isAndroid ? 0 : 10, // Don't pre-gather on problematic devices
    iceTransportPolicy: isiPhone ? 'relay' : 'all', // iPhone: force relay to avoid iOS 15+ bugs
  };

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    pendingOfferRef.current = false;
  }, []);

  const send = useCallback((msg: SignalingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const createOffer = useCallback(async () => {
    if (!pcRef.current || pendingOfferRef.current) {
      console.log('[WebRTC Streaming] Skipping offer creation - no PC or pending offer');
      return;
    }

    const isAndroid = /Android/i.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    console.log('[WebRTC Streaming] Creating offer', { isAndroid, isMobile, userAgent: navigator.userAgent });

    try {
      // Android-specific audio constraints - Android Chrome has different requirements
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: audioConfig?.echoCancellation ?? true,
        noiseSuppression: audioConfig?.noiseSuppression ?? true,
        autoGainControl: audioConfig?.autoGainControl ?? true,
      };
      
      // Mobile devices (especially Android) often work better with minimal constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: isMobile ? {
          // Mobile: Use simpler constraints (often works better without processing)
          echoCancellation: audioConfig?.echoCancellation ?? false,
          noiseSuppression: audioConfig?.noiseSuppression ?? false,
          autoGainControl: audioConfig?.autoGainControl ?? false,
        } : audioConstraints,
      });

      console.log('[WebRTC Streaming] Got user media stream', {
        tracks: stream.getAudioTracks().length,
        trackIds: stream.getAudioTracks().map(t => t.id),
      });

      streamRef.current = stream;

      stream.getAudioTracks().forEach(track => {
        console.log('[WebRTC Streaming] Adding track to peer connection', {
          id: track.id,
          enabled: track.enabled,
          readyState: track.readyState,
        });
        pcRef.current!.addTrack(track, stream);
      });

      pendingOfferRef.current = true;

      const offer = await pcRef.current.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });

      console.log('[WebRTC Streaming] Created offer', {
        type: offer.type,
        sdpLength: offer.sdp?.length,
      });

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

    ws.onopen = () => {
      isOpenRef.current = true;
      setConnected(true);

      if (wantSpeakRef.current) {
        send({ type: 'ready', username });
      }
    };

    ws.onclose = () => {
      isOpenRef.current = false;
      setConnected(false);
      cleanup();
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
          setState('on');

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
              const state = pcRef.current?.connectionState;
              console.log('[WebRTC Streaming] Connection state:', state);
              
              if (state === 'failed' || state === 'disconnected') {
                console.error('[WebRTC Streaming] Connection failed or disconnected');
                cleanup();
                setState('off');
              }
            };
            
            // Log ICE connection state for debugging
            pcRef.current.oniceconnectionstatechange = () => {
              console.log('[WebRTC Streaming] ICE connection state:', pcRef.current?.iceConnectionState);
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

        if (data.type === 'stop') {
          setState('off');
          wantSpeakRef.current = false;
          cleanup();
        }

        if (data.type === 'need_rts') {
          if (wantSpeakRef.current) {
            send({ type: 'ready', username });
          }
        }
      } catch {
        const msg = event.data.toString();

        if (msg === 'CTS') {
          setState('on');

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
            send({ type: 'ready', username });
          }
        }
      }
    };
  }, [cleanup, createOffer, send, username, wsEndpoint]);

  useEffect(() => {
    openSocket();
    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsEndpoint]);

  const beginStream = useCallback(() => {
    wantSpeakRef.current = true;
    setState('waiting');
    send({ type: 'ready', username });
  }, [send, username]);

  const endStream = useCallback(() => {
    wantSpeakRef.current = false;
    send({ type: 'stop' });
    cleanup();
    setState('off');
  }, [cleanup, send]);

  return { state, connected, beginStream, endStream };
};
