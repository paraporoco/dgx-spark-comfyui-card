/* comfyui-card v1.0.0 — "ComfyUI" card for the NVIDIA DGX Dashboard.
 *
 * Third sibling of the "Local models" and "Live VLM" cards and deliberately
 * built the same way: touches no NVIDIA file, mounts one node into the card
 * grid, and is removed with window.__comfyuiCard.destroy().
 *
 * Three labelled blocks — SERVICE / MODELS & MEMORY / OPEN — so status is
 * never the same widget as intent.
 */
(function () {
  "use strict";

  if (window.__comfyuiCard && window.__comfyuiCard.destroy) {
    window.__comfyuiCard.destroy();
  }

  var API = (function () {
    var s = document.currentScript && document.currentScript.src;
    if (s) { try { return new URL(s).origin; } catch (e) {} }
    return "http://127.0.0.1:8113";
  })();

  var MOUNT_ID = "comfyui-card-root";
  var STYLE_ID = "comfyui-card-style";
  var LOG_ID = "comfyui-card-logs";

  var POLL_IDLE = 8000, POLL_BUSY = 2500;
  var timer = null, observer = null, logsOpen = false, modelsOpen = false, busy = false;
  var lastStatus = null, notice = null;

  var OK = "var(--text-color-feedback-success, #76b900)";
  var WARN = "var(--text-color-feedback-warning, #f5b800)";
  var ERR = "var(--text-color-feedback-error, #f5484c)";
  var MUTED = "var(--text-color-secondary, #8f8f8f)";
  var LINE = "var(--border-color-base, #3a3a3a)";
  var RAISED = "var(--background-color-surface-raised, #1a1a1a)";

  var LBL = "nv-text nv-text--body-regular-sm";
  var MONO = "nv-text nv-text--mono-sm";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = "";
    css += "#" + MOUNT_ID + " .cfc-split{display:flex;flex-wrap:wrap;gap:20px 28px;}";
    css += "#" + MOUNT_ID + " .cfc-split > *{flex:1 1 300px;min-width:0;}";
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function api(path, opts) {
    return fetch(API + path, Object.assign({ mode: "cors", cache: "no-store" }, opts || {}))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }
  function post(path, payload) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" },
                       body: JSON.stringify(payload || {}) });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "style") n.setAttribute("style", attrs[k]);
      else if (k === "class") n.className = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function heading(text) {
    return el("div", {
      class: "nv-text nv-text--label-bold-xs",
      style: "letter-spacing:.09em;text-transform:uppercase;color:" + MUTED + ";"
    }, [text]);
  }

  function dot(color, size) {
    return el("span", {
      class: "nv-status-indicator",
      style: "--size:" + (size || 10) + "px;--color:" + color + ";background-color:" + color +
             ";width:" + (size || 10) + "px;height:" + (size || 10) + "px;border-radius:999px;" +
             "display:inline-block;flex:0 0 auto;"
    });
  }

  function line(text, style) {
    return el("div", { class: LBL, style: style || "" }, [text]);
  }

  function dur(s) {
    if (s === null || s === undefined) return null;
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min";
    if (s < 86400) return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
    return Math.floor(s / 86400) + " d " + Math.floor((s % 86400) / 3600) + " h";
  }

  function findGrid() {
    var p = document.querySelector('[data-testid="skele-panel"]');
    if (p && p.parentElement) return p.parentElement;
    var g = document.querySelector("div.flex.gap-4.flex-wrap");
    if (g) return g;
    var col = document.querySelector('[class*="max-w-"] .flex.flex-col.gap-8');
    if (col && col.lastElementChild) return col.lastElementChild;
    return null;
  }

  // ---------------------------------------------------------------- sections

  function serviceBlock(st) {
    var svc = st.service || {};
    var c = st.comfy || {};
    var q = c.queue || {};
    var color = st.state === "serving" ? OK
              : st.state === "starting" ? WARN
              : st.state === "failed" ? ERR : MUTED;
    var rows = [];

    rows.push(el("div", { style: "display:flex;align-items:center;gap:8px;" }, [
      dot(color, 10),
      el("span", { class: "nv-text nv-text--body-bold-sm" }, [
        st.state === "serving" ? (st.busy ? "Rendering" : "Serving") :
        st.state === "starting" ? "Starting" :
        st.state === "failed" ? "Failed" : "Stopped"
      ]),
      el("span", { class: MONO, style: "opacity:.6;" }, [
        st.ui_scheme + "://0.0.0.0:" + st.ui_port
      ])
    ]));

    if (st.state === "serving" || st.state === "starting") {
      var bits = [];
      if (svc.uptime_s !== null && svc.uptime_s !== undefined) bits.push("up " + dur(svc.uptime_s));
      if (svc.pid) bits.push("pid " + svc.pid);
      if (svc.restarts) bits.push(svc.restarts + " restart" + (svc.restarts > 1 ? "s" : ""));
      if (st.gpu_util !== null && st.gpu_util !== undefined) bits.push("GPU " + st.gpu_util + " %");
      if (bits.length) rows.push(line(bits.join(" · "), "opacity:.65;"));
    } else if (st.state === "failed") {
      rows.push(line("The unit failed (" + (svc.result || "unknown") + "). Show log below.",
                     "color:" + ERR + ";"));
    } else {
      rows.push(line("Nothing is listening on port " + st.ui_port + ".", "opacity:.65;"));
    }

    if (st.state === "serving") {
      var qText = (q.running ? q.running + " running" : "idle") +
                  (q.pending ? " · " + q.pending + " queued" : "");
      rows.push(el("div", { style: "display:flex;align-items:center;gap:8px;" }, [
        dot(q.running ? WARN : MUTED, 8),
        el("span", { class: LBL }, ["Queue: " + qText])
      ]));
    }

    var ver = [];
    if (c.comfyui_version) ver.push("ComfyUI " + c.comfyui_version);
    if (c.pytorch_version) ver.push("torch " + c.pytorch_version);
    if (c.device) ver.push(c.device);
    rows.push(line((ver.length ? ver.join(" · ") + " · " : "") +
                   "unit " + st.unit + " (" + (svc.enabled || "?") + ")",
                   "opacity:.45;font-size:11px;"));

    return el("div", { style: "display:flex;flex-direction:column;gap:8px;" },
              [heading("Service")].concat(rows));
  }

  function modelsBlock(st) {
    var m = st.models || {};
    var mem = st.memory || {};
    var dsk = st.disk || {};
    var out = st.outputs || {};
    var rows = [];

    var folders = m.folders || [];
    var dl = m.downloading || [];

    rows.push(el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" }, [
      dot(m.total ? OK : ERR, 8),
      el("span", { class: "nv-text nv-text--body-bold-sm" },
         [(m.total || 0) + " model file" + (m.total === 1 ? "" : "s")]),
      el("span", { class: LBL, style: "opacity:.45;font-size:11px;" },
         [st.models_dir || ""])
    ]));

    if (folders.length) {
      rows.push(el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;" },
        folders.map(function (f) {
          return el("span", {
            class: "nv-tag nv-tag--kind-outline",
            title: f.files.map(function (x) { return x.name + " — " + x.gib + " GiB"; }).join("\n"),
            style: "opacity:.8;"
          }, [f.folder + " · " + f.count + " · " + f.gib + " GiB"]);
        })));
    } else if (!dl.length) {
      rows.push(line("No models yet. Drop .safetensors files into the models tree; " +
                     "the card and the UI pick them up without a restart.",
                     "color:" + WARN + ";"));
    }

    dl.forEach(function (d) {
      rows.push(el("div", { style: "display:flex;align-items:center;gap:8px;" }, [
        dot(WARN, 8),
        el("span", { class: MONO }, [d.folder + "/" + d.name]),
        el("span", { class: LBL, style: "opacity:.6;" }, ["downloading · " + d.gib + " GiB so far"])
      ]));
    });

    if (modelsOpen && folders.length) {
      rows.push(el("div", { class: MONO,
        style: "max-height:160px;overflow:auto;background:" + RAISED + ";border:1px solid " +
               LINE + ";border-radius:6px;padding:8px 10px;font-size:11px;" },
        folders.map(function (f) {
          return el("div", {}, [f.folder + "/"].concat(f.files.map(function (x) {
            return el("div", { style: "opacity:.75;padding-left:12px;" },
                      [x.name + "  " + x.gib + " GiB"]);
          })));
        })));
    }

    if (mem.total_gib) {
      var pct = Math.min(100, mem.used_pct || 0);
      var rss = st.rss_gib ? " · ComfyUI holds " + st.rss_gib + " GiB" : "";
      rows.push(el("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:2px;" }, [
        el("div", { style: "height:6px;border-radius:999px;background:" + RAISED +
                           ";border:1px solid " + LINE + ";overflow:hidden;" }, [
          el("div", { style: "height:100%;width:" + pct + "%;background:" +
                             (pct > 85 ? WARN : OK) + ";" })
        ]),
        line(mem.used_gib + " used / " + mem.available_gib + " GiB free of " + mem.total_gib +
             " (unified)" + rss, "opacity:.55;font-size:11px;")
      ]));
      if (st.rss_gib && st.rss_gib > 8 && !st.busy) {
        rows.push(line("Idle but holding memory the llama-swap load gate cannot use. " +
                       "Free memory hands it back.", "color:" + WARN + ";font-size:11px;"));
      }
    }

    var tail = [];
    if (dsk.total_gib) tail.push("disk " + dsk.free_gib + " GiB free of " + dsk.total_gib);
    if (out.count) tail.push(out.count + " output" + (out.count === 1 ? "" : "s") +
                             (out.latest ? ", last " + dur(out.latest_age_s) + " ago" : ""));
    if (tail.length) rows.push(line(tail.join(" · "), "opacity:.45;font-size:11px;"));

    return el("div", { style: "display:flex;flex-direction:column;gap:8px;" },
              [heading("Models & memory")].concat(rows));
  }

  function openBlock(st) {
    var u = st.urls || {};
    var rows = [];
    rows.push(line("Node-graph editor for diffusion workflows. Drag a .json or .png with " +
                   "embedded metadata onto the canvas to load a workflow.", "opacity:.65;"));
    (u.public || []).forEach(function (href) {
      rows.push(el("a", {
        class: MONO, href: href, target: "_blank", rel: "noopener",
        style: "color:" + OK + ";text-decoration:none;"
      }, [href]));
    });
    rows.push(line("Plain HTTP, no authentication — reachable from the LAN and the tailnet only. " +
                   "Through a tunnel, forward port " + st.ui_port + " as well.",
                   "opacity:.45;font-size:11px;"));
    return el("div", { style: "display:flex;flex-direction:column;gap:6px;" },
              [heading("Open")].concat(rows));
  }

  // ------------------------------------------------------------------ render

  function render(st) {
    injectStyle();

    var running = st.state === "serving" || st.state === "starting";
    var serving = st.state === "serving";
    var tagColor = st.busy ? "yellow"
                 : st.state === "serving" ? "green"
                 : st.state === "starting" ? "yellow"
                 : st.state === "failed" ? "red" : "gray";
    var tagText = st.busy ? "Rendering"
                : st.state === "serving" ? "Serving"
                : st.state === "starting" ? "Starting"
                : st.state === "failed" ? "Failed" : "Idle";

    var startBtn = el("button", {
      class: "nv-button nv-button--kind-primary nv-button--color-brand",
      disabled: (busy || running) ? "" : null,
      onclick: function () { act("/api/start"); }
    }, ["Start"]);

    var stopBtn = el("button", {
      class: "nv-button",
      disabled: (busy || !running) ? "" : null,
      onclick: function () { act("/api/stop"); }
    }, ["Stop"]);

    var freeBtn = el("button", {
      class: "nv-button",
      title: "Unload models and release cached memory (ComfyUI /free)",
      disabled: (busy || !serving || st.busy) ? "" : null,
      onclick: function () { act("/api/free"); }
    }, ["Free memory"]);

    var intBtn = el("button", {
      class: "nv-button",
      title: "Interrupt the running job (ComfyUI /interrupt)",
      disabled: (busy || !serving || !st.busy) ? "" : null,
      onclick: function () { act("/api/interrupt"); }
    }, ["Interrupt"]);

    var openBtn = el("a", {
      class: "nv-button nv-button--kind-primary nv-button--color-brand",
      href: (st.urls && st.urls.open) || "#", target: "_blank", rel: "noopener",
      style: serving ? "" : "opacity:.4;pointer-events:none;",
      "aria-disabled": serving ? null : "true"
    }, ["Open ComfyUI"]);

    var body = [
      el("div", { class: "cfc-split" }, [serviceBlock(st), modelsBlock(st)]),
      el("div", { style: "height:1px;background:" + LINE + ";" }),
      openBlock(st)
    ];

    if (notice) {
      body.push(el("div", {
        class: LBL,
        style: "border:1px solid " + LINE + ";border-radius:6px;padding:8px 10px;color:" + WARN + ";"
      }, [notice]));
    }

    if (logsOpen) {
      body.push(el("pre", {
        id: LOG_ID, class: MONO,
        style: "margin:0;max-height:220px;overflow:auto;background:" + RAISED +
               ";border:1px solid " + LINE + ";border-radius:6px;padding:10px;font-size:11px;"
      }, ["(loading…)"]));
    }

    var m = st.models || {};
    var sub = "diffusion workflows · " + (m.total || 0) + " model file" +
              (m.total === 1 ? "" : "s") + " · port " + st.ui_port;

    var panel = el("div", {
      id: MOUNT_ID,
      class: "nv-panel nv-panel--elevation-low flex-1 min-w-full md:min-w-[520px]",
      style: "border:1px solid " + LINE + ";border-radius:8px;display:flex;" +
             "flex-direction:column;flex:1 1 100%;min-width:100%;"
    }, [
      el("div", { class: "nv-panel-header",
                  style: "display:flex;align-items:center;justify-content:space-between;" +
                         "gap:12px;padding:14px 18px;border-bottom:1px solid " + LINE + ";" }, [
        el("div", { style: "display:flex;flex-direction:column;gap:2px;" }, [
          el("span", { class: "nv-panel-header-heading nv-text nv-text--title-sm" }, ["ComfyUI"]),
          el("span", { class: LBL, style: "opacity:.55;" }, [sub])
        ]),
        el("span", { class: "nv-tag nv-tag--kind-outline nv-tag--color-" + tagColor }, [tagText])
      ]),
      el("div", { style: "display:flex;flex-direction:column;gap:16px;padding:16px 18px;" }, body),
      el("div", { class: "nv-panel-footer",
                  style: "display:flex;align-items:center;justify-content:space-between;" +
                         "gap:12px;padding:12px 18px;border-top:1px solid " + LINE + ";" }, [
        el("div", { style: "display:flex;gap:8px;" }, [
          el("button", {
            class: "nv-button",
            onclick: function () { logsOpen = !logsOpen; refresh(); if (logsOpen) loadLogs(); }
          }, [logsOpen ? "Hide log" : "Show log"]),
          el("button", {
            class: "nv-button",
            disabled: (m.folders && m.folders.length) ? null : "",
            onclick: function () { modelsOpen = !modelsOpen; refresh(); }
          }, [modelsOpen ? "Hide models" : "List models"])
        ]),
        el("div", { style: "display:flex;gap:8px;" }, [intBtn, freeBtn, stopBtn, startBtn, openBtn])
      ])
    ]);

    return panel;
  }

  // ----------------------------------------------------------------- actions

  function act(path) {
    busy = true; notice = null; refresh();
    post(path).then(function (r) {
      if (!r.ok && r.body) {
        notice = r.body.detail || r.body.reason || ("HTTP " + r.status);
      }
    }).catch(function () { notice = "Card sidecar unreachable at " + API; })
      .then(function () { busy = false; schedule(POLL_BUSY); tick(); });
  }

  function mount(node) {
    var grid = findGrid();
    if (!grid) return false;
    var cur = document.getElementById(MOUNT_ID);
    if (cur && cur.parentElement === grid) {
      grid.replaceChild(node, cur);
    } else {
      if (cur && cur.parentElement) cur.parentElement.removeChild(cur);
      grid.appendChild(node);
    }
    return true;
  }

  function loadLogs() {
    api("/api/logs?n=120").then(function (r) {
      var p = document.getElementById(LOG_ID);
      if (p) {
        p.textContent = (r.body.lines || []).join("\n") || "(empty)";
        p.scrollTop = p.scrollHeight;
      }
    }).catch(function () {});
  }

  function refresh() { if (lastStatus) mount(render(lastStatus)); }

  function tick() {
    api("/api/status").then(function (r) {
      lastStatus = r.body;
      mount(render(lastStatus));
      if (logsOpen) loadLogs();
      var b = lastStatus.state === "starting" || lastStatus.busy ||
              (lastStatus.models && lastStatus.models.downloading &&
               lastStatus.models.downloading.length);
      schedule(b ? POLL_BUSY : POLL_IDLE);
    }).catch(function (e) {
      lastStatus = {
        state: "unknown", unit: "?", service: {}, ui_port: 8188,
        ui_scheme: "http", urls: {}, comfy: {}, memory: {}, models: {}
      };
      notice = "Card sidecar unreachable at " + API +
               ". If you are browsing through NVIDIA Sync, port 8113 needs a tile.";
      mount(render(lastStatus));
      schedule(POLL_IDLE);
    });
  }

  function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(tick, ms); }

  function watch() {
    observer = new MutationObserver(function () {
      if (!document.getElementById(MOUNT_ID) && lastStatus && findGrid()) mount(render(lastStatus));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function waitForGrid(n) {
    if (findGrid()) { tick(); watch(); return; }
    if (n > 120) return;
    setTimeout(function () { waitForGrid(n + 1); }, 500);
  }

  window.__comfyuiCard = {
    api: API, refresh: tick,
    destroy: function () {
      if (timer) clearTimeout(timer);
      if (observer) observer.disconnect();
      var n = document.getElementById(MOUNT_ID);
      if (n && n.parentElement) n.parentElement.removeChild(n);
      var s = document.getElementById(STYLE_ID);
      if (s && s.parentElement) s.parentElement.removeChild(s);
      delete window.__comfyuiCard;
    }
  };

  waitForGrid(0);
})();
