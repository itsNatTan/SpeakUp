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
  | { type: 'ready' }
  | { type: 'stop' }
  | { type: 'error'; error: string };

export const useWebRTCStreaming = (
  wsEndpoint: string,
  _username: string = '',
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
    ],
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: audioConfig?.echoCancellation ?? true,
          noiseSuppression: audioConfig?.noiseSuppression ?? true,
          autoGainControl: audioConfig?.autoGainControl ?? true,
          sampleRate: 48000,
          channelCount: 1,
        },
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
        send({ type: 'ready' });
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
              if (
                pcRef.current?.connectionState === 'failed' ||
                pcRef.current?.connectionState === 'disconnected'
              ) {
                cleanup();
                setState('off');
              }
            };

            createOffer();
          }
        }

        if (data.type === 'stop') {
          setState('off');
          wantSpeakRef.current = false;
          cleanup();
        }

        if (data.type === 'need_rts') {
          if (wantSpeakRef.current) {
            send({ type: 'ready' });
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
            send({ type: 'ready' });
          }
        }
      }
    };
  }, [cleanup, createOffer, send, wsEndpoint]);

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
    send({ type: 'ready' });
  }, [send]);

  const endStream = useCallback(() => {
    wantSpeakRef.current = false;
    send({ type: 'stop' });
    cleanup();
    setState('off');
  }, [cleanup, send]);

  return { state, connected, beginStream, endStream };
};
