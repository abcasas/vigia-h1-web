(() => {
  const DATA_URL = "public/data/items.json";
  const CFG = window.H1_CONFIG || {};
  const API = (CFG.apiBase || "").replace(/\/$/, "");
  /** Bump to abandon stale localStorage from early smoke tests */
  const STORE_VER = "v2";
  const WIPE_FLAG = "vigia_baremo_f4_wiped_v2";

  let pack = null;
  let items = [];
  let task = "";
  let idx = 0;
  let annotator = "";
  let store = {};
  /** Baremo F4: question panel visibility (never restored from disk) */
  let showQuestion = false;
  let syncTimer = null;

  const ANNOTATOR_LABELS = {
    luis: "Luis de la Ossa",
    jesus: "Jesús Martínez",
    abraham: "Abraham Casas",
  };

  const TASK_LABELS = {
    h1a: "Auditoría gold · F16",
    h1b: "Baremo humano · F4",
  };

  // Canonical main F4 from vigia_campana_limpia/prompts.py
  const CONTRACT_PROMPT_F4 = [
    "=== SYSTEM (SYSTEM_PROMPT_EPI_FULL) ===",
    "You are an expert that watches a 30-second video clip from four key frames and answers one closed A/B contrastive question about episodic content.",
    "",
    "Output in ONE turn, in this order:",
    "1. <think>...</think> — brief reasoning about the frames and the question.",
    "2. <episodic_memory>...</episodic_memory> — chronological episodes (at least 10 characters).",
    "3. Exactly one tag: <choice>A</choice> or <choice>B</choice>.",
    "Do not output <choice_sem>, <choice_epi>, or a second <choice>.",
    "Do not use video identifiers or filenames to invent content.",
    "Do not call tools.",
    "",
    "=== USER scaffold (frames4 · A/B text only after Mostrar pregunta) ===",
    "Produce tagged episodic memory for this clip from the frames, then answer the question.",
    "### Episodic contrastive question",
    "<stem>",
    "A) <statement_a>",
    "B) <statement_b>",
    "After memory, output <choice>A</choice> or <choice>B</choice>.",
    "Do not output choice_sem.",
  ].join("\n");

  const $ = (id) => document.getElementById(id);
  const login = $("login");
  const work = $("work");

  function key() {
    return `vigia_${STORE_VER}_${task}_${annotator}`;
  }

  function setSyncUi(msg, state) {
    const el = $("syncStatus");
    if (el) {
      el.textContent = msg;
      el.dataset.state = state;
    }
    const elw = $("syncStatusWork");
    if (elw) {
      elw.textContent = msg;
      elw.dataset.state = state;
    }
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

  function mergeByTs(a, b) {
    const out = { ...a };
    Object.entries(b || {}).forEach(([iid, row]) => {
      const prev = out[iid];
      if (!prev || String(row.ts || "") >= String(prev.ts || "")) out[iid] = row;
    });
    return out;
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
    const replace = !!opts.replace;
    setSyncUi(replace ? "Limpiando servidor…" : "Guardando en servidor…", "pending");
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
      setSyncUi(
        `Sincronizado · ${data.n_items} ítems · ${data.updated_at || ""}${replace ? " (replace)" : ""}`,
        "ok"
      );
    } catch (e) {
      setSyncUi(`Error sync: ${e.message || e} (sigue en este navegador)`, "err");
    }
  }

  function scheduleSync() {
    saveStoreLocal();
    if (!API) {
      setSyncUi("Solo localStorage — configura API en config.js", "off");
      return;
    }
    setSyncUi("Pendiente de sync…", "pending");
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      apiSave();
    }, 450);
  }

  function current() {
    return items[idx];
  }

  function readWriteFields() {
    return {
      think_text: ($("thinkText").value || "").trim(),
      episodic_memory_text: ($("epiText").value || "").trim(),
      semantic_memory_text: ($("semText").value || "").trim(),
    };
  }

  function ensureH1BDraft() {
    const it = current();
    if (!it || task !== "h1b") return;
    const prev = store[it.item_id] || {};
    const w = readWriteFields();
    store[it.item_id] = {
      ...prev,
      task: "h1b",
      item_id: it.item_id,
      clip_key: it.clip_key,
      track: it.track,
      annotator,
      think_text: w.think_text,
      episodic_memory_text: w.episodic_memory_text,
      semantic_memory_text: w.semantic_memory_text,
      note: ($("note").value || "").trim(),
      ts: new Date().toISOString(),
    };
    scheduleSync();
  }

  function syncToggleLabel() {
    const btn = $("btnToggleQuestion");
    if (!btn) return;
    btn.textContent = showQuestion ? "Ocultar pregunta" : "Mostrar pregunta";
  }

  function render() {
    const it = current();
    if (!it) return;
    const name = ANNOTATOR_LABELS[annotator] || annotator;
    const done = Object.keys(store).length;
    const prev = store[it.item_id] || {};
    const isA = task === "h1a";
    const taskLabel = TASK_LABELS[task] || task;

    $("prog").textContent = `${taskLabel} · ${idx + 1} / ${items.length} · ${name} · ${done} guardados`;
    const bar = $("progBar");
    if (bar && items.length) {
      bar.style.width = `${Math.round(((idx + 1) / items.length) * 100)}%`;
    }
    $("track").textContent = it.track;
    $("ids").textContent = `${it.video_id} c${it.clip_id} · ${it.item_id}`;
    $("memory").textContent = it.memory || "(vacío)";
    $("sa").textContent = it.statement_a;
    $("sb").textContent = it.statement_b;

    const cp = $("contractPrompt");
    if (cp) cp.textContent = CONTRACT_PROMPT_F4;

    $("oracleMem").classList.add("hidden");
    $("writePanel").classList.add("hidden");
    $("questionPanel").classList.add("hidden");
    $("actionsA").classList.add("hidden");
    $("actionsB").classList.add("hidden");
    $("goldRow").classList.add("hidden");
    $("flagRow").classList.add("hidden");

    if (isA) {
      showQuestion = true;
      $("oracleMem").classList.remove("hidden");
      $("questionPanel").classList.remove("hidden");
      $("actionsA").classList.remove("hidden");
      $("goldRow").classList.remove("hidden");
      $("flagRow").classList.remove("hidden");
      $("gold").textContent = it.gold;
      $("taskHint").textContent =
        "Auditoría gold: 16 frames + memoria oracle. ¿El gold del dataset es correcto?";
    } else {
      // Baremo F4: ALWAYS show write panel; question only if toggled this item.
      $("writePanel").classList.remove("hidden");
      $("taskHint").textContent =
        "Baremo F4: sin memoria oracle. Escribe textos (opcional) y usa «Mostrar pregunta». Al cambiar de ítem la pregunta se oculta otra vez.";
      syncToggleLabel();
      if (showQuestion) {
        $("questionPanel").classList.remove("hidden");
        $("actionsB").classList.remove("hidden");
      }
    }

    const fr = $("frames");
    fr.innerHTML = "";
    fr.className = isA ? "frames frames16" : "frames";
    (it.frames || []).forEach((rel) => {
      const img = document.createElement("img");
      img.src = `public/data/${rel}`;
      img.alt = rel;
      fr.appendChild(img);
    });

    $("note").value = prev.note || "";
    $("textOnly").checked = !!prev.text_only_guessable;
    $("thinkText").value = prev.think_text || "";
    $("epiText").value = prev.episodic_memory_text || "";
    $("semText").value = prev.semantic_memory_text || "";

    document.querySelectorAll("#actionsA button").forEach((b) => {
      b.classList.toggle("active", b.dataset.label === prev.label);
    });
    document.querySelectorAll("#actionsB button").forEach((b) => {
      b.classList.toggle("active", b.dataset.choice === prev.choice);
    });
  }

  function setH1A(label) {
    const it = current();
    store[it.item_id] = {
      task: "h1a",
      item_id: it.item_id,
      clip_key: it.clip_key,
      track: it.track,
      annotator,
      label,
      text_only_guessable: $("textOnly").checked,
      note: $("note").value.trim(),
      ts: new Date().toISOString(),
    };
    scheduleSync();
    render();
  }

  function setH1B(choice) {
    const it = current();
    const w = readWriteFields();
    const prev = store[it.item_id] || {};
    store[it.item_id] = {
      ...prev,
      task: "h1b",
      item_id: it.item_id,
      clip_key: it.clip_key,
      track: it.track,
      annotator,
      think_text: w.think_text || prev.think_text || "",
      episodic_memory_text: w.episodic_memory_text || prev.episodic_memory_text || "",
      semantic_memory_text: w.semantic_memory_text || prev.semantic_memory_text || "",
      choice,
      note: $("note").value.trim(),
      ts: new Date().toISOString(),
    };
    showQuestion = true;
    scheduleSync();
    render();
  }

  function toJsonl(records) {
    return Object.values(records || {})
      .map((r) => JSON.stringify(r))
      .join("\n");
  }

  function downloadLocal() {
    const body = toJsonl(store);
    const blob = new Blob([body + (body ? "\n" : "")], {
      type: "application/x-ndjson",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `annotations_${annotator}_${task}.jsonl`;
    a.click();
  }

  async function ensurePack() {
    if (pack) return pack;
    const res = await fetch(DATA_URL);
    if (!res.ok) {
      alert("No se pudo cargar public/data/items.json — ejecuta export_h1_smoke_pack.py");
      return null;
    }
    pack = await res.json();
    return pack;
  }

  /** One-time wipe of stale baremo F4 annotations (local + server replace for all annotators). */
  async function wipeBaremoF4IfNeeded() {
    if (localStorage.getItem(WIPE_FLAG)) return;
    store = {};
    saveStoreLocal();
    ["luis", "jesus", "abraham"].forEach((a) => {
      try {
        localStorage.removeItem(`vigia_h1b_${a}`);
        localStorage.removeItem(`vigia_v2_h1b_${a}`);
      } catch (_) {}
    });
    if (API) {
      for (const a of ["luis", "jesus", "abraham"]) {
        try {
          const res = await fetch(`${API}/api/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              annotator: a,
              task: "h1b",
              records: {},
              replace: true,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || res.status);
        } catch (e) {
          console.warn("wipe h1b failed for", a, e);
          setSyncUi(
            `Wipe parcial: redeploy Worker con worker.js nuevo (replace). ${e.message || e}`,
            "err"
          );
        }
      }
    }
    localStorage.setItem(WIPE_FLAG, new Date().toISOString());
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
    items = data[phase] || [];
    if (!items.length) {
      alert(`Sin ítems para ${phase}`);
      return;
    }

    if (phase === "h1b") {
      await wipeBaremoF4IfNeeded();
      loadStoreLocal();
      // After wipe, do not re-merge old remote unless wipe failed (empty store OK)
      if (API && Object.keys(store).length === 0 && localStorage.getItem(WIPE_FLAG)) {
        // already wiped / empty — skip loading stale remote into UI
        setSyncUi("Baremo F4 limpio (datos smoke antiguos descartados)", "ok");
      } else if (API) {
        try {
          const remote = await apiLoad();
          store = mergeByTs(store, remote.records || {});
          saveStoreLocal();
          setSyncUi(`Servidor OK · ${Object.keys(store).length} ítems`, "ok");
        } catch (e) {
          setSyncUi(`Sin servidor (${e.message}); usando local`, "err");
        }
      }
    } else {
      loadStoreLocal();
      if (API) {
        setSyncUi("Cargando avance del servidor…", "pending");
        try {
          const remote = await apiLoad();
          store = mergeByTs(store, remote.records || {});
          saveStoreLocal();
          setSyncUi(`Servidor OK · ${Object.keys(store).length} ítems`, "ok");
        } catch (e) {
          setSyncUi(`Sin servidor (${e.message}); usando local`, "err");
        }
      } else {
        setSyncUi("Sin API — solo este navegador", "off");
      }
    }

    idx = 0;
    showQuestion = phase === "h1a";
    login.classList.add("hidden");
    work.classList.remove("hidden");
    render();
  }

  function goHome() {
    work.classList.add("hidden");
    login.classList.remove("hidden");
    showQuestion = false;
    pingStatus();
  }

  async function adminExport() {
    if (!API) {
      alert("Configura apiBase en config.js");
      return;
    }
    const key = $("adminKey").value.trim();
    if (!key) {
      alert("Introduce la clave admin");
      return;
    }
    $("adminMsg").textContent = "Exportando…";
    try {
      const res = await fetch(`${API}/api/export?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.status);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
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
      if (el) el.textContent = "API desactivada (solo localStorage).";
      return;
    }
    try {
      const res = await fetch(`${API}/api/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(String(res.status));
      const total = (data.rows || []).reduce((s, r) => s + (r.n || 0), 0);
      if (el) el.textContent = `API ${API} · ${total} anotaciones en servidor`;
    } catch (e) {
      if (el)
        el.textContent = `API ${API} no responde — revisa Worker`;
    }
  }

  $("btnStartA").onclick = () => start("h1a");
  $("btnStartB").onclick = () => start("h1b");
  $("btnHome").onclick = goHome;
  if ($("brandHome")) $("brandHome").onclick = goHome;

  $("btnToggleQuestion").onclick = () => {
    showQuestion = !showQuestion;
    if (task === "h1b") ensureH1BDraft();
    render();
  };

  ["thinkText", "epiText", "semText"].forEach((id) => {
    $(id).addEventListener("change", () => {
      if (task === "h1b") ensureH1BDraft();
    });
  });

  document.querySelectorAll("#actionsA button").forEach((b) => {
    b.onclick = () => setH1A(b.dataset.label);
  });
  document.querySelectorAll("#actionsB button").forEach((b) => {
    b.onclick = () => setH1B(b.dataset.choice);
  });

  $("textOnly").onchange = () => {
    const it = current();
    if (!store[it.item_id] || task !== "h1a") return;
    store[it.item_id].text_only_guessable = $("textOnly").checked;
    store[it.item_id].ts = new Date().toISOString();
    scheduleSync();
  };
  $("note").onchange = () => {
    const it = current();
    if (!store[it.item_id]) return;
    store[it.item_id].note = $("note").value.trim();
    store[it.item_id].ts = new Date().toISOString();
    scheduleSync();
  };
  $("btnPrev").onclick = () => {
    if (task === "h1b") {
      ensureH1BDraft();
      showQuestion = false; // always hide question when changing item
    }
    idx = Math.max(0, idx - 1);
    render();
  };
  $("btnNext").onclick = () => {
    if (task === "h1b") {
      ensureH1BDraft();
      showQuestion = false;
    }
    idx = Math.min(items.length - 1, idx + 1);
    render();
  };
  $("btnDownload").onclick = downloadLocal;
  $("btnSyncNow").onclick = () => apiSave();
  $("btnAdminExport").onclick = adminExport;

  pingStatus();
})();
