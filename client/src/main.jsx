import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { BrowserRouter } from 'react-router-dom';
import { SocketProvider } from './useContext/SocketProvider';

// The free server sleeps when idle and needs up to a minute to start: wake it as early as possible.
// The answer is not needed, so no CORS setup is either
fetch(new URL("/health", import.meta.env.REACT_APP_SOCKET_SERVER_URL || window.location.origin), { mode: "no-cors" }).catch(() => {});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <BrowserRouter>
    <SocketProvider>
      <App />
      </SocketProvider>
    </BrowserRouter>
  </React.StrictMode>
);
