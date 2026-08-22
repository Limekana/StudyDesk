// Entry point for the desktop glance widget's own renderer.
//
// A second Vite entry rather than a route inside the main app: the widget is a
// separate BrowserWindow with its own lifetime, and routing to it would mean
// booting the entire app shell — reducer, sync engine, timer, notifications —
// inside a 320×200 window that needs none of it.
//
// No <StrictMode>: its deliberate double-invoke of effects would double the
// widget's poll on mount for no benefit here, and there is no component tree
// to shake out bugs in — one screen, one hook.

import { createRoot } from 'react-dom/client';
import '../i18n';
import '../index.css';
import Widget from './Widget.jsx';

createRoot(document.getElementById('root')).render(<Widget />);
