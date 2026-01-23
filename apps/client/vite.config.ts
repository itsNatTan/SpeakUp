import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

// Check if SSL certificates exist (for local development)
const keyPath = path.resolve('./certs/localhost+2-key.pem');
const certPath = path.resolve('./certs/localhost+2.pem');
const hasCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 443,
    host: true,
    // Only enable HTTPS if certificates exist (local development)
    ...(hasCerts ? {
      https: {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      },
    } : {}),
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
    },
    
  },
  plugins: [react()],
});
