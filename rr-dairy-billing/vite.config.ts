import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  // Tauri loads the production build from its own asset protocol (not
  // plain http), so asset URLs must be relative — an absolute
  // "/assets/..." path 404s there the same way it would under file://.
  base: './',
  // Prevent Vite from obscuring Rust build errors, and keep the dev server
  // on a fixed port Tauri's tauri.conf.json points at.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
