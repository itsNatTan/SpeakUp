import { useCallback, useEffect, useRef, useState } from 'react';

type SignalingMessage = 
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'ready' }
  | { type: 'error'; error: string };

export const useWebRTCAudio = (wsEndpoint: string) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const isOpenRef = useRef(false);
  const audioSetupRef = useRef(false);
  const currentStreamRef = useRef<MediaStream | null>(null);

  // WebRTC configuration with optimized audio settings
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // Audio codec preferences - prefer Opus for better quality and lower latency
  const audioCodecPreferences: RTCRtpCodecCapability[] = [
    { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { mimeType: 'audio/opus', clockRate: 48000, channels: 1 },
  ];

  const sendSignaling = useCallback((message: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const setupPeerConnection = useCallback(() => {
    // Don't recreate if we already have a working connection
    if (pcRef.current && pcRef.current.connectionState !== 'closed' && 
        pcRef.current.connectionState !== 'failed') {
      return pcRef.current;
    }

    if (pcRef.current) {
      pcRef.current.close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignaling({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      if (audioRef.current && event.streams[0]) {
        const audioElement = audioRef.current;
        const stream = event.streams[0];
        
        // Only set up if this is a new stream (different from current)
        if (currentStreamRef.current === stream && audioSetupRef.current) {
          return; // Already set up for this stream
        }
        
        // Clean up previous stream if different
        if (currentStreamRef.current && currentStreamRef.current !== stream) {
          audioElement.srcObject = null;
          audioSetupRef.current = false;
        }
        
        currentStreamRef.current = stream;
        audioSetupRef.current = true;
        
        // Configure audio element - DO NOT call load() for MediaStream sources!
        // Setting srcObject is enough, and load() will cause restarts
        audioElement.srcObject = stream;
        audioElement.preload = 'auto';
        
        // Simple play attempt - let the browser handle buffering naturally
        // Don't interfere with the browser's native jitter buffer
        const attemptPlay = () => {
          if (audioElement.paused && audioElement.readyState >= 2) {
            audioElement.play().catch(() => {
              // If autoplay is blocked, try again after a short delay
              setTimeout(attemptPlay, 200);
            });
          }
        };
        
        // Wait a moment for the stream to start, then play
        // This gives the browser's internal jitter buffer time to fill
        setTimeout(attemptPlay, 200);
        
        // Cleanup when stream ends
        stream.getTracks().forEach(track => {
          const handleEnded = () => {
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
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        pc.close();
        pcRef.current = null;
        setPlaying(null);
      }
    };

    return pc;
  }, [sendSignaling]);

  const handleOffer = useCallback(async (offer: RTCSessionDescriptionInit) => {
    if (!pcRef.current) {
      setupPeerConnection();
    }

    if (pcRef.current) {
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Configure audio codec preferences before creating answer
      const transceivers = pcRef.current.getTransceivers();
      transceivers.forEach(transceiver => {
        if (transceiver.receiver.track && transceiver.receiver.track.kind === 'audio') {
          // Set codec preferences for better audio quality
          try {
            transceiver.setCodecPreferences(audioCodecPreferences);
          } catch (e) {
            // Codec preferences might not be supported in all browsers
            console.warn('Codec preferences not supported:', e);
          }
        }
      });
      
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);
      sendSignaling({ type: 'answer', sdp: answer });
    }
  }, [setupPeerConnection, sendSignaling]);

  const openSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    try { wsRef.current?.close(); } catch {}
    isOpenRef.current = false;

    const ws = new WebSocket(wsEndpoint);
    wsRef.current = ws;

    ws.onopen = () => {
      isOpenRef.current = true;
      console.log('[WS] open');
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'offer') {
          await handleOffer(data.sdp);
        } else if (data.type === 'ice-candidate' && pcRef.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else if (data.type === 'from') {
          setPlaying(data.name || 'Speaker');
        } else if (data.type === 'clear') {
          setPlaying(null);
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
        }
      } catch (error) {
        // Handle non-JSON messages (backward compatibility)
        const message = event.data.toString();
        
        if (message === 'CLEAR' || message === 'STOP') {
          setPlaying(null);
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
        } else if (message.startsWith('FROM')) {
          setPlaying(message.slice(4));
        }
      }
    };

    ws.onclose = () => {
      console.log('[WS] close');
      isOpenRef.current = false;
      wsRef.current = null;
      setListening(false);
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };

    ws.onerror = () => {};
  }, [wsEndpoint, handleOffer]);

  const listen = useCallback(() => {
    setListening(true);
    openSocket();
    // Send LISTEN message for backward compatibility
    // The socket will be opened asynchronously, so we'll send LISTEN after it opens
    setTimeout(() => {
      const ws = wsRef.current;
      if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send('LISTEN');
      }
    }, 100);
    audioRef.current?.play().catch(() => {});
  }, [openSocket]);

  const stop = useCallback(() => {
    setListening(false);
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
    setPlaying(null);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('SKIP');
    }
  }, []);

  useEffect(() => {
    return () => {
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
  }, []);

  return { ref: audioRef, listening, playing, listen, stop, skip };
};
