/**
 * Cloudflare Worker — mismo contrato que sync_server.py
 * Secrets: GITHUB_TOKEN, ADMIN_KEY, GITHUB_REPO (owner/name), GITHUB_BRANCH (main)
 * Persiste JSON en repo: annotations/sync/{annotator}_{task}.json
 */
const ANNOTATORS = new Set(["luis", "jesus", "abraham"]);
const TASKS = new Set(["h1a", "h1b"]);

function cors(headers = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    ...headers,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mergeRecords(existing, incoming) {
  const out = { ...existing };
  for (const [iid, row] of Object.entries(incoming || {})) {
    const prev = out[iid];
    if (!prev || String(row.ts || "") >= String(prev.ts || "")) out[iid] = row;
  }
  return out;
}

async function ghGet(env, path) {
  const [owner, repo] = env.GITHUB_REPO.split("/");
  const branch = env.GITHUB_BRANCH || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "vigia-h1-sync",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function ghPut(env, path, contentObj, sha) {
  const [owner, repo] = env.GITHUB_REPO.split("/");
  const branch = env.GITHUB_BRANCH || "main";
  const body = {
    message: `h1-sync: ${path}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(contentObj, null, 2)))),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "vigia-h1-sync",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`PUT ${path}: ${res.status} ${t}`);
  }
  return res.json();
}

function filePath(annotator, task) {
  return `annotations/sync/${annotator}_${task}.json`;
}

async function loadDoc(env, annotator, task) {
  const meta = await ghGet(env, filePath(annotator, task));
  if (!meta) {
    return {
      doc: { annotator, task, records: {}, updated_at: null },
      sha: null,
    };
  }
  const text = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ""))));
  return { doc: JSON.parse(text), sha: meta.sha };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && (path === "/api/status" || path === "/status")) {
        const rows = [];
        for (const a of ANNOTATORS) {
          for (const t of TASKS) {
            const { doc } = await loadDoc(env, a, t);
            rows.push({
              annotator: a,
              task: t,
              n: Object.keys(doc.records || {}).length,
              updated_at: doc.updated_at,
            });
          }
        }
        return json({ ok: true, rows });
      }

      if (request.method === "GET" && (path === "/api/load" || path === "/load")) {
        const a = url.searchParams.get("annotator") || "";
        const t = url.searchParams.get("task") || "";
        if (!ANNOTATORS.has(a) || !TASKS.has(t)) {
          return json({ ok: false, error: "annotator/task inválidos" }, 400);
        }
        const { doc } = await loadDoc(env, a, t);
        return json({
          ok: true,
          annotator: a,
          task: t,
          records: doc.records || {},
          updated_at: doc.updated_at,
        });
      }

      if (request.method === "GET" && (path === "/api/export" || path === "/export")) {
        const key = url.searchParams.get("key") || request.headers.get("X-Admin-Key") || "";
        if (key !== env.ADMIN_KEY) {
          return json({ ok: false, error: "admin key inválida" }, 403);
        }
        const bundle = { exported_at: nowIso(), annotators: {}, jsonl: {} };
        for (const a of ANNOTATORS) {
          bundle.annotators[a] = {};
          for (const t of TASKS) {
            const { doc } = await loadDoc(env, a, t);
            const recs = doc.records || {};
            bundle.annotators[a][t] = {
              n: Object.keys(recs).length,
              updated_at: doc.updated_at,
              records: recs,
            };
            const lines = Object.values(recs).map((r) => JSON.stringify(r));
            bundle.jsonl[`${a}_${t}`] = lines.join("\n") + (lines.length ? "\n" : "");
          }
        }
        return json(bundle);
      }

      if (request.method === "POST" && (path === "/api/save" || path === "/save")) {
        const body = await request.json();
        const a = String(body.annotator || "");
        const t = String(body.task || "");
        const records = body.records;
        if (!ANNOTATORS.has(a) || !TASKS.has(t) || typeof records !== "object") {
          return json({ ok: false, error: "annotator/task/records inválidos" }, 400);
        }
        const { doc, sha } = await loadDoc(env, a, t);
        const merged = mergeRecords(doc.records || {}, records);
        const next = {
          annotator: a,
          task: t,
          records: merged,
          updated_at: nowIso(),
        };
        await ghPut(env, filePath(a, t), next, sha);
        return json({
          ok: true,
          annotator: a,
          task: t,
          n_items: Object.keys(merged).length,
          updated_at: next.updated_at,
        });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
