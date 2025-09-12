export const MIMETYPE = 'audio/webm; codecs=opus';

export const SERVER_HOST: string =
  import.meta.env.VITE_SERVER_HOST ?? 'speakupfyp.duckdns.org';

export const SERVER_PROTOCOL: string =
  import.meta.env.VITE_SERVER_PROTOCOL ?? 'https';

export const WS_PROTOCOL: string = SERVER_PROTOCOL === 'https' ? 'wss' : 'ws';
