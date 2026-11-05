# H1 sync — Cloudflare Worker (prod con GitHub Pages)

**GitHub Pages no guarda datos.** El Worker escribe en un repo (privado) vía GitHub API.

## Deploy / redeploy

```bash
cd h1_web/worker
npx wrangler deploy
```

(o pegar `worker.js` en dashboard Cloudflare → Deploy). Secrets ya existentes se conservan.

1. Repo privado p.ej. `abcasas/vigia-h1-annotations` con carpeta `annotations/sync/`.
2. Fine-grained PAT: `contents: write` solo en ese repo.
3. Secrets: `GITHUB_TOKEN`, `ADMIN_KEY`, `GITHUB_REPO=owner/name`, `GITHUB_BRANCH=main`.
4. En `h1_web/config.js` (o Pages):

```js
window.H1_CONFIG = { apiBase: "https://vigia-h1-sync.<tu>.workers.dev" };
```

6. Publica Pages solo con UI + `public/data/` (sin `scoring/`).

## Local

```bash
python scripts/h1_web/sync_server.py   # :8766
# config.js ya apunta a 127.0.0.1:8766
```
