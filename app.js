(() => {
  const DATA_URL = "public/data/items.json";
  const CFG = window.H1_CONFIG || {};
  const API = (CFG.apiBase || "").replace(/\/$/, "");
  const STORE_VER = "v3";
  /** Legacy one-shot wipe flag (no longer auto-wipes server). Cleared on admin wipe. */
  const WIPE_FLAG = "vigia_baremo_f4_wiped_v3";

  let pack = null;
  /** @type {{clip_key:string, video_id:string, clip_id:any, scene:string, frames:string[], memory:string, epi:object|null, sem:object|null}[]} */
  let clips = [];
  let task = "";
  let idx = 0;
  let annotator = "";
  let store = {};
  let showQuestions = false;
  let syncTimer = null;
  let saveBusy = false;
  let saveQueued = false;
  let saveQueuedOpts = {};
  let saveConflictRetries = 0;

  const ANNOTATOR_LABELS = {
    luis: "Luis de la Ossa",
    jesus: "Jesús Martínez",
    abraham: "Abraham Casas",
  };

  const TASK_LABELS = {
    h1a: "Auditoría gold · F16",
    h1b: "Baremo humano · F4",
  };

  // Fuente de verdad: vigia_campana_limpia/qa_taxonomy.py → h1_web/contract.js
  const CONTRACT_PROMPT_F4 =
    (typeof window !== "undefined" && window.H1_CONTRACT_TEXT) ||
    "(contract.js missing — regenerate from qa_taxonomy.export_h1_contract_js)";

  const $ = (id) => document.getElementById(id);
  const login = $("login");
  const work = $("work");

  function key() {
    return `vigia_${STORE_VER}_${task}_${annotator}`;
  }

  function setSyncUi(msg, state) {
    ["syncStatus", "syncStatusWork"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.textContent = msg;
      el.dataset.state = state;
    });
  }

  function loadStoreLocal() {
    try {
      store = JSON.parse(localStorage.getItem(key()) || "{}");
    } catch {
      store = {};
    }
  }

  function saveStoreLocal() {
    localStorage.setItem(key(), JSON.stringify(store));
  }

  /** Same rule as Worker: newer ts wins keys; older fills omitted fields (compat). */
  function mergeByTs(a, b) {
    const out = { ...a };
    Object.entries(b || {}).forEach(([iid, row]) => {
      if (!row || typeof row !== "object") return;
      const prev = out[iid];
      if (!prev || typeof prev !== "object") {
        out[iid] = { ...row };
        return;
      }
      const rowNewer = String(row.ts || "") >= String(prev.ts || "");
      const newer = rowNewer ? row : prev;
      const older = rowNewer ? prev : row;
      out[iid] = { ...older, ...newer };
    });
    return out;
  }

  function groupClips(itemList) {
    const map = new Map();
    (itemList || []).forEach((it) => {
      const ck = it.clip_key || `${it.video_id}_c${it.clip_id}`;
      if (!map.has(ck)) {
        map.set(ck, {
          clip_key: ck,
          video_id: it.video_id,
          clip_id: it.clip_id,
          scene: it.scene,
          frames: it.frames || [],
          memory: it.memory || "",
          epi: null,
          sem: null,
        });
      }
      const g = map.get(ck);
      if ((it.frames || []).length > (g.frames || []).length) g.frames = it.frames;
      if (it.memory) g.memory = it.memory;
      const tr = String(it.track || "").toLowerCase();
      if (tr.startsWith("epi")) g.epi = it;
      else if (tr.startsWith("sem")) g.sem = it;
    });
    return Array.from(map.values());
  }

  function currentClip() {
    return clips[idx];
  }

  function tracksOf(clip) {
    return [clip.epi, clip.sem].filter(Boolean);
  }

  function clipDoneCount() {
    let n = 0;
    clips.forEach((c) => {
      const ts = tracksOf(c);
      if (!ts.length) return;
      const ok = ts.every((it) => {
        const r = store[it.item_id];
        if (!r) return false;
        return task === "h1a" ? !!r.label : !!r.choice;
      });
      if (ok) n += 1;
    });
    return n;
  }

  async function apiLoad() {
    if (!API) return null;
    const url = `${API}/api/load?annotator=${encodeURIComponent(annotator)}&task=${encodeURIComponent(task)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`load ${res.status}`);
    return res.json();
  }

  async function apiSave(opts = {}) {
    if (!API) {
      setSyncUi("Solo localStorage (sin API)", "off");
      return;
    }
    // Serialize: overlapping saves (typing + Sync / two tabs) race on GitHub SHA → 409.
    if (saveBusy) {
      saveQueued = true;
      saveQueuedOpts = {
        replace: !!(opts.replace || saveQueuedOpts.replace),
      };
      return;
    }
    saveBusy = true;
    const replace = !!opts.replace;
    setSyncUi(replace ? "Limpiando servidor…" : "Guardando…", "pending");
    try {
      const res = await fetch(`${API}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotator,
          task,
          records: store,
          replace,
          client_ts: new Date().toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.status);
      saveConflictRetries = 0;
      setSyncUi(`Sincronizado · ${data.n_items} ítems`, "ok");
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("409") && saveConflictRetries < 3) {
        saveConflictRetries += 1;
        setSyncUi(`Conflicto de sync (reintento ${saveConflictRetries}/3)…`, "pending");
        saveQueued = true;
        saveQueuedOpts = { replace: replace || !!saveQueuedOpts.replace };
      } else {
        saveConflictRetries = 0;
        setSyncUi(`Error sync: ${msg}`, "err");
      }
    } finally {
      saveBusy = false;
      if (saveQueued) {
        const q = saveQueuedOpts;
        saveQueued = false;
        saveQueuedOpts = {};
        await new Promise((r) => setTimeout(r, 200));
        await apiSave(q);
      }
    }
  }

  function scheduleSync() {
    saveStoreLocal();
    if (!API) {
      setSyncUi("Solo localStorage", "off");
      return;
    }
    setSyncUi("Pendiente de sync…", "pending");
    clearTimeout(syncTimer);
    // Slightly longer debounce: GitHub Contents PUT often >450ms → fewer races.
    syncTimer = setTimeout(() => apiSave(), 700);
  }

  function readWriteFields() {
    return {
      think_text: ($("thinkText").value || "").trim(),
      episodic_memory_text: ($("epiText").value || "").trim(),
      semantic_memory_text: ($("semText").value || "").trim(),
      note: ($("note").value || "").trim(),
    };
  }

  /** Persist shared write fields onto every track item of this clip. */
  function ensureClipDraft() {
    const clip = currentClip();
    if (!clip || task !== "h1b") return;
    const w = readWriteFields();
    const ts = new Date().toISOString();
    tracksOf(clip).forEach((it) => {
      const prev = store[it.item_id] || {};
      store[it.item_id] = {
        ...prev,
        task: "h1b",
        item_id: it.item_id,
        clip_key: clip.clip_key,
        track: it.track,
        annotator,
        think_text: w.think_text,
        episodic_memory_text: w.episodic_memory_text,
        semantic_memory_text: w.semantic_memory_text,
        note: w.note,
        ts,
      };
    });
    scheduleSync();
  }

  function syncToggleLabel() {
    const btn = $("btnToggleQuestion");
    if (btn) btn.textContent = showQuestions ? "Ocultar preguntas" : "Mostrar preguntas";
  }

  function setTrackChoice(itemId, choice) {
    const clip = currentClip();
    const it = tracksOf(clip).find((x) => x.item_id === itemId);
    if (!it) return;
    const w = readWriteFields();
    const prev = store[itemId] || {};
    store[itemId] = {
      ...prev,
      task: "h1b",
      item_id: itemId,
      clip_key: clip.clip_key,
      track: it.track,
      annotator,
      think_text: w.think_text || prev.think_text || "",
      episodic_memory_text: w.episodic_memory_text || prev.episodic_memory_text || "",
      semantic_memory_text: w.semantic_memory_text || prev.semantic_memory_text || "",
      choice,
      note: w.note,
      ts: new Date().toISOString(),
    };
    // keep sibling draft texts in sync
    ensureClipDraft();
    scheduleSync();
    render();
  }

  function setTrackLabel(itemId, label) {
    const clip = currentClip();
    const it = tracksOf(clip).find((x) => x.item_id === itemId);
    if (!it) return;
    const prev = store[itemId] || {};
    store[itemId] = {
      ...prev,
      task: "h1a",
      item_id: itemId,
      clip_key: clip.clip_key,
      track: it.track,
      annotator,
      label,
      text_only_guessable: $("textOnly").checked,
      note: ($("note").value || "").trim(),
      ts: new Date().toISOString(),
    };
    scheduleSync();
    render();
  }

  function buildQuestionBlocks(clip) {
    const panel = $("questionPanel");
    panel.innerHTML = "";
    tracksOf(clip).forEach((it) => {
      const prev = store[it.item_id] || {};
      const trackName = String(it.track || "").toLowerCase().startsWith("sem")
        ? "Semantic"
        : "Episodic";
      const block = document.createElement("div");
      block.className = "q-block";
      const slot = it.type_slot || it.epi_type_slot || it.sem_type_slot || "";
      const slotChip = slot
        ? `<span class="chip muted" title="Factory QA slot">${escapeHtml(String(slot))}</span>`
        : "";
      block.innerHTML = `
        <div class="q-head"><span class="chip">${trackName}</span>${slotChip}
          <span class="chip muted">${it.item_id}</span></div>
        <div class="stmts">
          <p class="stmt"><strong>A</strong> ${escapeHtml(it.statement_a || "")}</p>
          <p class="stmt"><strong>B</strong> ${escapeHtml(it.statement_b || "")}</p>
          ${
            task === "h1a"
              ? `<p class="gold">Gold: <strong>${escapeHtml(String(it.gold || ""))}</strong></p>`
              : ""
          }
        </div>
        <div class="actions" data-item="${escapeAttr(it.item_id)}"></div>
      `;
      const actions = block.querySelector(".actions");
      if (task === "h1a") {
        [
          ["gold_ok", "Gold correcto"],
          ["gold_wrong", "Gold incorrecto"],
          ["unsure", "No estoy seguro"],
        ].forEach(([val, lab]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = lab;
          b.dataset.label = val;
          if (prev.label === val) b.classList.add("active");
          b.onclick = () => setTrackLabel(it.item_id, val);
          actions.appendChild(b);
        });
      } else {
        [
          ["A", "Elijo A"],
          ["B", "Elijo B"],
          ["unsure", "No estoy seguro"],
        ].forEach(([val, lab]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = lab;
          b.dataset.choice = val;
          if (prev.choice === val) b.classList.add("active");
          b.onclick = () => setTrackChoice(it.item_id, val);
          actions.appendChild(b);
        });
      }
      panel.appendChild(block);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function render() {
    const clip = currentClip();
    if (!clip) return;
    const name = ANNOTATOR_LABELS[annotator] || annotator;
    const done = clipDoneCount();
    const isA = task === "h1a";
    const taskLabel = TASK_LABELS[task] || task;

    $("prog").textContent = `${taskLabel} · clip ${idx + 1} / ${clips.length} · ${name} · ${done} clips listos`;
    const bar = $("progBar");
    if (bar && clips.length) {
      bar.style.width = `${Math.round(((idx + 1) / clips.length) * 100)}%`;
    }
    $("ids").textContent = `${clip.clip_key} · ${clip.scene || ""} · tracks: ${tracksOf(clip)
      .map((t) => t.track)
      .join("+")}`;

    const cp = $("contractPrompt");
    if (cp) cp.textContent = CONTRACT_PROMPT_F4;

    $("oracleMem").classList.add("hidden");
    $("writePanel").classList.add("hidden");
    $("questionPanel").classList.add("hidden");
    $("flagRow").classList.add("hidden");

    const fr = $("frames");
    fr.innerHTML = "";
    fr.className = isA ? "frames frames16" : "frames";
    (clip.frames || []).forEach((rel) => {
      const img = document.createElement("img");
      img.src = `public/data/${rel}`;
      img.alt = rel;
      fr.appendChild(img);
    });

    // Prefill shared fields from epi record (or sem)
    const seedIt = clip.epi || clip.sem;
    const prev = (seedIt && store[seedIt.item_id]) || {};
    $("note").value = prev.note || "";
    $("textOnly").checked = !!prev.text_only_guessable;
    $("thinkText").value = prev.think_text || "";
    $("epiText").value = prev.episodic_memory_text || "";
    $("semText").value = prev.semantic_memory_text || "";
    $("memory").textContent = clip.memory || "(vacío)";

    if (isA) {
      showQuestions = true;
      $("oracleMem").classList.remove("hidden");
      $("questionPanel").classList.remove("hidden");
      $("flagRow").classList.remove("hidden");
      $("taskHint").textContent =
        "Auditoría gold: un clip, memoria oracle, y las dos preguntas (epi + sem) con su gold.";
      buildQuestionBlocks(clip);
    } else {
      $("writePanel").classList.remove("hidden");
      $("taskHint").textContent =
        "Baremo F4: un clip → textos opcionales compartidos → Mostrar preguntas (epi + sem). Al cambiar de clip se ocultan otra vez.";
      syncToggleLabel();
      if (showQuestions) {
        $("questionPanel").classList.remove("hidden");
        buildQuestionBlocks(clip);
      } else {
        $("questionPanel").innerHTML = "";
      }
    }
  }

  function toJsonl(records) {
    return Object.values(records || {})
      .map((r) => JSON.stringify(r))
      .join("\n");
  }

  function downloadLocal() {
    const body = toJsonl(store);
    const blob = new Blob([body + (body ? "\n" : "")], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `annotations_${annotator}_${task}.jsonl`;
    a.click();
  }

  async function ensurePack() {
    if (pack) return pack;
    const res = await fetch(DATA_URL);
    if (!res.ok) {
      alert("No se pudo cargar public/data/items.json");
      return null;
    }
    pack = await res.json();
    return pack;
  }

  /** Drop only ancient localStorage keys; never touch the server. */
  function scrubLegacyLocalKeys() {
    ["luis", "jesus", "abraham"].forEach((a) => {
      ["h1a", "h1b"].forEach((t) => {
        try {
          localStorage.removeItem(`vigia_${t}_${a}`);
          localStorage.removeItem(`vigia_v2_${t}_${a}`);
        } catch (_) {}
      });
    });
  }

  async function hydrateFromServer() {
    loadStoreLocal();
    if (!API) {
      setSyncUi("Solo localStorage", "off");
      return;
    }
    try {
      const remote = await apiLoad();
      store = mergeByTs(store, remote.records || {});
      saveStoreLocal();
      setSyncUi(`Servidor OK · ${Object.keys(store).length} ítems`, "ok");
    } catch (e) {
      setSyncUi(`Sin servidor (${e.message}) · usando local`, "err");
    }
  }

  async function start(phase) {
    annotator = $("annotator").value;
    if (!annotator) {
      alert("Elige anotador");
      return;
    }
    const data = await ensurePack();
    if (!data) return;
    task = phase;
    clips = groupClips(data[phase] || []);
    if (!clips.length) {
      alert(`Sin clips para ${phase}`);
      return;
    }

    scrubLegacyLocalKeys();
    await hydrateFromServer();

    idx = 0;
    showQuestions = phase === "h1a";
    login.classList.add("hidden");
    work.classList.remove("hidden");
    render();
  }

  function goHome() {
    work.classList.add("hidden");
    login.classList.remove("hidden");
    showQuestions = false;
    pingStatus();
  }

  async function adminExport() {
    if (!API) {
      alert("Configura apiBase");
      return;
    }
    const key = $("adminKey").value.trim();
    if (!key) {
      alert("Clave admin");
      return;
    }
    $("adminMsg").textContent = "Exportando…";
    try {
      const res = await fetch(`${API}/api/export?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.status);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `H1_export_${(data.exported_at || "").replace(/[:.]/g, "")}.json`;
      a.click();
      Object.entries(data.jsonl || {}).forEach(([name, text]) => {
        if (!text) return;
        const b = new Blob([text], { type: "application/x-ndjson" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(b);
        link.download = `annotations_${name}.jsonl`;
        link.click();
      });
      $("adminMsg").textContent = `OK ${data.exported_at || ""}`;
    } catch (e) {
      $("adminMsg").textContent = `Error: ${e.message || e}`;
    }
  }

  async function pingStatus() {
    const el = $("apiHint");
    if (!API) {
      if (el) el.textContent = "API desactivada.";
      return;
    }
    try {
      const res = await fetch(`${API}/api/status`);
      const data = await res.json();
      const total = (data.rows || []).reduce((s, r) => s + (r.n || 0), 0);
      if (el) el.textContent = `API ${API} · ${total} anotaciones`;
    } catch {
      if (el) el.textContent = `API ${API} no responde`;
    }
  }

  $("btnStartA").onclick = () => start("h1a");
  $("btnStartB").onclick = () => start("h1b");
  $("btnHome").onclick = goHome;
  if ($("brandHome")) $("brandHome").onclick = goHome;

  $("btnToggleQuestion").onclick = () => {
    showQuestions = !showQuestions;
    if (task === "h1b") ensureClipDraft();
    render();
  };

  ["thinkText", "epiText", "semText"].forEach((id) => {
    $(id).addEventListener("change", () => {
      if (task === "h1b") ensureClipDraft();
    });
  });

  $("textOnly").onchange = () => {
    const clip = currentClip();
    if (!clip || task !== "h1a") return;
    tracksOf(clip).forEach((it) => {
      if (!store[it.item_id]) return;
      store[it.item_id].text_only_guessable = $("textOnly").checked;
      store[it.item_id].ts = new Date().toISOString();
    });
    scheduleSync();
  };
  $("note").onchange = () => {
    if (task === "h1b") ensureClipDraft();
    else {
      const clip = currentClip();
      if (!clip) return;
      const note = $("note").value.trim();
      tracksOf(clip).forEach((it) => {
        if (!store[it.item_id]) return;
        store[it.item_id].note = note;
        store[it.item_id].ts = new Date().toISOString();
      });
      scheduleSync();
    }
  };

  $("btnPrev").onclick = () => {
    if (task === "h1b") ensureClipDraft();
    showQuestions = task === "h1a";
    idx = Math.max(0, idx - 1);
    render();
  };
  $("btnNext").onclick = () => {
    if (task === "h1b") ensureClipDraft();
    showQuestions = task === "h1a";
    idx = Math.min(clips.length - 1, idx + 1);
    render();
  };
  $("btnDownload").onclick = downloadLocal;
  $("btnSyncNow").onclick = () => apiSave();
  $("btnAdminExport").onclick = adminExport;

  async function adminWipe() {
    if (!API) {
      alert("Sin API");
      return;
    }
    const key = $("adminKey").value.trim();
    if (!key) {
      alert("Introduce la clave admin");
      return;
    }
    const scope = ($("wipeScope") && $("wipeScope").value) || "baremo";
    const label =
      scope === "audit"
        ? "auditoría gold"
        : scope === "all"
          ? "TODAS las anotaciones (baremo + auditoría)"
          : "baremo F4";
    const ok1 = window.confirm(
      `¿Resetear ${label} para los 3 anotadores en el servidor?\n\nEsto no se puede deshacer (salvo un export previo).`
    );
    if (!ok1) return;
    const typed = window.prompt(
      `Segunda confirmación: escribe exactamente RESET para borrar ${label}.`
    );
    if (typed !== "RESET") {
      $("adminMsg").textContent = "Cancelado (no escribiste RESET).";
      return;
    }
    $("adminMsg").textContent = "Reseteando…";
    try {
      const res = await fetch(`${API}/api/wipe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": key,
        },
        body: JSON.stringify({ key, scope }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.status);
      // Clear local caches for this browser
      ["luis", "jesus", "abraham"].forEach((a) => {
        ["h1a", "h1b"].forEach((t) => {
          try {
            localStorage.removeItem(`vigia_${STORE_VER}_${t}_${a}`);
            localStorage.removeItem(`vigia_v2_${t}_${a}`);
            localStorage.removeItem(`vigia_${t}_${a}`);
          } catch (_) {}
        });
      });
      try {
        localStorage.removeItem(WIPE_FLAG);
      } catch (_) {}
      store = {};
      $("adminMsg").textContent = `OK reset ${scope} · ${((data.cleared || []).length)} archivos · ${data.updated_at || ""}`;
      pingStatus();
    } catch (e) {
      $("adminMsg").textContent = `Error wipe: ${e.message || e}. Si 404, redeploy Worker con /api/wipe.`;
    }
  }

  if ($("btnAdminWipe")) $("btnAdminWipe").onclick = adminWipe;

  pingStatus();
})();
