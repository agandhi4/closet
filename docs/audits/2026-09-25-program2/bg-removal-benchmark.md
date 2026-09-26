# Background removal on the server: benchmark and placement (2026-09-26)

Raw material: scratchpad bgbench/ (scripts, logs, test photos with licences in imgs/SOURCES.txt, cutouts
in out/). Summary of the benchmark agent's report.

## Recommendation
- Model: **BiRefNet 512x512** (`onnx-community/BiRefNet_512x512-ONNX`, MIT, 940 MB). Best cutouts that fit:
  5/5 correct on real Wikimedia garment photos. Today's model (IS-Net, imgly quint8) failed 2/5 (kept the
  stand under a hanging sweater; semi-transparent flat-lay; quint8 kept a rock).
- Placement: **C — app stays on the NAS; a small authenticated cutout sidecar runs on linux-box** (like
  Immich's machine-learning container). Cutouts are asynchronous: upload returns at once, the sidecar
  returns a mask, the NAS composes the cutout (~5 s warm). If linux-box is down, the original photo stays
  and a retry is queued.
- Why not A (all on NAS): the NAS is a Celeron J4125 with **no AVX**; BiRefNet-512 would take ~26 s and
  3.3 GB (not viable); only u2net fits (~5–7 s, 0.8 GB, soft haloed edges), on a 7.6 GB box already swapping.
- Why not B (whole stack on linux-box): Closet would go down whenever linux-box is off or rebooting.

## Numbers (per photo, total pipeline)
| Model | linux-box 4 threads | NAS estimate | Peak RSS | Licence |
|---|---|---|---|---|
| u2net | 0.73 s | 5.4 s (4.0–6.7) | 0.8 GB | Apache-2.0 |
| IS-Net fp32 | 1.07 s | 11 s | 1.0 GB | Apache-2.0 (weights) |
| IS-Net quint8 (today, browser) | 1.75 s | 24 s | 1.2 GB | same |
| BiRefNet 512 | 3.34 s (2.70 s at 8 threads) | 26 s | 3.4 GB | MIT |
| BiRefNet general 1024 | 12.97 s | — | 7.8 GB | MIT |
RMBG-1.4/2.0 excluded (non-commercial). Quantized models are slower on CPU. The Radeon 780M iGPU does not
help BiRefNet (no ROCm/DirectML for it on Linux; experimental WebGPU was slower for BiRefNet-512).

## Architecture for C
Phone downscales to 1600 px and uploads one JPEG (fixes the 24 MP iPhone failure; HEIC falls back to the
server decode). App stores original + thumb, sets cutout_status=pending, a one-at-a-time DB-backed queue
sends the 1080 px image to CUTOUT_URL/v1/mask with a bearer token, composes the cutout in photos.ts, bumps
the version. Explicit state machine none→pending→ready|failed, →edited on a mask save; each job carries the
photo version and only writes if it still matches (never overwrite a user-edited cutout). Timeouts 2 s
connect / 30 s total, circuit breaker 60 s, nightly retry up to 3. Sidecar: Node 22 + onnxruntime-node +
sharp, arena off, unload after 15 min idle, queue depth 4 then 503, 8 MB / 64 MP limits, not on the public
Caddy network, LAN/Tailscale bind + firewall to the NAS + token. Rollout behind CUTOUT_MODE=client|server.
App image −514 MB once the browser model, onnxruntime-web and imgly data are removed.

## linux-box prerequisites
GNOME suspends after 15 min idle on AC (has not fired in 14 days): mask sleep/suspend/hibernate targets.
Reboots for kernel updates happen (retries cover them).
