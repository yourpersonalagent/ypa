// React entry — mounts the entire app shell synchronously into #root.
// This script must execute BEFORE main.ts in yha.html so the static-DOM
// queries inside main.ts service modules (chat.ts, workflow.ts, etc.)
// resolve to elements that React just rendered into the document.

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { installFrontendAgentApi } from './host/frontend-agent.js';

// Install before React mounts so browser agents can wait on `ypa:agent-ready`
// and inspect the core command catalog while lazy UI chunks are loading.
installFrontendAgentApi();

function mount() {
  const el = document.getElementById('root');
  if (!el) {
    // Defensive fallback for any caller still expecting #react-root
    const legacy = document.getElementById('react-root');
    if (legacy) createRoot(legacy).render(<ErrorBoundary label="App"><App /></ErrorBoundary>);
    return;
  }
  createRoot(el).render(<ErrorBoundary label="App"><App /></ErrorBoundary>);
}

mount();
