import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Route stylesheets are appended to <head> as their chunks load, so the entry
// stylesheet must come before them for route rules to win ties as they do on a
// normal load. A static host that places the entry <link> in <body> (as the
// preview publisher does) would put it last; move it to the top of <head>.
document.querySelectorAll<HTMLLinkElement>('body > link[rel="stylesheet"]').forEach(link => document.head.prepend(link));

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
