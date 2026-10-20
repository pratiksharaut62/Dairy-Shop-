/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloud API base, e.g. https://api.yourstore.in/api — baked in at build time so installers ship pre-configured. */
  readonly VITE_API_URL?: string
}
