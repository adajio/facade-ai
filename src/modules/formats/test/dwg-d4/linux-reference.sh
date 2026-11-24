#!/bin/sh
set -eu
umask 077
work=$(mktemp -d)
mkdir "$work/output"
for case_name in schedule dwg-recovery; do
    (cd "$work/output" && dwg2dxf -o "$case_name.dxf" "/baseline/$case_name.dwg" ) >&2
done
dwgread -O JSON -o "$work/output/dwg-recovery.json" /baseline/dwg-recovery.dwg >&2
for state in missing accepted stale foreign; do
    mkdir "$work/$state"
    cp /fixtures/xref-host.dwg "$work/$state/xref-host.dwg"
    if [ "$state" != missing ]; then
        cp "/fixtures/xref-$state.dwg" "$work/$state/xref-target.dwg"
        (cd "$work/$state" && dwg2dxf -o "$work/output/xref-$state.dxf" xref-target.dwg ) >&2
    fi
    (cd "$work/$state" && dwg2dxf -o "$work/output/xref-host-$state.dxf" xref-host.dwg ) >&2
done
dwg2dxf --version >&2
dwgread --version >&2
if [ -r /sys/fs/cgroup/memory.peak ]; then
    printf 'cgroup_peak_bytes=' >&2
    cat /sys/fs/cgroup/memory.peak >&2
fi
tar -C "$work/output" -cf - .
