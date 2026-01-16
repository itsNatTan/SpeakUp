import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import fs from 'fs';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 443,
    host: true,
    https: {
      key: fs.readFileSync('./certs/localhost+2-key.pem'),
      cert: fs.readFileSync('./certs/localhost+2.pem'),
    },
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
