import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on :5173; the production image serves the built files with nginx (see Dockerfile).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
