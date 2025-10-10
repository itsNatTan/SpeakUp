import { useCallback, useEffect, useState } from 'react';

type StreamingState = 'off' | 'on' | 'waiting';

export const useStreaming = (wsEndpoint: string, username: string = '') => {
  const [state, setState] = useState<StreamingState>('off');
  const [wsClient, setWsClient] = useState<WebSocket | null>(null);

  useEffect(() => {
    const client = new WebSocket(wsEndpoint);

    client.onopen = () => {
      console.log('Connected to server');
    };

    client.onclose = () => {
      console.log('Disconnected from server');
    };

    client.onmessage = ({ data }) => {
      console.log(`Received message => ${data}`);

      if (data === 'CTS') {
        setState('on');
      }

      if (data === 'STOP') {
        endStream();
      }
    };

    setWsClient(client);

    return () => {
      console.log('Closing WebSocket');
      client.close();
      setWsClient(null);
    };
  }, [wsEndpoint]);

  const rawSend = useCallback(
    (data: string | Blob) => {
      if (wsClient?.readyState === WebSocket.OPEN) {
        wsClient.send(data);
      }
    },
    [wsClient],
  );

  const send = useCallback(
    (data: Blob) => {
      if (state !== 'on') {
        // 🚫 Don't send if not actively allowed
        return;
      }
      rawSend(data);
    },
    [rawSend, state],
  );

  const beginStream = useCallback(() => {
    setState('waiting');
    rawSend(`RTS${username}`);
  }, [rawSend, username]);

  const endStream = useCallback(() => {
    rawSend('STOP');
    setState('off');
  }, [rawSend]);

  return { state, send, beginStream, endStream };
};

