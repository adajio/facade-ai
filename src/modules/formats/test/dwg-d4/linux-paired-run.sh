#!/bin/sh
# Run in one disposable linux/amd64 container with app, packages and inputs mounted read-only.
set -eu
umask 077
unset DISPLAY
export LC_ALL=C.UTF-8
export HOME=/tmp/dwg-home
export XDG_RUNTIME_DIR=/tmp/dwg-runtime
mkdir -m 700 "$HOME" "$XDG_RUNTIME_DIR"
work=$(mktemp -d)
results="$work/results"
mkdir "$results"

{
  uname -sm
  cat /etc/debian_version
  sha256sum /libredwg/bin/dwg2dxf /libredwg/bin/dwgread /libredwg/lib/libredwg.so.0.0.13
  LD_LIBRARY_PATH=/libredwg/lib /libredwg/bin/dwg2dxf --version
  LD_LIBRARY_PATH=/libredwg/lib /libredwg/bin/dwgread --version
} >"$results/runtime.txt"

syslibs=/deps/usr/lib/x86_64-linux-gnu:/deps/lib/x86_64-linux-gnu
if [ -x /oda/ODAFileConverter ]; then
  sha256sum /oda/ODAFileConverter >>"$results/runtime.txt"
  printf '%s\n' "$(cat /oda/build.txt)" >>"$results/runtime.txt"
  mkdir -m 1777 /tmp/.X11-unix
  LD_LIBRARY_PATH="$syslibs" /deps/usr/bin/Xvfb -displayfd 3 -nolisten tcp -screen 0 1280x800x24 -ac \
    -xkbdir /deps/usr/share/X11/xkb 3>"$work/display" >"$results/xvfb.log" 2>&1 &
  xserver=$!
  trap 'kill "$xserver" 2>/dev/null || true' EXIT
  for retry in 1 2 3 4 5 6 7 8 9 10; do
    if [ -s "$work/display" ]; then break; fi
    if ! kill -0 "$xserver" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ -s "$work/display" ]; then
    DISPLAY=":$(cat "$work/display")"
    export DISPLAY QT_QPA_PLATFORM=xcb QT_PLUGIN_PATH=/oda/plugins
    export FONTCONFIG_PATH=/deps/etc/fonts
  fi
fi

measure() {
  log=$1
  shift
  code=0
  start=$(date +%s%N)
  if [ -x /deps/usr/bin/time ]; then
    timeout --kill-after=2s 35s /deps/usr/bin/time -q -f '%M' -o "$log.rss-kib" "$@" \
      >"$log.stdout" 2>"$log.stderr" || code=$?
  else
    timeout --kill-after=2s 35s "$@" >"$log.stdout" 2>"$log.stderr" || code=$?
  fi
  end=$(date +%s%N)
  printf '%s\t%s\n' "$code" "$(((end - start) / 1000000))" >"$log.status"
}

has_dxf_markers() {
  awk '
    { sub(/\r$/, ""); gsub(/^[ \t]+|[ \t]+$/, "") }
    NR % 2 == 1 { code=$0; next }
    section && code == 2 && $0 == "ENTITIES" { entities = 1 }
    { section = (code == 0 && $0 == "SECTION"); last = $0 }
    END { exit !(entities && code == 0 && last == "EOF" && NR % 2 == 0) }
  ' "$1"
}

if [ "${FACADE_D4_ODA_CONTROL:-0}" = 1 ]; then
  test -n "${DISPLAY:-}"
  mkdir "$work/seed" "$results/to-dwg" "$results/to-dxf"
  cp /positive.dxf "$work/seed/control.dxf"
  sha256sum "$work/seed/control.dxf" >"$results/seed.sha256"
  measure "$results/to-dwg/convert" env LD_LIBRARY_PATH="/oda:/oda/lib:$syslibs" /oda/ODAFileConverter \
    "$work/seed" "$results/to-dwg" ACAD2000 DWG 0 0 control.dxf
  if [ -s "$results/to-dwg/control.dwg" ]; then
    measure "$results/to-dxf/convert" env LD_LIBRARY_PATH="/oda:/oda/lib:$syslibs" /oda/ODAFileConverter \
      "$results/to-dwg" "$results/to-dxf" ACAD2000 DXF 0 0 control.dwg
  fi
elif [ "${FACADE_D4_ODA_AUDIT:-0}" = 1 ]; then
  test -n "${DISPLAY:-}"
  for name do
    out="$results/$name"
    libre="/pair/$name/libredwg/original.dwg"
    oda="/pair/$name/oda-in"
    cmp "$libre" "$oda/original.dwg"
    mkdir -p "$out/oda"
    sha256sum "$libre" "$oda/original.dwg" >"$out/inputs.sha256"
    (
      cd "$out/oda"
      measure convert env LD_LIBRARY_PATH="/oda:/oda/lib:$syslibs" /oda/ODAFileConverter \
        "$oda" "$out/oda" ACAD2000 DXF 0 1 original.dwg
    )
  done
else
  for name do
    out="$results/$name"
    libre="/pair/$name/libredwg/original.dwg"
    oda="/pair/$name/oda-in"
    test -f "$libre" && test -f "$oda/original.dwg"
    cmp "$libre" "$oda/original.dwg"
    mkdir -p "$out/libredwg" "$out/oda"
    sha256sum "$libre" "$oda/original.dwg" >"$out/inputs.sha256"
    (
      cd "$out/libredwg"
      measure convert env LD_LIBRARY_PATH=/libredwg/lib /libredwg/bin/dwg2dxf --as r2000 -o result.dxf "$libre"
      if [ "$(head -c 4 "$libre")" = AC10 ] &&
          { [ ! -f result.dxf ] || ! has_dxf_markers result.dxf ||
            [ "$(cut -f1 convert.status)" != 0 ]; }; then
        measure recovery env LD_LIBRARY_PATH=/libredwg/lib /libredwg/bin/dwgread -O JSON -o result.json "$libre"
      fi
    )
    if [ -n "${DISPLAY:-}" ]; then
      (
        cd "$out/oda"
        measure convert env LD_LIBRARY_PATH="/oda:/oda/lib:$syslibs" /oda/ODAFileConverter \
          "$oda" "$out/oda" ACAD2000 DXF 0 0 original.dwg
      )
      # A drawing error proves the CLI started. Only an unclassified startup failure stops the ODA limb.
      if [ "$name" = schedule ] &&
          [ ! -s "$out/oda/original.dxf" ] && [ ! -s "$out/oda/original.dxf.err" ]; then
        unset DISPLAY
      fi
    fi
  done

  # Reuse the fixed XREF host and each target under the same relative name.
  # The conversion filter names only the host, so the child is never an independent output here.
  for state in accepted stale foreign; do
    input="$work/xref-$state"
    out="$results/xref-context/$state"
    mkdir -p "$input" "$out/libredwg" "$out/oda"
    cp /pair/xref-host/libredwg/original.dwg "$input/original.dwg"
    cp "/pair/xref-$state/libredwg/original.dwg" "$input/xref-target.dwg"
    sha256sum "$input/original.dwg" "$input/xref-target.dwg" >"$out/inputs.sha256"
    (
      cd "$out/libredwg"
      measure convert env LD_LIBRARY_PATH=/libredwg/lib /libredwg/bin/dwg2dxf --as r2000 \
        -o result.dxf "$input/original.dwg"
    )
    if [ -n "${DISPLAY:-}" ]; then
      (
        cd "$out/oda"
        measure convert env LD_LIBRARY_PATH="/oda:/oda/lib:$syslibs" /oda/ODAFileConverter \
          "$input" "$out/oda" ACAD2000 DXF 0 0 original.dwg
      )
    fi
  done

fi

if [ -r /sys/fs/cgroup/memory.peak ]; then
  printf 'cgroup_peak_bytes=' >>"$results/runtime.txt"
  cat /sys/fs/cgroup/memory.peak >>"$results/runtime.txt"
fi
tar -C "$results" -cf - .
