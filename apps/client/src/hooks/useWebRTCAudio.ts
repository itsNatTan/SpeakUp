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

  // Audio codec preferences - prefer Opus but allow fallback to other codecs for mobile compatibility
  const audioCodecPreferences: any[] = [
    { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { mimeType: 'audio/opus', clockRate: 48000, channels: 1 },
    { mimeType: 'audio/opus', clockRate: 24000, channels: 1 },
    // Fallback codecs for better mobile compatibility
    { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { mimeType: 'audio/PCMA', clockRate: 8000, channels: 1 },
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
        
        // Configure audio element for mobile compatibility
        // DO NOT call load() for MediaStream sources!
        // For mobile, we need to be more careful about setting srcObject
        if (audioElement.srcObject !== stream) {
          audioElement.srcObject = stream;
        }
        audioElement.preload = 'auto';
        audioElement.autoplay = true; // Important for mobile
        // Set playsInline attribute for iOS (via setAttribute since it's not a standard property)
        audioElement.setAttribute('playsinline', 'true');
        // Also set x5-playsinline for some Android browsers
        audioElement.setAttribute('x5-playsinline', 'true');
        
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
        
        // Wait for stream to be ready - longer delay for mobile
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const delay = isMobile ? 800 : 300; // Increased delay for mobile
        
        // Wait for track to be ready
        if (event.track.readyState === 'live') {
          setTimeout(attemptPlay, delay);
        } else {
          // Wait for track to become live
          const waitForLive = () => {
            if (event.track.readyState === 'live') {
              setTimeout(attemptPlay, delay);
            } else {
              setTimeout(waitForLive, 100);
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
        console.error('[WebRTC] Connection failed or disconnected');
        pc.close();
        pcRef.current = null;
        setPlaying(null);
      }
    };
    
    // Log ICE connection state for debugging
    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', pc.iceConnectionState);
    };
    
    // Log ICE gathering state
    pc.onicegatheringstatechange = () => {
      console.log('[WebRTC] ICE gathering state:', pc.iceGatheringState);
    };

    return pc;
  }, [sendSignaling]);

  const handleOffer = useCallback(async (offer: RTCSessionDescriptionInit) => {
    console.log('[WebRTC] Handling offer');
    
    // If we have an existing connection that's active, we need to close it first
    // before accepting a new offer (new speaker)
    if (pcRef.current) {
      const currentState = pcRef.current.signalingState;
      const connectionState = pcRef.current.connectionState;
      console.log('[WebRTC] Current signaling state:', currentState, 'connection state:', connectionState);
      
      // If connection is active (connected/connecting), we need to close it first
      // to accept a new offer from a different speaker
      if (connectionState === 'connected' || connectionState === 'connecting') {
        console.log('[WebRTC] Closing existing connection to accept new offer');
        // Clean up audio first
        if (audioRef.current) {
          audioRef.current.srcObject = null;
          audioRef.current.pause();
        }
        audioSetupRef.current = false;
        currentStreamRef.current = null;
        
        // Close the peer connection
        pcRef.current.close();
        pcRef.current = null;
        
        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 100));
      } else if (currentState !== 'stable' && currentState !== 'have-local-offer') {
        // Connection exists but in wrong state, close and recreate
        console.warn('[WebRTC] Connection in invalid state, recreating');
        pcRef.current.close();
        pcRef.current = null;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    // Ensure peer connection is set up and ready
    if (!pcRef.current) {
      setupPeerConnection();
      // Wait a moment for the connection to initialize
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (pcRef.current) {
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Configure audio codec preferences before creating answer
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
        console.log('[WebRTC] Answer created and sent');
      } catch (error) {
        console.error('[WebRTC] Error handling offer:', error);
        // If setting remote description fails, close and try to recover
        if (pcRef.current) {
          pcRef.current.close();
          pcRef.current = null;
        }
      }
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
      // Don't pre-initialize here - wait for LISTEN to be sent first
      // This ensures proper initialization order
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
          // Don't close the peer connection on clear - just reset the audio stream
          // This allows the connection to be reused for the next speaker
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
          // Don't close the peer connection on clear - just reset the audio stream
          // This allows the connection to be reused for the next speaker
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
    
    // Send LISTEN message and pre-initialize peer connection after socket is ready
    // This ensures the connection is ready when the first offer arrives
    setTimeout(() => {
      const ws = wsRef.current;
      if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send('LISTEN');
        
        // Pre-initialize peer connection after LISTEN is sent
        // This fixes the race condition where the first speaker's offer arrives
        // before the peer connection is set up
        if (!pcRef.current) {
          setupPeerConnection();
          console.log('[WebRTC] Peer connection pre-initialized after LISTEN');
        }
      }
    }, 150); // Slightly longer delay to ensure socket is fully ready
    audioRef.current?.play().catch(() => {});
  }, [openSocket, setupPeerConnection]);

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
