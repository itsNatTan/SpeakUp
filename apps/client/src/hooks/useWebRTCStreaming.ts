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

  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Public TURN servers for better mobile compatibility (NAT traversal)
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
      }
    ],
    iceCandidatePoolSize: 10, // Pre-gather candidates for faster connection
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
    if (!pcRef.current || pendingOfferRef.current) return;

    try {
      // Android-specific audio constraints - Android Chrome has different requirements
      const isAndroid = /Android/i.test(navigator.userAgent);
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: audioConfig?.echoCancellation ?? true,
        noiseSuppression: audioConfig?.noiseSuppression ?? true,
        autoGainControl: audioConfig?.autoGainControl ?? true,
      };
      
      // Android Chrome sometimes has issues with certain constraints
      // Use minimal constraints for better compatibility
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: isAndroid ? {
          // Android: Use simpler constraints (often works better without processing)
          echoCancellation: audioConfig?.echoCancellation ?? false,
          noiseSuppression: audioConfig?.noiseSuppression ?? false,
          autoGainControl: audioConfig?.autoGainControl ?? false,
        } : audioConstraints,
      });

      streamRef.current = stream;

      stream.getAudioTracks().forEach(track => {
        pcRef.current!.addTrack(track, stream);
      });

      pendingOfferRef.current = true;

      const offer = await pcRef.current.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });

      await pcRef.current.setLocalDescription(offer);
      send({ type: 'offer', sdp: offer });
      // Offer created successfully - connection is being established
      // State will be set to 'on' when CTS is received
    } catch (err) {
      console.error('Offer creation failed:', err);
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
