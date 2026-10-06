#!/usr/bin/env bash
# Install the ComfyUI card sidecar and, optionally, ComfyUI itself.
#
# Touches nothing under /opt/nvidia/. Verifies that afterwards.
#
# Both services are systemd USER units, not system units. That is deliberate:
# it is what lets the card start and stop ComfyUI with no polkit rule, no
# sudoers entry and no root at runtime. Root is used here only to write the
# program files under /opt/local and to enable lingering.
set -euo pipefail

PREFIX=/opt/local/comfyui-card
COMFY_PREFIX=/opt/local/comfyui
SERVICE_USER="${SUDO_USER:-$USER}"
PORT=8113
UI_PORT=8188
INSTALL_COMFYUI=1
REUSE_USER_TORCH=0
TORCH_INDEX=https://download.pytorch.org/whl/cu130
PUBLIC_HOSTS=""

usage() {
  cat <<EOF
usage: sudo ./install.sh [options]

  --user <name>          run as this user             (default: ${SERVICE_USER})
  --port <n>             card + API port              (default: ${PORT})
  --ui-port <n>          ComfyUI port                 (default: ${UI_PORT})
  --public-hosts <list>  comma-separated addresses the card links to
                         (default: auto-detected LAN addresses)
  --torch-index <url>    wheel index for torch        (default: ${TORCH_INDEX})
  --reuse-user-torch     do not download torch; expose the user's existing
                         ~/.local torch stack to the venv through a .pth
  --no-comfyui           install only the card; bring your own ComfyUI
  -h, --help
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) SERVICE_USER=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --ui-port) UI_PORT=$2; shift 2;;
    --public-hosts) PUBLIC_HOSTS=$2; shift 2;;
    --torch-index) TORCH_INDEX=$2; shift 2;;
    --reuse-user-torch) REUSE_USER_TORCH=1; shift;;
    --no-comfyui) INSTALL_COMFYUI=0; shift;;
    -h|--help) usage;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "no such user: $SERVICE_USER" >&2; exit 1; }
USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
UID_N=$(id -u "$SERVICE_USER")
asuser() { runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/${UID_N}" "$@"; }

echo "==> preflight"
for c in python3 git curl; do command -v $c >/dev/null || { echo "$c not found" >&2; exit 1; }; done
python3 - <<'PY' || { echo "python 3.10+ required" >&2; exit 1; }
import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)
PY
for p in "$PORT" "$UI_PORT"; do
  if ss -ltn 2>/dev/null | grep -q ":$p "; then echo "port $p already in use" >&2; exit 1; fi
done
if [ "$PUBLIC_HOSTS" = "" ]; then
  PUBLIC_HOSTS=$(ip -4 -o addr show 2>/dev/null | awk '$2!="lo" && $2!~/^docker|^br-|^veth/{split($4,a,"/"); print a[1]}' | paste -sd, -)
fi
echo "    card links to: ${PUBLIC_HOSTS}"

echo "==> baseline (so we can prove we did not touch NVIDIA)"
BASE=$(mktemp -d)
dpkg -V dgx-dashboard > "$BASE/dpkg-V.before" 2>&1 || true
sha256sum /opt/nvidia/dgx-dashboard-service/dashboard-service > "$BASE/sha.before" 2>/dev/null || true

echo "==> lingering for $SERVICE_USER"
loginctl enable-linger "$SERVICE_USER"

echo "==> card files -> $PREFIX"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$PREFIX" "$PREFIX/web"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$HERE/src/comfyui_card.py" "$PREFIX/comfyui_card.py"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 "$HERE/src/web/card.js"    "$PREFIX/web/card.js"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 "$HERE/src/web/index.html" "$PREFIX/web/index.html"

if [ "$INSTALL_COMFYUI" = 1 ]; then
  echo "==> ComfyUI -> $COMFY_PREFIX"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$COMFY_PREFIX"
  if [ ! -d "$COMFY_PREFIX/ComfyUI/.git" ]; then
    asuser git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$COMFY_PREFIX/ComfyUI"
  else
    echo "    keeping existing checkout"
  fi
  if [ ! -x "$COMFY_PREFIX/.venv/bin/python" ]; then
    asuser python3 -m venv "$COMFY_PREFIX/.venv"
  fi
  PYV=$(asuser "$COMFY_PREFIX/.venv/bin/python" -c 'import sys;print("%d.%d"%sys.version_info[:2])')
  if [ "$REUSE_USER_TORCH" = 1 ]; then
    USP="$USER_HOME/.local/lib/python${PYV}/site-packages"
    [ -d "$USP/torch" ] || { echo "no torch in $USP; drop --reuse-user-torch" >&2; exit 1; }
    echo "$USP" > "$COMFY_PREFIX/.venv/lib/python${PYV}/site-packages/zz-user-site.pth"
    chown "$SERVICE_USER:$SERVICE_USER" "$COMFY_PREFIX/.venv/lib/python${PYV}/site-packages/zz-user-site.pth"
    echo "    venv sees $USP"
  fi
  asuser "$COMFY_PREFIX/.venv/bin/pip" install -q --upgrade pip wheel
  if [ "$REUSE_USER_TORCH" = 0 ]; then
    asuser "$COMFY_PREFIX/.venv/bin/pip" install -q torch torchvision torchaudio --index-url "$TORCH_INDEX"
  fi
  asuser "$COMFY_PREFIX/.venv/bin/pip" install -q -r "$COMFY_PREFIX/ComfyUI/requirements.txt"
  asuser "$COMFY_PREFIX/.venv/bin/python" -c 'import torch;print("    torch",torch.__version__,"cuda",torch.cuda.is_available())'
  asuser install -d -m 0755 "$USER_HOME/.cache" "$USER_HOME/.nv"
fi

echo "==> user units -> $USER_HOME/.config/systemd/user"
UNITDIR="$USER_HOME/.config/systemd/user"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$UNITDIR"
sed -e "s#^Environment=CC_PORT=.*#Environment=CC_PORT=${PORT}#" \
    -e "s#^Environment=CC_UI_PORT=.*#Environment=CC_UI_PORT=${UI_PORT}#" \
    -e "s#^Environment=CC_PUBLIC_HOSTS=.*#Environment=CC_PUBLIC_HOSTS=${PUBLIC_HOSTS}#" \
    -e "s#^Environment=CC_WEBROOT=.*#Environment=CC_WEBROOT=${PREFIX}/web#" \
    -e "s#^Environment=CC_COMFY_DIR=.*#Environment=CC_COMFY_DIR=${COMFY_PREFIX}/ComfyUI#" \
    -e "s#/opt/local/comfyui-card/comfyui_card.py#${PREFIX}/comfyui_card.py#" \
    "$HERE/packaging/comfyui-card.service" > "$UNITDIR/comfyui-card.service"
if [ "$INSTALL_COMFYUI" = 1 ]; then
  sed -e "s#--port 8188#--port ${UI_PORT}#" \
      -e "s#/opt/local/comfyui#${COMFY_PREFIX}#g" \
      "$HERE/packaging/comfyui.service" > "$UNITDIR/comfyui.service"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$UNITDIR"

echo "==> start"
asuser systemctl --user daemon-reload
asuser systemctl --user enable --now comfyui-card.service
[ "$INSTALL_COMFYUI" = 1 ] && asuser systemctl --user enable --now comfyui.service
sleep 4

echo "==> verify"
curl -fsS -m 5 "http://127.0.0.1:${PORT}/healthz" && echo
if [ "$INSTALL_COMFYUI" = 1 ]; then
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${UI_PORT}/system_stats" || true)
    [ "$code" = 200 ] && break; sleep 2
  done
  echo "    ComfyUI http://127.0.0.1:${UI_PORT}/system_stats -> HTTP ${code}"
fi

dpkg -V dgx-dashboard > "$BASE/dpkg-V.after" 2>&1 || true
sha256sum /opt/nvidia/dgx-dashboard-service/dashboard-service > "$BASE/sha.after" 2>/dev/null || true
if diff -q "$BASE/dpkg-V.before" "$BASE/dpkg-V.after" >/dev/null 2>&1 &&
   diff -q "$BASE/sha.before" "$BASE/sha.after" >/dev/null 2>&1; then
  echo "    NVIDIA package unchanged (dpkg -V and binary hash identical)"
else
  echo "    WARNING: NVIDIA state differs from before this install - investigate" >&2
fi
rm -rf "$BASE"

cat <<EOF

Done.

  card         http://127.0.0.1:${PORT}
  API          http://127.0.0.1:${PORT}/api/status
$([ "$INSTALL_COMFYUI" = 1 ] && echo "  ComfyUI      http://<this host's LAN address>:${UI_PORT}/")

Next:
  1. install userscript/dgx-dashboard-cards.user.js in Violentmonkey or Tampermonkey
     (disable the older two-card script)
  2. put models under ${COMFY_PREFIX}/ComfyUI/models/<folder>/ - or run
     tools/fetch-models.sh in tmux for a starter set

Uninstall:
  systemctl --user disable --now comfyui.service comfyui-card.service
  rm -f ~/.config/systemd/user/comfyui{,-card}.service
  systemctl --user daemon-reload
  sudo rm -rf ${PREFIX} ${COMFY_PREFIX}
EOF
