/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloud API base, e.g. https://api.yourstore.in/api — baked in at build time so installers ship pre-configured. */
  readonly VITE_API_URL?: string
  /** '1' builds the public demo: the app creates its own sample shop on first visit, with no sign-in or server. */
  readonly VITE_DEMO?: string
}
