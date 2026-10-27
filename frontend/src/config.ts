declare global {
  interface Window {
    __APP_CONFIG__?: { apiUrl?: string };
  }
}

/**
 * API gateway base URL: absolute (http://localhost:8080) or a same-origin path (/api, proxied by the frontend container).
 * Order of precedence: runtime config (/config.js, written by the container from API_URL), then VITE_API_URL at build
 * time, then the local gateway. The browser only ever talks to this gateway.
 */
export const API_URL = (window.__APP_CONFIG__?.apiUrl || import.meta.env.VITE_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
