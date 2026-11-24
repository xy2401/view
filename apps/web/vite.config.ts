import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // Vite otherwise discovers this worker-only dependency during the first
  // identification and reloads the page while the file is open.
  optimizeDeps: { include: ['magika'] },
})
