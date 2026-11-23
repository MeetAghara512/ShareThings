import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Keep the CRA env var prefix and output dir so deployment config is unchanged.
  envPrefix: 'REACT_APP_',
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: 'build',
    // The minifier rewrites colors, e.g. rgb(0 0 0 / 0.1) to #0000001a, which is a slightly different color
    cssMinify: false,
  },
});
