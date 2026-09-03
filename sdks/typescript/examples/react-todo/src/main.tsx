import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tesseron } from '@tesseron/react';
import { App } from './app.js';

tesseron.app({
  id: 'todos',
  name: 'React Todo Demo',
  description: 'A simple todo list controlled by Claude via Tesseron.',
});

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
