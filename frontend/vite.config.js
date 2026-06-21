import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react-oxc';

// Canonical project version — single source of truth at the repo root
// (../VERSION relative to this frontend/ config). Baked into the bundle as
// __APP_VERSION__ so the built frontend can self-report even offline. See
// AGENTS.md for the versioning rule.
const APP_VERSION = (() => {
  try {
    return readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
})();

const BACKEND_TARGET = process.env.BACKEND_TARGET ?? 'http://127.0.0.1:8443';
const EXTRA_ALLOWED_HOSTS = process.env.VITE_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

// When the bridge embeds Vite in middleware mode (single-port dev), API
// requests are served by the bridge itself — proxying back to BACKEND_TARGET
// would loop right back into this Vite instance (bridge → vite-proxy →
// go-core → bridge → vite-proxy → …). Bridge sets this env var before
// calling createServer; standalone `npm run dev -w yha-frontend` leaves it
// unset and the proxy stays active so the legacy two-port flow still works.
const IS_BRIDGE_MIDDLEWARE = process.env.VITE_BRIDGE_MIDDLEWARE === '1';

// Pretty-URL alias — serve yha.html when the browser requests /ypa (or
// the legacy /yha) so the address bar stays clean in dev. Production is
// handled by the bridge router, which also issues the /yha → /ypa 301.
//
// Skip entirely in bridge-middleware mode: the bridge owns routing in that
// mode and registers its own explicit `/ypa` handler that runs yha.html
// through `transformIndexHtml`. If we rewrite req.url to `/yha.html` here,
// that handler stops matching and the request falls through to the bridge's
// `/yha → /ypa` 301 — which then re-enters this middleware as `/ypa` and
// loops (ERR_TOO_MANY_REDIRECTS).
const yhaUrlAlias = {
  name: 'yha-url-alias',
  configureServer(server) {
    if (IS_BRIDGE_MIDDLEWARE) return;
    server.middlewares.use((req, _res, next) => {
      if (!req.url) return next();
      if (req.url === '/ypa' || req.url.startsWith('/ypa?')) {
        req.url = '/yha.html' + req.url.slice(4);
      } else if (req.url === '/yha' || req.url.startsWith('/yha?')) {
        req.url = '/yha.html' + req.url.slice(4);
      }
      next();
    });
  },
};

const cssContentVersion = {
  name: 'yha-css-content-version',
  transformIndexHtml(html) {
    return html.replace(/href="(css\/[^"]+?\.css)(?:\?v=[^"]*)?"/g, (_m, cssPath) => {
      try {
        const bytes = readFileSync(new URL(cssPath, import.meta.url));
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
        return `href="${cssPath}?v=${hash}"`;
      } catch {
        return `href="${cssPath}"`;
      }
    });
  },
};

export default defineConfig({
  plugins: [react(), yhaUrlAlias, cssContentVersion],
  root: '.',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { yha: 'yha.html' },
      output: {
        // Split React runtime into its own cacheable chunk
        manualChunks(id) {
          if (id.includes('/node_modules/react') || id.includes('/node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/zustand')) {
            return 'vendor-zustand';
          }
          if (id.includes('/node_modules/shiki') || id.includes('/node_modules/@shikijs')) {
            return 'vendor-shiki';
          }
          // Heavy app modules — pull out of the main entry so they load
          // only when their lazy-loaded callers (chat.ts, debug modal) run.
          if (id.includes('chat/chat-streaming')) {
            return 'chat-streaming';
          }
          if (id.includes('panels/debug-panel')) {
            return 'debug-panel';
          }
        },
      },
    },
  },
  server: {
    allowedHosts: ['localhost', '127.0.0.1', ...EXTRA_ALLOWED_HOSTS],
    port: 5173,
    proxy: IS_BRIDGE_MIDDLEWARE ? undefined : {
      '/login': BACKEND_TARGET,
      '/restricted': BACKEND_TARGET,
      '/v1': BACKEND_TARGET,
      '/proxy': BACKEND_TARGET,
      '/auth': BACKEND_TARGET,
      '/local-image': BACKEND_TARGET,
    },
  },
});
