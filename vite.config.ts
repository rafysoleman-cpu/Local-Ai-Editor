import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:5199 http://127.0.0.1:5199",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin() {
  return {
    name: 'laie-csp',
    transformIndexHtml(html: string, context: { server?: unknown }) {
      const csp = context.server ? CSP_DEV : CSP_PROD;
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
          injectTo: 'head-prepend' as const,
        },
      ];
    },
  };
}

// Renderer-only Vite configuration. Electron main/preload are bundled by
// scripts/build-main.mjs with esbuild.
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), cspPlugin()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'electron/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 8192,
  },
});

