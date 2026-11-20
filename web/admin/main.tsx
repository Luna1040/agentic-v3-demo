import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './App';
import '../styles.css';
import './styles.css';
import '../standalone.css';
createRoot(document.getElementById('root')!).render(<StrictMode><AdminApp /></StrictMode>);
