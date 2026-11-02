(() => {
  const DATA_URL = "public/data/items.json";
  const CFG = window.H1_CONFIG || {};
  const API = (CFG.apiBase || "").replace(/\/$/, "");

  let pack = null;
  let items = [];
  let task = "";
  let idx = 0;
  let annotator = "";
  let store = {};
  /** @type {"write"|"answer"} */
  let h1bPhase = "write";
  let syncTimer = null;
  let syncState = "idle";

  const ANNOTATOR_LABELS = {
    luis: "Luis de la Ossa",
    jesus: "Jesús Martínez",
    abraham: "Abraham Casas",
  };

  const $ = (id) => document.getElementById(id);
  const login = $("login");
  const work = $("work");

  function key() {
    return `vigia_${task}_${annotator}`;
  }

  function setSyncUi(msg, state) {
    syncState = state;
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

  async function apiSave() {
    if (!API) {
      setSyncUi("Solo localStorage (sin API)", "off");
      return;
    }
    setSyncUi("Guardando en servidor…", "pending");
    try {
      const res = await fetch(`${API}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotator,
          task,
          records: store,
          client_ts: new Date().toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.status);
      setSyncUi(`Sincronizado · ${data.n_items} ítems · ${data.updated_at || ""}`, "ok");
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
      ui_phase: h1bPhase,
      ts: new Date().toISOString(),
    };
    scheduleSync();
  }

  function resolveH1bPhase(prev) {
    if (prev && prev.ui_phase === "answer") return "answer";
    if (prev && prev.choice) return "answer";
    return "write";
  }

  function render() {
    const it = current();
    if (!it) return;
    const name = ANNOTATOR_LABELS[annotator] || annotator;
    const done = Object.keys(store).length;
    const prev = store[it.item_id] || {};
    const isA = task === "h1a";

    $("prog").textContent = `${task.toUpperCase()} · ${idx + 1} / ${items.length} · ${name} · ${done} guardados`;
    const bar = $("progBar");
    if (bar && items.length) {
      bar.style.width = `${Math.round(((idx + 1) / items.length) * 100)}%`;
    }
    $("track").textContent = it.track;
    $("ids").textContent = `${it.video_id} c${it.clip_id} · ${it.item_id}`;
    $("memory").textContent = it.memory || "(vacío)";
    $("sa").textContent = it.statement_a;
    $("sb").textContent = it.statement_b;

    if (isA) {
      h1bPhase = "answer";
      $("oracleMem").classList.remove("hidden");
      $("writePanel").classList.add("hidden");
      $("questionPanel").classList.remove("hidden");
      $("btnBackWrite").classList.add("hidden");
      $("goldRow").classList.remove("hidden");
      $("actionsA").classList.remove("hidden");
      $("actionsB").classList.add("hidden");
      $("flagRow").classList.remove("hidden");
      $("gold").textContent = it.gold;
      $("taskHint").textContent =
        "H1-A: con 16 frames + memoria oracle, ¿el gold es correcto? (auditoría del dato).";
    } else {
      h1bPhase = resolveH1bPhase(prev);
      $("oracleMem").classList.add("hidden");
      $("goldRow").classList.add("hidden");
      $("actionsA").classList.add("hidden");
      $("flagRow").classList.add("hidden");
      $("actionsB").classList.remove("hidden");
      $("taskHint").textContent =
        "H1-B (main F4): sin memoria M3. Opcional: escribe think / epi / sem (vacío OK) → Avanzar → elige A/B. Se guarda todo.";

      const showWrite = h1bPhase === "write";
      $("writePanel").classList.toggle("hidden", !showWrite);
      $("questionPanel").classList.toggle("hidden", showWrite);
      $("btnBackWrite").classList.toggle("hidden", showWrite);
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
      ui_phase: "answer",
      ts: new Date().toISOString(),
    };
    h1bPhase = "answer";
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
    loadStoreLocal();
    if (API) {
      setSyncUi("Cargando avance del servidor…", "pending");
      try {
        const remote = await apiLoad();
        store = mergeByTs(store, remote.records || {});
        saveStoreLocal();
        setSyncUi(
          `Servidor OK · ${Object.keys(store).length} ítems (merge local)`,
          "ok"
        );
      } catch (e) {
        setSyncUi(`Sin servidor (${e.message}); usando local`, "err");
      }
    } else {
      setSyncUi("Sin API — solo este navegador", "off");
    }
    idx = 0;
    h1bPhase = "write";
    login.classList.add("hidden");
    work.classList.remove("hidden");
    render();
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
      const bits =
        (data.annotators &&
          Object.entries(data.annotators)
            .map(([a, tasks]) => {
              const n = Object.values(tasks).reduce((s, t) => s + (t.n || 0), 0);
              return `${a}:${n}`;
            })
            .join(" · ")) ||
        "";
      $("adminMsg").textContent = `OK ${data.exported_at || ""} · ${bits}`;
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
        el.textContent = `API ${API} no responde — arranca sync_server.py o revisa Worker`;
    }
  }

  $("btnStartA").onclick = () => start("h1a");
  $("btnStartB").onclick = () => start("h1b");
  $("btnHome").onclick = () => {
    work.classList.add("hidden");
    login.classList.remove("hidden");
    pingStatus();
  };

  $("btnToQuestion").onclick = () => {
    h1bPhase = "answer";
    ensureH1BDraft();
    render();
  };
  $("btnBackWrite").onclick = () => {
    h1bPhase = "write";
    ensureH1BDraft();
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
    if (task === "h1b") ensureH1BDraft();
    idx = Math.max(0, idx - 1);
    render();
  };
  $("btnNext").onclick = () => {
    if (task === "h1b") ensureH1BDraft();
    idx = Math.min(items.length - 1, idx + 1);
    render();
  };
  $("btnDownload").onclick = downloadLocal;
  $("btnSyncNow").onclick = () => apiSave();
  $("btnAdminExport").onclick = adminExport;

  pingStatus();
})();
