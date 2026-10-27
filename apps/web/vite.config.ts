import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built assets are served by the API from the same origin (ADR-05). The CSP
// forbids inline scripts, so nothing here may inject one.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
