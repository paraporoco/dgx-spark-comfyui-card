# Changelog

## 1.0.0 — 2026-10-06

First release.

- **ComfyUI card** (`:8113`): service lifecycle, queue state, ComfyUI/torch
  versions, GPU utilisation, model inventory per folder with downloads in
  flight, unified-memory bar, ComfyUI resident size, output count, log drawer,
  correct Open URLs.
- **Memory hand-back**: `Free memory` calls ComfyUI `/free` with
  `unload_models` + `free_memory`, so the llama-swap load gate can fit a
  language model again after a render. `Interrupt` calls `/interrupt`.
- **Units**: two systemd *user* units (`comfyui-card.service`,
  `comfyui.service`), hardened, no root at runtime.
- **Installer** with `--reuse-user-torch` for hosts that already carry a
  cu130 torch in `~/.local` (a `.pth` in the venv, no 4 GB re-download).
- **Userscript 2.4.0** injects Local models, Live VLM and ComfyUI.
- **tools/fetch-models.sh**: SDXL base 1.0 and FLUX.1-schnell fp8 all-in-one
  from ungated Hugging Face repos, `.part` then rename.

## 1.1.0 — 2026-10-06

- **TLS**: `comfyui.service` serves https with a homeCA certificate
  (`--tls-certfile`/`--tls-keyfile` on the served pair the reload hook
  composes). `packaging/homeca/` carries the agent item and the reload hook.
- **Sidecar 1.1.0**: loopback probes follow `CC_UI_SCHEME`; verified against
  `CC_TLS_CA` when readable, otherwise unverified on loopback only.
- **card.js**: the Open block states the TLS origin instead of "plain HTTP".
- Card links put the tailnet name first (trusted padlock on MagicDNS hosts).

## 1.1.1 — 2026-10-07

- `patches/comfyui-allow-cross-site-navigation.patch`: ComfyUI 403s every
  cross-site request, including the top-level navigation a card link makes.
  The patch lets a cross-site top-level GET navigation through and keeps
  refusing everything else.
