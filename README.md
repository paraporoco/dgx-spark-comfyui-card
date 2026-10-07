# DGX Spark ComfyUI card

A **ComfyUI** card for the NVIDIA DGX Dashboard: run diffusion workflows
(SDXL, FLUX, …) on the Spark's GB10 and control the service from the same
grid as the stock cards.

Third sibling of [dgx-spark-model-card](https://github.com/paraporoco/dgx-spark-model-card)
("Local models", `:8110`) and
[dgx-spark-live-vlm-card](https://github.com/paraporoco/dgx-spark-live-vlm-card)
("Live VLM", `:8112`). Same mechanism, same rules.

```
browser ── http ──────────────► :8188  ComfyUI            (LAN / tailnet)
   │                                        ▲
   │                                        │ /system_stats /queue /free /interrupt
   └── dashboard :11000                :8113  comfyui-card
        + injected card ──────────────►   card API, model inventory,
                                            systemctl --user start/stop
```

Nothing under `/opt/nvidia/`, `/usr/bin/dgx-dashboard` or the `dgx-dashboard`
package is modified. `install.sh` proves it the same way the siblings do.

## Why a card

The dashboard has no extension point — the SPA is compiled into the service
binary — so a card is a sidecar plus a userscript. This one gives you, from
the dashboard:

- **lifecycle** — start, stop, read the journal, without a terminal;
- **what is loaded** — queue depth, whether a job is rendering, how much
  memory the ComfyUI process holds;
- **memory back** — one click calls ComfyUI's `/free` (unload models, free
  cache). On GB10 memory is unified, so whatever ComfyUI keeps resident after
  a render is memory the llama-swap load gate (`:8111`) cannot give to a
  language model, and the gate refuses a load it cannot fit;
- **model inventory** — every model folder with count and size, read straight
  off disk, and `.part` files still downloading shown as such.

## What the card shows

Three labelled blocks, so status never shares a widget with intent.

- **SERVICE** — state (Stopped / Starting / Serving / Rendering / Failed),
  bind address, uptime, pid, restarts, GPU utilisation, queue (running /
  pending), ComfyUI and torch versions, device, unit name and enablement.
- **MODELS & MEMORY** — model files per folder as chips (hover for the file
  list), downloads in flight, a used/free bar over unified memory that turns
  amber past 85 %, the ComfyUI process's resident size with a warning when it
  sits idle on more than 8 GiB, disk free under the models tree, output count
  and age of the last render.
- **OPEN** — every reachable URL, and the reminder that the UI is plain HTTP
  with no authentication.

Footer: `Show log` · `List models` · `Interrupt` · `Free memory` · `Stop` ·
`Start` · `Open ComfyUI`.

## Requirements

- DGX Spark (or any Linux host) with `dgx-dashboard`; Python 3.10+; `curl`,
  `git`; `systemd --user` with lingering (the installer enables it).
- A CUDA-13 aarch64 PyTorch. The installer builds a venv and pulls
  `torch`/`torchvision`/`torchaudio` from the `cu130` index (~4 GB) unless
  `--reuse-user-torch` is given, in which case the venv is created with a
  `.pth` that exposes an existing `~/.local` torch stack instead.

## Install

```bash
git clone https://github.com/paraporoco/dgx-spark-comfyui-card
cd dgx-spark-comfyui-card
sudo ./install.sh                     # card + ComfyUI venv + units
sudo ./install.sh --reuse-user-torch  # same, but reuse ~/.local torch (fast)
sudo ./install.sh --no-comfyui        # card only; bring your own ComfyUI
```

Then install `userscript/dgx-dashboard-cards.user.js` in Violentmonkey or
Tampermonkey (it replaces the two-card script from the siblings; disable that
one) and reload `http://localhost:11000/`.

Starter models (SDXL base, FLUX.1-schnell fp8 all-in-one; ~24 GB, no
Hugging Face token needed):

```bash
tools/fetch-models.sh
```

Run it in `tmux`; the card shows the files as "downloading" until they land.

## Ports and remote use

All sidecars bind `127.0.0.1` only. From another machine, forward every port
you want, e.g.

```bash
ssh -L 11000:127.0.0.1:11000 -L 8110:127.0.0.1:8110 \
    -L 8112:127.0.0.1:8112 -L 8113:127.0.0.1:8113 you@spark
```

ComfyUI itself (`:8188`) binds `0.0.0.0` and is reached directly over the LAN
or Tailscale; the card links to the right URL. It has **no authentication**:
do not expose that port beyond networks you trust.

## TLS (optional, homeCA)

`packaging/homeca/` has what the deployed host uses: an item for
`homeca-agent` and a reload hook that installs the served pair, restarts the
user unit and proves the presented leaf verifies before keeping it. The unit
then takes `--tls-certfile`/`--tls-keyfile`, and `comfyui-card.service` gets
`CC_UI_SCHEME=https`. Any CA with a renewal agent fits the same two hooks.

## Files

| Path | Role |
|---|---|
| `src/comfyui_card.py` | sidecar: card API + `card.js` server, stdlib only |
| `src/web/card.js` | the injected card (all markup, polling, controls) |
| `src/web/index.html` | standalone view of the same card |
| `packaging/comfyui-card.service` | user unit for the sidecar (`:8113`) |
| `packaging/comfyui.service` | user unit for ComfyUI (`:8188`) |
| `userscript/dgx-dashboard-cards.user.js` | injects all three cards |
| `tools/fetch-models.sh` | starter models via direct HF resolve URLs |

## Uninstall

```bash
systemctl --user disable --now comfyui.service comfyui-card.service
rm -f ~/.config/systemd/user/comfyui{,-card}.service
systemctl --user daemon-reload
sudo rm -rf /opt/local/comfyui-card /opt/local/comfyui   # the second one holds your models
```

## Known issue: 403 when opening ComfyUI from the card

ComfyUI (`server.py`, `origin_only_middleware`) returns 403 to every request
with `Sec-Fetch-Site: cross-site`, and a link clicked on the dashboard card is
exactly that. `patches/comfyui-allow-cross-site-navigation.patch` narrows the
refusal to requests that are not a top-level `GET` navigation (cross-site
fetches, subresources and all non-GET methods stay refused). Apply after each
ComfyUI update:

```bash
cd /opt/local/comfyui/ComfyUI && patch -p0 < /path/to/patches/comfyui-allow-cross-site-navigation.patch
systemctl --user restart comfyui
```
