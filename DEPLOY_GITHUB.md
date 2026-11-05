# Despliegue H1 en GitHub (Pages + sync)

GitHub Pages **solo sirve la UI** (HTML/JS/JPEG). Las anotaciones las guarda un **Cloudflare Worker** que escribe en un **repo privado** vía API. Sin el Worker, los anotadores solo tendrían `localStorage` en su navegador.

## Mapa de repos (no duplicar staging)

| Rol | Dónde |
|-----|--------|
| **Canónico (editar)** | `01_Articulo/code/h1_web/` (este árbol) |
| **Pages live** | clone `D:\Analisis de datos\vigia-h1-web` → https://github.com/abcasas/vigia-h1-web → https://abcasas.github.io/vigia-h1-web/ |
| **Worker** | Cloudflare `vigia-h1-sync` (código canónico: `h1_web/worker/`) |
| **Anotaciones** | repo privado `vigia-h1-annotations` |

**No usar** `h1_web_pages_dist/` (eliminado; era un pack intermedio desfasado).

Sync canónico → Pages (+ opc. push / wrangler):

```powershell
cd 01_Articulo/code
powershell -File scripts/h1_web/sync_to_pages.ps1
# powershell -File scripts/h1_web/sync_to_pages.ps1 -Push -DeployWorker
```

Skill Cursor: `.cursor/skills/h1-web-deploy/SKILL.md`.

```
[Anotadores] → GitHub Pages (vigia-h1-web)
                    │
                    │  POST /api/save  ·  GET /api/load  ·  GET /api/export
                    ▼
            Cloudflare Worker (vigia-h1-sync)
                    │
                    ▼
     Repo privado annotations/sync/*.json
```

---

## 0) Prerrequisitos

- Cuenta GitHub
- Cuenta Cloudflare (gratis) — [dash.cloudflare.com](https://dash.cloudflare.com)
- Pack de ítems generado (`public/data/items.json` + frames):

```bash
cd 01_Articulo/code
PYTHONPATH=. python scripts/h1_web/export_h1_smoke_pack.py
# (más adelante: export claim A40/B48 tras sellar test)
```

- **No** subir a Pages: `scoring/` (gold H1-B + sync local), `_sample_ann/`.

---

## 1) Repo de anotaciones (privado) — persistencia

1. Crear repo privado, p.ej. `abcasas/vigia-h1-annotations`.
2. Commit inicial vacío o con carpeta:

```
annotations/sync/.gitkeep
```

3. Crear un **Fine-grained Personal Access Token** (GitHub → Settings → Developer settings → PAT):
   - Resource owner: tu usuario
   - Repository access: **solo** `vigia-h1-annotations`
   - Permissions → Repository → **Contents: Read and write**
4. Guardar el token (solo lo verás una vez). Lo usarás como secret `GITHUB_TOKEN` del Worker.

---

## 2) Cloudflare Worker — API de sync

### Opción A — Dashboard (sin CLI)

1. Cloudflare → **Workers & Pages** → **Create** → Worker.
2. Nombre p.ej. `vigia-h1-sync`.
3. Pegar el contenido de [`worker/worker.js`](worker/worker.js) (export default).
4. **Settings → Variables**:
   | Secret / var | Valor |
   |--------------|--------|
   | `GITHUB_TOKEN` | el PAT del paso 1 (Secret) |
   | `ADMIN_KEY` | clave larga que solo tú conoces (Secret) |
   | `GITHUB_REPO` | `abcasas/vigia-h1-annotations` |
   | `GITHUB_BRANCH` | `main` |
5. **Deploy**. Anota la URL, p.ej. `https://vigia-h1-sync.<subdomain>.workers.dev`.
6. Prueba: abrir `https://…/api/status` → JSON con `rows`.

### Opción B — Wrangler CLI

```bash
cd h1_web/worker
npx wrangler login
# crear wrangler.toml si hace falta (name = vigia-h1-sync, main = worker.js)
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

En el dashboard, añade vars `GITHUB_REPO` y `GITHUB_BRANCH`.

---

## 3) Repo de la UI + GitHub Pages

1. Repo (puede ser el de la tesis o uno dedicado `vigia-h1-web`).
2. Subir **solo** lo necesario para Pages:

```
index.html
app.js
config.js      ← apiBase = URL del Worker
styles.css
public/data/   ← items.json + frames/
worker/        ← opcional (código del Worker; no se sirve como app)
README.md
DEPLOY_GITHUB.md
```

3. Editar `config.js` **antes** del push a Pages:

```js
window.H1_CONFIG = {
  apiBase: "https://vigia-h1-sync.<tu-subdomain>.workers.dev",
};
```

4. GitHub → **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: `main` (o `gh-pages`), folder: `/` (raíz del repo) **o** `/h1_web` si el repo es monorepo y la app vive en esa carpeta.
5. Esperar el deploy. URL típica: `https://<user>.github.io/<repo>/`
6. Abrir la app: arriba debería decir `API https://… · N anotaciones…`. Si dice “no responde”, revisa CORS/URL/Worker.

**CORS:** el Worker ya envía `Access-Control-Allow-Origin: *`.

---

## 4) Uso por anotadores

1. Abren la URL de Pages.
2. Eligen nombre → **Empezar / continuar H1-B** (luego H1-A).
3. Cada clic se sincroniza; pueden cerrar el navegador y seguir otro día.
4. **No** necesitan enviarte JSONL.

---

## 5) Tú (admin) — descargar todo

1. En la misma URL de Pages, sección **Admin**.
2. Clave = valor de `ADMIN_KEY` del Worker.
3. **Descargar export total** → JSON completo + JSONL `annotations_{persona}_{h1a|h1b}.jsonl`.
4. Agregar localmente:

```bash
cd 01_Articulo/code
python scripts/h1_web/h1_aggregate.py \
  --a-luis annotations_luis_h1a.jsonl \
  --a-jesus annotations_jesus_h1a.jsonl \
  --a-abraham annotations_abraham_h1a.jsonl \
  --b-luis annotations_luis_h1b.jsonl \
  --b-jesus annotations_jesus_h1b.jsonl \
  --b-abraham annotations_abraham_h1b.jsonl \
  --out H1_report.md
```

---

## 6) Checklist anti-despistes

- [ ] `config.js` en Pages apunta al Worker (no a `127.0.0.1`)
- [ ] Repo de anotaciones **privado**; PAT solo Contents write
- [ ] `ADMIN_KEY` fuerte; no commitearla en el front
- [ ] `scoring/gold_h1b.json` **no** está en Pages
- [ ] Tras claim: regenerar pack A40/B48 y volver a publicar `public/data/`
- [ ] Probar: anotar 1 ítem → ver commit/archivo en `annotations/sync/` → export admin

---

## 7) Redeploy (cuando cambias código)

**Worker (fix 409 / sync)** — obligatorio tras editar `worker/worker.js`:

```bash
cd h1_web/worker
npx wrangler deploy
```

O en Cloudflare Dashboard → Workers → `vigia-h1-sync` → editar código → **Deploy**. Los secrets (`GITHUB_TOKEN`, `ADMIN_KEY`, …) no hace falta volver a ponerlos.

**UI (Pages)** — tras editar `app.js` / `index.html` / `config.js` / `public/`:

1. Commit + push al repo/branch que alimenta GitHub Pages.
2. Esperar el Action/deploy de Pages (o Settings → Pages → ver último deploy).
3. Hard refresh en el navegador (`Ctrl+F5`) para no usar JS cacheado.

Si solo cambió el Worker, **no** hace falta redeploy de Pages.

---

## 8) Desarrollo local (sin Pages)

```bash
# Terminal 1
python scripts/h1_web/sync_server.py
# :8766  admin default: vigia-h1-admin-change-me

# Terminal 2
cd h1_web && python -m http.server 8765
# config.js → http://127.0.0.1:8766
```

Datos locales: `h1_web/scoring/sync/` (gitignored).

---

## Resumen de secretos

| Dónde | Qué |
|-------|-----|
| Cloudflare Worker | `GITHUB_TOKEN`, `ADMIN_KEY` |
| Worker vars | `GITHUB_REPO`, `GITHUB_BRANCH` |
| `config.js` (público) | solo `apiBase` (URL del Worker) — **nunca** el admin key ni el PAT |
