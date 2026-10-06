#!/usr/bin/env python3
"""comfyui-card - "ComfyUI" card sidecar for the NVIDIA DGX Dashboard.

Third sibling of dgx-model-card (:8110) and live-vlm-card (:8112). Same rules:
  * touches no NVIDIA file, no /opt/nvidia, no dgx-dashboard package;
  * Python 3 standard library only - no pip, no venv, nothing to break on
    arm64 or at upgrade;
  * no privilege. It runs as a systemd *user* service and controls another
    systemd *user* service (comfyui.service), so there is no polkit rule, no
    sudoers entry and no root anywhere.

Serves:
    GET  /                 standalone card page
    GET  /card.js          the injection script (same one the dashboard uses)
    GET  /healthz          liveness
    GET  /api/status       service state, ComfyUI stats, queue, models, memory
    GET  /api/logs?n=      journal tail for the comfyui unit
    POST /api/start        systemctl --user start   (202)
    POST /api/stop         systemctl --user stop    (202)
    POST /api/restart      systemctl --user restart (202)
    POST /api/interrupt    ComfyUI POST /interrupt  (202)
    POST /api/free         ComfyUI POST /free: unload models + free memory (202)
    POST /api/clear_queue  ComfyUI POST /queue {"clear": true} (202)

Why "free" matters here: GB10 memory is unified. Whatever ComfyUI keeps
resident after a job is memory the llama-swap load gate (:8111) cannot give
to a language model, and the gate refuses a load it cannot fit. One click
hands the memory back.

Version 1.1.0 - TLS-aware loopback probes (CC_UI_SCHEME=https)
"""

import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.1.0"

HOST = os.environ.get("CC_HOST", "127.0.0.1")
PORT = int(os.environ.get("CC_PORT", "8113"))
UNIT = os.environ.get("CC_UNIT", "comfyui.service")
WEBROOT = os.environ.get("CC_WEBROOT", "/opt/local/comfyui-card/web")

UI_SCHEME = os.environ.get("CC_UI_SCHEME", "http")
UI_PORT = int(os.environ.get("CC_UI_PORT", "8188"))
UI_URL = "%s://127.0.0.1:%d" % (UI_SCHEME, UI_PORT)
# Loopback TLS probes. The homeCA served chain carries leaf + issuing CA but
# not the root, and the root bundle under /etc/homeca/agent is root-only, so
# verification is possible only when CC_TLS_CA names a readable bundle.
# Otherwise the loopback call is unverified, as in live-vlm-card.
TLS_CA = os.environ.get("CC_TLS_CA", "")


def _ssl_ctx():
    if UI_SCHEME != "https":
        return None
    if TLS_CA and os.access(TLS_CA, os.R_OK):
        ctx = ssl.create_default_context(cafile=TLS_CA)
        ctx.check_hostname = False     # SAN has IP:127.0.0.1 but keep it simple
        return ctx
    return ssl._create_unverified_context()
PUBLIC_HOSTS = [h for h in os.environ.get(
    "CC_PUBLIC_HOSTS", "192.168.1.159,100.64.239.1").split(",") if h.strip()]

COMFY_DIR = os.environ.get("CC_COMFY_DIR", "/opt/local/comfyui/ComfyUI")
MODELS_DIR = os.environ.get("CC_MODELS_DIR", os.path.join(COMFY_DIR, "models"))
OUTPUT_DIR = os.environ.get("CC_OUTPUT_DIR", os.path.join(COMFY_DIR, "output"))

# Model folders worth counting, in display order. Everything else is ignored.
MODEL_FOLDERS = ["checkpoints", "diffusion_models", "unet", "loras", "vae",
                 "text_encoders", "clip", "controlnet", "upscale_models",
                 "clip_vision", "embeddings"]
MODEL_EXT = (".safetensors", ".ckpt", ".gguf", ".pt", ".pth", ".bin", ".sft")

ORIGINS = set(o.strip() for o in os.environ.get(
    "CC_ORIGINS",
    "http://localhost:11000,http://127.0.0.1:11000,"
    "http://localhost:11005,http://127.0.0.1:8113,http://localhost:8113"
).split(",") if o.strip())

SYSTEMCTL = shutil.which("systemctl") or "/usr/bin/systemctl"
JOURNALCTL = shutil.which("journalctl") or "/usr/bin/journalctl"
NVIDIA_SMI = shutil.which("nvidia-smi") or "/usr/bin/nvidia-smi"

_lock = threading.Lock()
_last_action = {"name": None, "at": 0, "ok": None, "detail": None}


# ------------------------------------------------------------------ helpers

def _run(argv, timeout=15):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as exc:                                   # pragma: no cover
        return 127, "", str(exc)


def _get_json(url, timeout=3):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    ctx = _ssl_ctx() if url.startswith("https:") else None
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _post_json(url, payload, timeout=10):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    ctx = _ssl_ctx() if url.startswith("https:") else None
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        body = r.read().decode("utf-8", "replace")
        return r.status, body


def unit_state():
    """systemd properties of the comfyui unit, read through the user manager."""
    props = ["ActiveState", "SubState", "UnitFileState", "MainPID",
             "NRestarts", "ExecMainStartTimestampMonotonic", "Result"]
    rc, out, err = _run([SYSTEMCTL, "--user", "show", UNIT,
                         "-p", ",".join(props)])
    d = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v
    if rc != 0 and not d:
        return {"active": "unknown", "sub": "", "enabled": "unknown",
                "pid": 0, "restarts": 0, "uptime_s": None,
                "error": (err or out).strip()[:200]}
    uptime = None
    try:
        mono = int(d.get("ExecMainStartTimestampMonotonic", "0"))
        if mono:
            uptime = int(time.monotonic() - mono / 1e6)
            if uptime < 0:
                uptime = None
    except Exception:
        pass
    return {
        "active": d.get("ActiveState", "unknown"),
        "sub": d.get("SubState", ""),
        "enabled": d.get("UnitFileState", "unknown"),
        "pid": int(d.get("MainPID", "0") or 0),
        "restarts": int(d.get("NRestarts", "0") or 0),
        "uptime_s": uptime,
        "result": d.get("Result", ""),
    }


def port_open(host, port, timeout=0.6):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def comfy_probe():
    """What ComfyUI says about itself: version, torch, device, queue."""
    out = {"reachable": False}
    try:
        st = _get_json(UI_URL + "/system_stats", timeout=4)
        sysi = st.get("system", {}) or {}
        dev = (st.get("devices") or [{}])[0] or {}
        out.update({
            "reachable": True,
            "comfyui_version": sysi.get("comfyui_version"),
            "python_version": (sysi.get("python_version") or "").split(" ")[0],
            "pytorch_version": sysi.get("pytorch_version"),
            "device": dev.get("name"),
            "device_type": dev.get("type"),
            "vram_total_gib": round((dev.get("vram_total") or 0) / 2**30, 1),
            "vram_free_gib": round((dev.get("vram_free") or 0) / 2**30, 1),
            "torch_vram_total_gib": round((dev.get("torch_vram_total") or 0) / 2**30, 1),
            "torch_vram_free_gib": round((dev.get("torch_vram_free") or 0) / 2**30, 1),
        })
    except Exception as exc:
        out["error"] = str(exc)[:160]
        return out
    try:
        q = _get_json(UI_URL + "/queue", timeout=4)
        running = q.get("queue_running") or []
        pending = q.get("queue_pending") or []
        out["queue"] = {"running": len(running), "pending": len(pending)}
        # item = [number, prompt_id, prompt, extra_data, outputs_to_execute]
        if running:
            try:
                out["queue"]["running_id"] = str(running[0][1])[:8]
            except Exception:
                pass
    except Exception as exc:
        out["queue"] = {"running": 0, "pending": 0, "error": str(exc)[:120]}
    return out


def memory():
    info = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                k, _, v = line.partition(":")
                info[k] = int(v.split()[0])
    except Exception:
        return {}
    gib = lambda kb: round(kb / 1048576.0, 1)
    total, avail = info.get("MemTotal", 0), info.get("MemAvailable", 0)
    return {"total_gib": gib(total), "available_gib": gib(avail),
            "used_gib": gib(total - avail),
            "used_pct": round(100.0 * (total - avail) / total, 1) if total else 0}


def process_rss_gib(pid):
    """Resident size of the ComfyUI process - on GB10 unified memory this IS
    the model memory, since nvidia-smi reports N/A."""
    if not pid:
        return None
    try:
        with open("/proc/%d/status" % pid) as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1048576.0, 1)
    except Exception:
        pass
    return None


def gpu_util():
    rc, out, _ = _run([NVIDIA_SMI, "--query-gpu=utilization.gpu",
                       "--format=csv,noheader,nounits"], timeout=5)
    if rc == 0:
        try:
            return int(out.strip().splitlines()[0])
        except Exception:
            pass
    return None


def models():
    """Inventory of the models tree, read straight off disk so a file that
    lands (or a .part still downloading) shows up with no card change."""
    folders, downloading, total = [], [], 0
    for name in MODEL_FOLDERS:
        d = os.path.join(MODELS_DIR, name)
        if not os.path.isdir(d):
            continue
        files = []
        for root, _dirs, names in os.walk(d):
            for n in names:
                p = os.path.join(root, n)
                try:
                    sz = os.stat(p).st_size
                except OSError:
                    continue
                if n.endswith(".part"):
                    downloading.append({"folder": name, "name": n[:-5],
                                        "gib": round(sz / 2**30, 1)})
                elif n.lower().endswith(MODEL_EXT):
                    files.append({"name": os.path.relpath(p, d),
                                  "gib": round(sz / 2**30, 1)})
        if files:
            size = sum(f["gib"] for f in files)
            total += len(files)
            folders.append({"folder": name, "count": len(files),
                            "gib": round(size, 1),
                            "files": sorted(files, key=lambda f: -f["gib"])[:12]})
    return {"folders": folders, "downloading": downloading, "total": total}


def disk():
    try:
        u = shutil.disk_usage(MODELS_DIR if os.path.isdir(MODELS_DIR) else "/")
        return {"total_gib": round(u.total / 2**30), "free_gib": round(u.free / 2**30),
                "used_pct": round(100.0 * (u.total - u.free) / u.total, 1)}
    except Exception:
        return {}


def outputs():
    try:
        latest, n = None, 0
        for root, _dirs, names in os.walk(OUTPUT_DIR):
            for name in names:
                if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm")):
                    n += 1
                    p = os.path.join(root, name)
                    m = os.stat(p).st_mtime
                    if latest is None or m > latest[1]:
                        latest = (os.path.relpath(p, OUTPUT_DIR), m)
        return {"count": n,
                "latest": latest[0] if latest else None,
                "latest_age_s": int(time.time() - latest[1]) if latest else None}
    except Exception:
        return {"count": 0, "latest": None, "latest_age_s": None}


def urls():
    out = {"local": "%s://localhost:%d/" % (UI_SCHEME, UI_PORT), "public": []}
    for h in PUBLIC_HOSTS:
        out["public"].append("%s://%s:%d/" % (UI_SCHEME, h.strip(), UI_PORT))
    out["open"] = out["public"][0] if out["public"] else out["local"]
    return out


def status():
    u = unit_state()
    listening = port_open("127.0.0.1", UI_PORT)
    probe = comfy_probe() if listening else {"reachable": False}
    state = "stopped"
    if u["active"] == "active":
        state = "serving" if probe.get("reachable") else "starting"
    elif u["active"] == "failed":
        state = "failed"
    elif u["active"] in ("activating", "reloading"):
        state = "starting"
    q = probe.get("queue") or {}
    with _lock:
        last = dict(_last_action)
    return {
        "version": VERSION,
        "state": state,
        "busy": bool(q.get("running")),
        "unit": UNIT,
        "service": u,
        "listening": listening,
        "comfy": probe,
        "ui_port": UI_PORT,
        "ui_scheme": UI_SCHEME,
        "urls": urls(),
        "models": models(),
        "disk": disk(),
        "outputs": outputs(),
        "memory": memory(),
        "rss_gib": process_rss_gib(u.get("pid")),
        "gpu_util": gpu_util() if state == "serving" else None,
        "comfy_dir": COMFY_DIR,
        "models_dir": MODELS_DIR,
        "last_action": last,
        "now": int(time.time()),
    }


def logs(n=120):
    rc, out, err = _run([JOURNALCTL, "--user", "-u", UNIT, "-n", str(n),
                         "--no-pager", "-o", "short-iso"], timeout=20)
    lines = (out or err).splitlines()
    return [l for l in lines if l.strip()]


# ------------------------------------------------------------------- actions

def _record(name, ok, detail=None):
    with _lock:
        _last_action.update({"name": name, "at": int(time.time()),
                             "ok": ok, "detail": (detail or "")[:200] or None})


def systemd_action(verb):
    rc, out, err = _run([SYSTEMCTL, "--user", verb, UNIT], timeout=30)
    ok = rc == 0
    _record(verb, ok, (err or out).strip())
    return ok, ((err or out).strip()[:300] or None)


def comfy_action(name):
    try:
        if name == "interrupt":
            st, body = _post_json(UI_URL + "/interrupt", {})
        elif name == "free":
            st, body = _post_json(UI_URL + "/free",
                                  {"unload_models": True, "free_memory": True})
        elif name == "clear_queue":
            st, body = _post_json(UI_URL + "/queue", {"clear": True})
        else:
            return False, "unknown action"
        ok = 200 <= st < 300
        _record(name, ok, body)
        return ok, (body[:300] or None)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        _record(name, False, body)
        return False, "HTTP %d %s" % (exc.code, body)
    except Exception as exc:
        _record(name, False, str(exc))
        return False, str(exc)[:300]


# ------------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    server_version = "comfyui-card/" + VERSION
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    # -- plumbing

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _file(self, name, ctype):
        path = os.path.join(WEBROOT, name)
        try:
            with open(path, "rb") as fh:
                self._send(200, fh.read(), ctype)
        except OSError:
            self._send(404, {"error": "not found", "path": path})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    # -- routes

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        if path in ("/", "/index.html"):
            return self._file("index.html", "text/html; charset=utf-8")
        if path == "/card.js":
            return self._file("card.js", "application/javascript; charset=utf-8")
        if path == "/healthz":
            return self._send(200, {"ok": True, "version": VERSION})
        if path == "/api/status":
            return self._send(200, status())
        if path == "/api/logs":
            n = 120
            m = re.search(r"n=(\d+)", query)
            if m:
                n = max(1, min(1000, int(m.group(1))))
            return self._send(200, {"lines": logs(n)})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path in ("/api/start", "/api/stop", "/api/restart"):
            verb = path.rsplit("/", 1)[1]
            ok, detail = systemd_action(verb)
            return self._send(202 if ok else 500,
                              {"accepted": ok, "action": verb, "detail": detail})
        if path in ("/api/interrupt", "/api/free", "/api/clear_queue"):
            name = path.rsplit("/", 1)[1]
            ok, detail = comfy_action(name)
            return self._send(202 if ok else 502,
                              {"accepted": ok, "action": name, "detail": detail})
        return self._send(404, {"error": "not found"})


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("comfyui-card %s on http://%s:%d (unit %s, ui :%d)"
          % (VERSION, HOST, PORT, UNIT, UI_PORT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
