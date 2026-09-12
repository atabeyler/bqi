import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:10000',
      '/socket.io': { target: 'http://localhost:10000', ws: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Raised just enough to cover the main bundle post-code-splitting (see
    // App.jsx's lazy(DashboardPage/ButtonShowcasePage)) without silencing a
    // warning entirely -- WorldGlobe's three.js-heavy chunk (~860KB) still
    // warns, which is an accurate signal that it could use further splitting.
    chunkSizeWarningLimit: 600
  }
});
