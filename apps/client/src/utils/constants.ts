export const MIMETYPE = 'audio/webm; codecs=opus';

export const SERVER_HOST: string =
  import.meta.env.VITE_SERVER_HOST ?? 'localhost:8000';

export const SERVER_PROTOCOL: string =
  import.meta.env.VITE_SERVER_PROTOCOL ?? 'http';

export const WS_PROTOCOL: string = SERVER_PROTOCOL === 'https' ? 'wss' : 'ws';
