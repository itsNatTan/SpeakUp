import { setBackendUrl } from '@api/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { SERVER_HOST, SERVER_PROTOCOL } from './utils/constants.ts';

setBackendUrl(`${SERVER_PROTOCOL}://${SERVER_HOST}`);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
