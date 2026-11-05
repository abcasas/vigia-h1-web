# VIGIA H1 — gold audit (H1-A) + baremo (H1-B)

Piloto smoke + claim (A40/B48). **Avance parcial en servidor** — no hace falta terminar de un tirón ni mandar JSONL por email.

> **GitHub Pages es estático:** no puede guardar anotaciones. La UI va en Pages; el **sync API** escribe en disco (local) o en un repo vía Cloudflare Worker.

| Fase | Estímulo | Tarea |
|------|----------|--------|
| **H1-B** | F4 + mem | Elegir A/B (sin gold) |
| **H1-A** | F16 + mem + gold | `gold_ok` / `wrong` / `unsure` |

Anotadores: Luis de la Ossa · Jesús Martínez · Abraham Casas.

## Arranque local (UI + sync)

```bash
# Terminal 1 — sync (guarda en h1_web/scoring/sync/)
cd 01_Articulo/code
python scripts/h1_web/sync_server.py
# http://127.0.0.1:8766   admin key default: vigia-h1-admin-change-me

# Terminal 2 — UI estática
cd h1_web
python -m http.server 8765
# http://localhost:8765/
```

`config.js` apunta a `http://127.0.0.1:8766`. Cada etiqueta → merge en servidor. Al volver a entrar se **recarga** el avance.

**Admin** (mismo HTML): clave → “Descargar export total” (JSON + JSONL de los 3×2).

## Producción (Pages + Worker)

- Canónico: **esta carpeta** `h1_web/`.
- Pages: clone `D:\Analisis de datos\vigia-h1-web` (no editar ahí primero).
- Sync: `powershell -File scripts/h1_web/sync_to_pages.ps1` (`-Push`, `-DeployWorker`).
- Guía: **[DEPLOY_GITHUB.md](DEPLOY_GITHUB.md)** · skill: `.cursor/skills/h1-web-deploy/`.  
Detalle Worker: `worker/README.md`.

## Export pack de ítems

```bash
PYTHONPATH=. python scripts/h1_web/export_h1_smoke_pack.py
```

## Aggregate (cuando tengas JSONL)

```bash
python scripts/h1_web/h1_aggregate.py \
  --a-luis … --a-jesus … --a-abraham … \
  --b-luis … --b-jesus … --b-abraham … \
  --out H1_report.md
```
