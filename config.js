// API de sync (Pages es estático: NO escribe solo).
// Local: python scripts/h1_web/sync_server.py → :8766
// Prod: URL del Cloudflare Worker (ver worker/README.md)
// Local: "http://127.0.0.1:8766"  |  Prod Pages: URL Worker
window.H1_CONFIG = {
  apiBase: "https://vigia-h1-sync.abraham-casasgm.workers.dev",
};
