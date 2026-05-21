/* ----------------------------------------------------------------------
   Claude Amplifier dashboard — frontend logic.
   Vanilla JS (no deps, no build step). ES2017+.
   ---------------------------------------------------------------------- */

(function () {
  "use strict";

  // -- DOM helpers -------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "dataset") {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      } else {
        node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      if (typeof c === "string" || typeof c === "number") {
        node.appendChild(document.createTextNode(String(c)));
      } else {
        node.appendChild(c);
      }
    }
    return node;
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  // -- State -------------------------------------------------------------
  const state = {
    project: "",
    activeTab: "lessons",
    loaded: { lessons: false, decisions: false, patterns: false, stats: false },
  };

  // -- Tabs --------------------------------------------------------------
  function activateTab(name) {
    state.activeTab = name;
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $$(".panel").forEach((p) => {
      const on = p.id === `panel-${name}`;
      p.classList.toggle("is-active", on);
      if (on) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });
    loadTab(name);
  }

  function loadTab(name) {
    switch (name) {
      case "lessons":   return loadLessons();
      case "decisions": return loadDecisions();
      case "patterns":  return loadPatterns();
      case "stats":     return loadStats();
    }
  }

  // -- Lessons -----------------------------------------------------------
  async function loadLessons() {
    const list = $("#lessons-list");
    list.innerHTML = '<div class="loading">Loading lessons…</div>';
    const url = state.project
      ? `/api/lessons?project=${encodeURIComponent(state.project)}`
      : "/api/lessons";
    try {
      const lessons = await getJson(url);
      if (!lessons.length) {
        list.innerHTML = '<div class="empty">No lessons recorded yet.</div>';
        return;
      }
      list.innerHTML = "";
      for (const l of lessons) list.appendChild(renderLessonCard(l));
    } catch (err) {
      list.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderLessonCard(l) {
    const status = l.verification_status || "confirmed";
    const sev = l.severity || "medium";
    const freq = l.frequency || 1;
    const tags = Array.isArray(l.tags) ? l.tags : [];

    const card = el("article", {
      class: `card is-${status}`,
      tabindex: "0",
      role: "button",
      "aria-label": `Lesson: ${l.title}`,
      onclick: () => openEvidenceModal("lesson", l.id, l.title),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEvidenceModal("lesson", l.id, l.title);
        }
      },
    }, [
      el("div", { class: "card-head" }, [
        el("div", { class: "card-title" }, l.title || "(untitled)"),
        el("div", { class: "card-meta" }, [
          el("span", { class: `badge badge-${status}` }, status),
          el("span", { class: `badge badge-${sev}` }, sev),
          freq > 1 ? el("span", { class: "badge badge-freq" }, `×${freq}`) : null,
          el("span", {}, l.project || ""),
        ]),
      ]),
      l.description ? el("div", { class: "card-desc" }, l.description) : null,
      tags.length ? el("div", { class: "card-tags" }, tags.map((t) => el("span", { class: "card-tag" }, t))) : null,
    ]);
    return card;
  }

  // -- Decisions ---------------------------------------------------------
  async function loadDecisions() {
    const list = $("#decisions-list");
    list.innerHTML = '<div class="loading">Loading decisions…</div>';
    const url = state.project
      ? `/api/decisions?project=${encodeURIComponent(state.project)}`
      : "/api/decisions";
    try {
      const decisions = await getJson(url);
      if (!decisions.length) {
        list.innerHTML = '<div class="empty">No decisions recorded yet.</div>';
        return;
      }
      list.innerHTML = "";
      for (const d of decisions) list.appendChild(renderDecisionCard(d));
    } catch (err) {
      list.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderDecisionCard(d) {
    const status = d.verification_status || "confirmed";
    const lifecycle = d.status || "active";
    const tags = Array.isArray(d.tags) ? d.tags : [];
    return el("article", {
      class: `card is-${status}`,
      tabindex: "0",
      role: "button",
      "aria-label": `Decision: ${d.title}`,
      onclick: () => openEvidenceModal("decision", d.id, d.title),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEvidenceModal("decision", d.id, d.title);
        }
      },
    }, [
      el("div", { class: "card-head" }, [
        el("div", { class: "card-title" }, d.title || "(untitled)"),
        el("div", { class: "card-meta" }, [
          el("span", { class: `badge badge-${status}` }, status),
          el("span", { class: `badge badge-${lifecycle}` }, lifecycle),
          d.category ? el("span", {}, d.category) : null,
          el("span", {}, d.project || ""),
        ]),
      ]),
      d.description ? el("div", { class: "card-desc" }, d.description) : null,
      tags.length ? el("div", { class: "card-tags" }, tags.map((t) => el("span", { class: "card-tag" }, t))) : null,
    ]);
  }

  // -- Patterns + promotions --------------------------------------------
  async function loadPatterns() {
    const pList = $("#patterns-list");
    const prList = $("#promotions-list");
    pList.innerHTML = '<div class="loading">Loading patterns…</div>';
    prList.innerHTML = '<div class="loading">Loading promotions…</div>';
    try {
      const [patterns, promotions] = await Promise.all([
        getJson("/api/patterns"),
        getJson("/api/promotions"),
      ]);

      if (!patterns.length) {
        pList.innerHTML = '<div class="empty">No global patterns yet.</div>';
      } else {
        pList.innerHTML = "";
        for (const p of patterns) {
          const tags = Array.isArray(p.tags) ? p.tags : [];
          pList.appendChild(el("article", { class: "card" }, [
            el("div", { class: "card-head" }, [
              el("div", { class: "card-title" }, p.title || "(untitled)"),
              el("div", { class: "card-meta" }, [
                el("span", { class: "badge badge-active" }, "global"),
                el("span", {}, `applies: ${p.applies_to || "all"}`),
              ]),
            ]),
            p.description ? el("div", { class: "card-desc" }, p.description) : null,
            tags.length ? el("div", { class: "card-tags" }, tags.map((t) => el("span", { class: "card-tag" }, t))) : null,
          ]));
        }
      }

      if (!promotions.length) {
        prList.innerHTML = '<div class="empty">No pattern promotions yet.</div>';
      } else {
        prList.innerHTML = "";
        for (const pr of promotions) {
          prList.appendChild(el("article", { class: "card is-confirmed" }, [
            el("div", { class: "card-head" }, [
              el("div", { class: "card-title" }, pr.pattern_key),
              el("div", { class: "card-meta" }, [
                el("span", { class: "badge badge-confirmed" }, "promoted"),
                el("span", {}, `freq ${pr.total_frequency}`),
                el("span", {}, new Date(pr.promoted_at).toLocaleString()),
              ]),
            ]),
            el("div", { class: "card-desc" },
              `Promoted from ${(pr.promoted_from_projects || []).join(", ")}`),
          ]));
        }
      }
    } catch (err) {
      pList.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
      prList.innerHTML = "";
    }
  }

  // -- Stats -------------------------------------------------------------
  async function loadStats() {
    try {
      const stats = await getJson("/api/stats");
      // KPI numbers
      for (const k of ["lessons", "decisions", "patterns", "projects", "promotions"]) {
        const node = document.querySelector(`[data-kpi="${k}"]`);
        if (node) node.textContent = String(stats.totals?.[k] ?? 0);
      }
      renderVerification(stats.verification || {});
      renderHistogram(stats.histogram || {});
      renderProjectTable(stats.projects || []);
    } catch (err) {
      $("#histogram").innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderVerification(v) {
    const total = (v.claim || 0) + (v.evidence || 0) + (v.confirmed || 0);
    const bar = $("#verification-bar");
    const legend = $("#verification-legend");
    bar.innerHTML = "";
    legend.innerHTML = "";
    if (!total) {
      bar.innerHTML = '<div class="verif-seg verif-seg-claim" style="width:100%;color:var(--text-dim)">no data</div>';
      return;
    }
    const segs = [
      { k: "confirmed", color: "var(--green)" },
      { k: "evidence", color: "var(--yellow)" },
      { k: "claim", color: "var(--orange)" },
    ];
    for (const s of segs) {
      const n = v[s.k] || 0;
      if (!n) continue;
      const pct = (n / total) * 100;
      bar.appendChild(el("div", {
        class: `verif-seg verif-seg-${s.k}`,
        style: `width:${pct.toFixed(2)}%`,
        title: `${s.k}: ${n} (${pct.toFixed(1)}%)`,
      }, pct >= 8 ? `${n}` : ""));

      legend.appendChild(el("div", { class: "verif-legend-item" }, [
        el("span", { class: "verif-swatch", style: `background:${s.color}` }),
        `${s.k}: ${n} (${pct.toFixed(1)}%)`,
      ]));
    }
  }

  function renderHistogram(histogram) {
    const container = $("#histogram");
    container.innerHTML = "";

    // Determine order: 1,2,3,…,9,10+
    const orderedKeys = [];
    for (let i = 1; i <= 9; i++) if (histogram[i]) orderedKeys.push(String(i));
    if (histogram["10+"]) orderedKeys.push("10+");
    // include any other unexpected keys (defensive)
    for (const k of Object.keys(histogram)) {
      if (!orderedKeys.includes(k)) orderedKeys.push(k);
    }

    if (!orderedKeys.length) {
      container.innerHTML = '<div class="empty">No frequency data yet.</div>';
      return;
    }

    const values = orderedKeys.map((k) => Number(histogram[k]) || 0);
    const max = Math.max(...values, 1);

    const width = Math.max(420, orderedKeys.length * 56);
    const height = 220;
    const padL = 36, padR = 16, padT = 16, padB = 36;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;
    const barW = innerW / orderedKeys.length * 0.7;
    const gap = (innerW / orderedKeys.length) * 0.3;

    let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Frequency histogram">`;

    // y-axis ticks (0, max/2, max)
    const ticks = [0, Math.round(max / 2), max];
    for (const t of ticks) {
      const y = padT + innerH - (t / max) * innerH;
      svg += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#21262d" stroke-width="1"/>`;
      svg += `<text class="hist-axis-text" x="${padL - 6}" y="${y + 4}" text-anchor="end">${t}</text>`;
    }

    // bars
    orderedKeys.forEach((k, i) => {
      const v = values[i];
      const x = padL + i * (innerW / orderedKeys.length) + gap / 2;
      const h = (v / max) * innerH;
      const y = padT + innerH - h;
      svg += `<rect class="hist-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="3"><title>${k}× : ${v} lesson(s)</title></rect>`;
      if (h > 18) svg += `<text class="hist-bar-label" x="${x + barW / 2}" y="${y + 14}">${v}</text>`;
      svg += `<text class="hist-axis-text" x="${x + barW / 2}" y="${height - padB + 16}" text-anchor="middle">${escapeHtml(k)}×</text>`;
    });

    svg += "</svg>";
    container.innerHTML = svg;
  }

  function renderProjectTable(projects) {
    const root = $("#project-table");
    root.innerHTML = "";
    if (!projects.length) {
      root.innerHTML = '<div class="empty">No projects yet.</div>';
      return;
    }
    for (const p of projects) {
      root.appendChild(el("article", { class: "card" }, [
        el("div", { class: "card-head" }, [
          el("div", { class: "card-title" }, p.name),
          el("div", { class: "card-meta" }, [
            el("span", {}, `${p.lessons} lesson${p.lessons === 1 ? "" : "s"}`),
            el("span", {}, `${p.decisions} decision${p.decisions === 1 ? "" : "s"}`),
          ]),
        ]),
      ]));
    }
  }

  // -- Modal (evidence chain) -------------------------------------------
  async function openEvidenceModal(kind, id, title) {
    const backdrop = $("#modal-backdrop");
    const titleEl = $("#modal-title");
    const body = $("#modal-body");
    titleEl.textContent = `Evidence chain — ${title}`;
    body.innerHTML = '<div class="loading">Loading…</div>';
    backdrop.removeAttribute("hidden");
    $("#modal-close").focus();

    try {
      const data = await getJson(`/api/evidence/${kind}/${id}`);
      if (!data || data.error) {
        body.innerHTML = `<div class="empty">${escapeHtml(data?.error || "Not found")}</div>`;
        return;
      }
      const item = data.item || {};
      const links = Array.isArray(data.evidence_links) ? data.evidence_links : [];

      body.innerHTML = "";
      body.appendChild(el("h4", {}, "Summary"));
      body.appendChild(el("p", {}, [
        el("code", {}, `${kind} #${id}`),
        " · ",
        el("code", {}, `status: ${item.verification_status || "confirmed"}`),
        " · ",
        el("code", {}, `confidence: ${item.confidence ?? 1.0}`),
      ]));

      if (item.description) {
        body.appendChild(el("h4", {}, "Description"));
        body.appendChild(el("pre", {}, item.description));
      }
      if (item.resolution) {
        body.appendChild(el("h4", {}, "Resolution"));
        body.appendChild(el("pre", {}, item.resolution));
      }
      if (item.prevention) {
        body.appendChild(el("h4", {}, "Prevention"));
        body.appendChild(el("pre", {}, item.prevention));
      }
      if (item.rationale) {
        body.appendChild(el("h4", {}, "Rationale"));
        body.appendChild(el("pre", {}, item.rationale));
      }
      if (item.trigger) {
        body.appendChild(el("h4", {}, "Trigger"));
        body.appendChild(el("pre", {}, item.trigger));
      }
      if (item.pattern_key) {
        body.appendChild(el("h4", {}, "Pattern key"));
        body.appendChild(el("p", {}, el("code", {}, item.pattern_key)));
      }

      body.appendChild(el("h4", {}, `Evidence links (${links.length})`));
      if (!links.length) {
        body.appendChild(el("div", { class: "empty" }, "No evidence attached yet."));
      } else {
        for (const lnk of links) {
          body.appendChild(el("div", { class: "evidence-row" }, [
            el("div", {}, [
              el("span", { class: "ev-type" }, lnk.evidence_type || "?"),
              el("span", { class: "ev-link" }, lnk.evidence_link || ""),
            ]),
            lnk.recorded_at ? el("span", { class: "ev-time" }, lnk.recorded_at) : null,
          ]));
        }
      }
    } catch (err) {
      body.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function closeModal() {
    $("#modal-backdrop").setAttribute("hidden", "");
  }

  // -- Project filter ----------------------------------------------------
  async function loadProjectList() {
    try {
      const projects = await getJson("/api/projects");
      const sel = $("#project-select");
      // preserve selection
      const current = sel.value;
      sel.innerHTML = '<option value="">all projects</option>';
      for (const p of projects) {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        sel.appendChild(opt);
      }
      if (current) sel.value = current;
    } catch {
      // non-fatal — keep the empty dropdown
    }
  }

  // -- Init --------------------------------------------------------------
  function init() {
    // tabs
    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });

    // project filter
    $("#project-select").addEventListener("change", (e) => {
      state.project = e.target.value;
      loadTab(state.activeTab);
    });

    // refresh
    $("#refresh-btn").addEventListener("click", () => {
      loadProjectList();
      loadTab(state.activeTab);
    });

    // modal close
    $("#modal-close").addEventListener("click", closeModal);
    $("#modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#modal-backdrop").hasAttribute("hidden")) {
        closeModal();
      }
    });

    // footer port (best-effort, from current URL)
    const m = location.host.match(/:(\d+)$/);
    if (m) $("#footer-port").textContent = m[1];

    loadProjectList();
    activateTab("lessons");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
