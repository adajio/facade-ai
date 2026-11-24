#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "$0")" && pwd)"
format="${1:-}"
case "$format" in
  doc|xls) image="${FACADE_OFFICE_IMAGE:?Set FACADE_OFFICE_IMAGE}" ;;
  dwg) image="${FACADE_DWG_IMAGE:?Set FACADE_DWG_IMAGE}" ;;
  *) printf 'Usage: %s doc|xls|dwg [original]\n' "$0" >&2; exit 2 ;;
esac
original="${2:-$here/fixtures/schedule.$format}"
[[ -f "$original" ]] || exit 2
original="$(cd -- "$(dirname -- "$original")" && pwd)/$(basename -- "$original")"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
container="facade-step11-bench-$(node -p 'require("node:crypto").randomUUID()')"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run --rm --pull=never --name "$container" --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges=true --user=65534:65534 --pids-limit=64 --memory=512m \
  --memory-swap=512m --cpus=1 --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=96m,mode=1777 --log-driver=none \
  --mount "type=bind,source=$original,target=/original.$format,readonly" --entrypoint /bin/sh "$image_id" -ec '
    if [ "$1" = dwg ]; then tool=version-dwg; else tool=version-office; fi
    /usr/local/bin/facade-convert "$tool"
    uname -m
    printf "image=%s\n" "$2"
    payload="$(wc -c < "/original.$1")"
    start="$(date +%s%N)"
    timeout --kill-after=2s 35s /usr/local/bin/facade-convert "$1" >/tmp/benchmark-output
    finish="$(date +%s%N)"
    printf "input_bytes=%s output_bytes=%s elapsed_ms=%s\n" "$payload" \
      "$(wc -c </tmp/benchmark-output)" "$(((finish - start) / 1000000))"
    if [ -r /sys/fs/cgroup/memory.peak ]; then
      printf "cgroup_peak_bytes=%s\n" "$(cat /sys/fs/cgroup/memory.peak)"
    fi
  ' bench "$format" "$image_id"
