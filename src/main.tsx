import React from 'react';
import ReactDOM from 'react-dom/client';

// Bundled locally — no runtime font fetch (master plan, Security #5).
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/400-italic.css'; // `dim` lines render italic

import './theme.css';
import './styles/layout.css';
import './styles/transcript.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
