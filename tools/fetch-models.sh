#!/bin/bash
# Starter models for ComfyUI. Direct Hugging Face resolve URLs, no token, no
# xet (set HF_HUB_DISABLE_XET=1 for hosts where the xet CAS bridge is blocked).
#
# Downloads go to <name>.part and are renamed on success, so the card can show
# what is still in flight. Each file is retried until complete (-C - resumes),
# because a home link resets long transfers now and then.
#
# Run it in tmux: ~24 GB.
M=${COMFY_MODELS:-/opt/local/comfyui/ComfyUI/models}
get() { # dst url
  local dst=$1 url=$2 n=0
  [ -s "$dst" ] && { echo "have $dst"; return 0; }
  mkdir -p "$(dirname "$dst")"
  while [ $n -lt 40 ]; do
    n=$((n+1))
    curl -L --fail --retry 5 --retry-delay 10 -C - -o "$dst.part" "$url" \
      && mv "$dst.part" "$dst" && echo "done $dst" && return 0
    echo "attempt $n failed for $dst, resuming in 15s"; sleep 15
  done
  return 1
}
export HF_HUB_DISABLE_XET=1
# SDXL base 1.0 - 6.9 GB, CheckpointLoaderSimple, the quickest smoke test.
get "$M/checkpoints/sd_xl_base_1.0.safetensors" \
    https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
# FLUX.1-schnell fp8 all-in-one (unet + clip_l + t5 fp8 + vae) - 17.2 GB,
# CheckpointLoaderSimple, 4 steps, Apache-2.0, not gated.
get "$M/checkpoints/flux1-schnell-fp8.safetensors" \
    https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors
echo "EXIT:$?"
