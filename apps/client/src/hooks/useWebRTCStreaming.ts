import { useCallback, useEffect, useRef, useState } from 'react';

type StreamingState = 'off' | 'on' | 'waiting';
type SignalingMessage = 
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'ready' }
  | { type: 'error'; error: string };

export const useWebRTCStreaming = (wsEndpoint: string, username: string = '') => {
  const [state, setState] = useState<StreamingState>('off');
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isOpenRef = useRef(false);
  const wantSpeakRef = useRef(false);
  const pendingOfferRef = useRef(false);

  // WebRTC configuration
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    pendingOfferRef.current = false;
  }, []);

  const sendSignalingRef = useRef<(message: SignalingMessage) => void>();
  const createOfferRef = useRef<() => Promise<void>>();

  const sendSignaling = useCallback((message: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  sendSignalingRef.current = sendSignaling;

  const createOffer = useCallback(async () => {
    if (!pcRef.current || pendingOfferRef.current) return;

    try {
      // Request audio with optimal constraints for quality
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000, // Prefer 48kHz for better quality
          channelCount: 1, // Mono is sufficient for voice
        }
      });
      streamRef.current = stream;

      // Add audio track to peer connection
      stream.getAudioTracks().forEach(track => {
        if (pcRef.current) {
          const sender = pcRef.current.addTrack(track, stream);
          
          // Configure audio codec preferences (prefer Opus)
          if (sender && 'setCodecPreferences' in sender) {
            try {
              const codecs: RTCRtpCodecCapability[] = [
                { mimeType: 'audio/opus', clockRate: 48000, channels: 1 },
                { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
              ];
              (sender as any).setCodecPreferences?.(codecs);
            } catch (e) {
              // Codec preferences might not be supported
              console.warn('Codec preferences not supported:', e);
            }
          }
        }
      });

      pendingOfferRef.current = true;
      const offer = await pcRef.current.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pcRef.current.setLocalDescription(offer);
      sendSignalingRef.current?.({ type: 'offer', sdp: offer });
    } catch (error) {
      console.error('Error creating offer:', error);
      cleanup();
      setState('off');
    }
  }, [cleanup]);

  createOfferRef.current = createOffer;

  const openSocket = useCallback(() => {
    // Don't close existing socket if it's still open - reuse it
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    try { wsRef.current?.close(); } catch {}
    isOpenRef.current = false;

    const ws = new WebSocket(wsEndpoint);
    wsRef.current = ws;

    ws.onopen = () => {
      isOpenRef.current = true;
      setConnected(true);
      if (wantSpeakRef.current && username) {
        sendSignalingRef.current?.({ type: 'ready', username });
      }
    };

    ws.onclose = () => {
      isOpenRef.current = false;
      setConnected(false);
      // Only cleanup peer connection, don't close WebSocket here
      // The WebSocket should stay open for reconnection
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      pendingOfferRef.current = false;
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'answer' && pcRef.current) {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'ice-candidate' && pcRef.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else if (data.type === 'cts') {
          setState('on');
          if (!pcRef.current) {
            pcRef.current = new RTCPeerConnection(rtcConfig);
            
            pcRef.current.onicecandidate = (event) => {
              if (event.candidate) {
                sendSignalingRef.current?.({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
              }
            };

            pcRef.current.onconnectionstatechange = () => {
              if (pcRef.current?.connectionState === 'failed' || 
                  pcRef.current?.connectionState === 'disconnected') {
                cleanup();
                setState('off');
              }
            };

            // Create offer after peer connection is set up
            createOfferRef.current?.().catch(err => {
              console.error('Error creating offer:', err);
              cleanup();
              setState('off');
            });
          }
        } else if (data.type === 'stop') {
          setState('off');
          wantSpeakRef.current = false;
          cleanup();
        } else if (data.type === 'need_rts') {
          if (wantSpeakRef.current && username) {
            sendSignalingRef.current?.({ type: 'ready', username });
          }
        }
      } catch (error) {
        // Handle non-JSON messages (backward compatibility)
        const message = event.data.toString();
        if (message === 'CTS') {
          setState('on');
          if (!pcRef.current) {
            pcRef.current = new RTCPeerConnection(rtcConfig);
            
            pcRef.current.onicecandidate = (event) => {
              if (event.candidate) {
                sendSignalingRef.current?.({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
              }
            };

            pcRef.current.onconnectionstatechange = () => {
              if (pcRef.current?.connectionState === 'failed' || 
                  pcRef.current?.connectionState === 'disconnected') {
                cleanup();
                setState('off');
              }
            };

            // Create offer after peer connection is set up
            createOfferRef.current?.().catch(err => {
              console.error('Error creating offer:', err);
              cleanup();
              setState('off');
            });
          }
        } else if (message === 'STOP') {
          setState('off');
          wantSpeakRef.current = false;
          cleanup();
        } else if (message === 'NEED_RTS') {
          if (wantSpeakRef.current && username) {
            sendSignalingRef.current?.({ type: 'ready', username });
          }
        }
      }
    };
  }, [wsEndpoint, username]);

  useEffect(() => {
    openSocket();
    return () => {
      // Only cleanup on unmount, not on every render
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      isOpenRef.current = false;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsEndpoint]); // Only recreate socket if endpoint changes

  const beginStream = useCallback(() => {
    wantSpeakRef.current = true;
    setState('waiting');
    if (username) {
      sendSignalingRef.current?.({ type: 'ready', username });
    }
  }, [username]);

  const endStream = useCallback(() => {
    wantSpeakRef.current = false;
    sendSignalingRef.current?.({ type: 'stop' });
    // Clean up peer connection and stream, but keep WebSocket open
    cleanup();
    setState('off');
  }, [cleanup]);

  return { state, connected, beginStream, endStream };
};
