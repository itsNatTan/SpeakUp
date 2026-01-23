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
  // Include TURN servers for better mobile compatibility (NAT traversal)
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Public TURN servers for mobile NAT traversal
      // These are free public servers - for production, use your own TURN server
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

  // Audio codec preferences - Android Chrome needs specific codec order
  // Android often has issues with Opus, so we prioritize G.711 (PCMU/PCMA) for Android
  const isAndroid = /Android/i.test(navigator.userAgent);
  const audioCodecPreferences: any[] = isAndroid ? [
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
        // Android Chrome needs special handling
        const isAndroid = /Android/i.test(navigator.userAgent);
        
        // For Android, we need to be more careful about stream replacement
        if (isAndroid && audioElement.srcObject) {
          // Android: Clear existing stream first to avoid conflicts
          audioElement.srcObject = null;
          // Small delay for Android to process the change
          setTimeout(() => {
            if (audioElement && stream) {
              audioElement.srcObject = stream;
            }
          }, 50);
        } else {
          // iOS/Desktop: Direct assignment works fine
          if (audioElement.srcObject !== stream) {
            audioElement.srcObject = stream;
          }
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
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const delay = isMobile ? 100 : 50; // Minimal delay, let browser handle it
        
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
        
        // Recreate peer connection for next speaker
        // This ensures the audio pipeline is ready for the next connection
        setTimeout(() => {
          if (isOpenRef.current && !pcRef.current) {
            console.log('[WebRTC] Recreating peer connection after failure');
            setupPeerConnection();
          }
        }, 100);
      }
    };
    
    // Log ICE connection state for debugging and handle failures
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log('[WebRTC] ICE connection state:', iceState);
      
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
        
        // Recreate for next speaker
        setTimeout(() => {
          if (isOpenRef.current && !pcRef.current) {
            console.log('[WebRTC] Recreating peer connection after ICE failure');
            setupPeerConnection();
          }
        }, 200);
      }
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
        // If setting remote description fails, close and reset everything
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
        
        // Recreate peer connection for next attempt
        setTimeout(() => {
          if (isOpenRef.current && !pcRef.current) {
            console.log('[WebRTC] Recreating peer connection after offer error');
            setupPeerConnection();
          }
        }, 200);
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
      // Initialize peer connection immediately when socket opens
      // This ensures it's ready as soon as possible
      if (!pcRef.current) {
        setupPeerConnection();
        console.log('[WebRTC] Peer connection initialized on socket open');
      }
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
          console.log('[WebRTC] Received clear message - resetting audio pipeline');
          setPlaying(null);
          // Reset audio element completely
          if (audioRef.current) {
            audioRef.current.srcObject = null;
            audioRef.current.pause();
            // Force reload for mobile browsers
            try {
              audioRef.current.load();
            } catch (e) {
              // load() may fail for MediaStream sources, that's okay
            }
          }
          audioSetupRef.current = false;
          currentStreamRef.current = null;
          
          // If peer connection is in a bad state, close and recreate it
          // This ensures the pipeline is ready for the next speaker
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
      } catch (error) {
        // Handle non-JSON messages (backward compatibility)
        const message = event.data.toString();
        
        if (message === 'CLEAR' || message === 'STOP') {
          console.log('[WebRTC] Received clear/stop message:', message);
          setPlaying(null);
          // Reset audio element completely
          if (audioRef.current) {
            audioRef.current.srcObject = null;
            audioRef.current.pause();
            // Force reload for mobile browsers
            try {
              audioRef.current.load();
            } catch (e) {
              // load() may fail for MediaStream sources, that's okay
            }
          }
          audioSetupRef.current = false;
          currentStreamRef.current = null;
          
          // If peer connection is in a bad state, close and recreate it
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
        } else if (message.startsWith('FROM')) {
          setPlaying(message.slice(4));
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
    
    // Send LISTEN message - peer connection should already be initialized in onopen
    // But ensure it exists just in case
    setTimeout(() => {
      const ws = wsRef.current;
      if (ws && isOpenRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send('LISTEN');
        
        // Ensure peer connection exists (should already be created in onopen)
        if (!pcRef.current) {
          setupPeerConnection();
          console.log('[WebRTC] Peer connection created after LISTEN (fallback)');
        }
      }
    }, 50); // Minimal delay - just to ensure socket is ready
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
