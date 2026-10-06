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
