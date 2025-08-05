import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import fs from 'node:fs';
// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 443,
    host: true,
    // https: {
    //   key: fs.readFileSync('../../key.pem'),
    //   cert: fs.readFileSync('../../cert.pem'),
    // },
  },
  plugins: [react()],
});
