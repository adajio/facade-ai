#!/bin/sh
set -eu
umask 077
export LC_ALL=C.UTF-8
binary=/oda/ODAFileConverter
syslibs=/deps/usr/lib/x86_64-linux-gnu:/deps/lib/x86_64-linux-gnu
version='Build 27.10.0.151591'

case "$1" in
    oda-probe)
        test -x "$binary" && test -x /deps/usr/bin/Xvfb && test "$(cat /oda/build.txt)" = "$version" || exit 69
        sha256sum "$binary" | cut -d ' ' -f 1
        # Pin the read-only distribution, including plugins, libraries, fonts and symlink targets.
        find /oda /deps -type f -exec sha256sum {} + >/tmp/oda-files
        find /oda /deps -type l -printf '%p -> %l\n' >>/tmp/oda-files
        sort /tmp/oda-files | sha256sum | cut -d ' ' -f 1
        ;;
    dwg)
        test -x "$binary" && test -x /deps/usr/bin/Xvfb || exit 69
        export HOME=/tmp/oda-home XDG_RUNTIME_DIR=/tmp/oda-runtime
        mkdir -m 700 "$HOME" "$XDG_RUNTIME_DIR"
        mkdir -m 1777 /tmp/.X11-unix
        LD_LIBRARY_PATH="$syslibs" /deps/usr/bin/Xvfb -displayfd 3 -nolisten tcp \
            -screen 0 1280x800x24 -extension MIT-SHM -ac -xkbdir /deps/usr/share/X11/xkb \
            3>/tmp/oda-display >/dev/null 2>&1 &
        server=$!
        trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT
        for attempt in 1 2 3 4 5 6 7 8 9 10; do
            test ! -s /tmp/oda-display || break
            kill -0 "$server" 2>/dev/null || exit 69
            sleep 1
        done
        test -s /tmp/oda-display || exit 69
        export DISPLAY=":$(cat /tmp/oda-display)" QT_QPA_PLATFORM=xcb QT_X11_NO_MITSHM=1
        export QT_PLUGIN_PATH=/oda/plugins FONTCONFIG_PATH=/deps/etc/fonts
        cd /out
        status=0
        LD_LIBRARY_PATH="/oda:/oda/lib:$syslibs" "$binary" /input /out ACAD2013 DXF 0 0 original.dwg || status=$?
        if [ "$status" -eq 153 ] || { [ -f original.dxf ] &&
            [ "$(stat -c %s original.dxf)" -ge "$FACADE_DWG_OUTPUT_BUDGET" ]; }; then
            exit 73
        fi
        [ "$status" -eq 0 ] || exit 74
        for error in ./*.err ./*.ERR; do
            [ ! -e "$error" ] || exit 74
        done
        [ -s original.dxf ] || exit 74
        # Validate the text DXF envelope before the broker can release any bytes.
        awk '
            { if (eof || $0 !~ /^[ \t]*[0-9]+[ \t\r]*$/ || (getline v) != 1) { bad=1; exit }
              sub(/\r$/, "", v)
              if ($0+0 == 0 && v == "SECTION") {
                  if (section != "" || (getline) != 1 || $0+0 != 2 || (getline v) != 1) { bad=1; exit }
                  sub(/\r$/, "", v)
                  section=v
                  if (section == "ENTITIES" && ++entities != 1) { bad=1; exit }
              } else if ($0+0 == 0 && v == "ENDSEC") {
                  if (section == "") { bad=1; exit }
                  section=""
              } else if ($0+0 == 0 && v == "EOF") {
                  if (section != "") { bad=1; exit }
                  eof=1
              } else if (section == "HEADER" && $0+0 == 9 && v == "$ACADVER") {
                  if ((getline) != 1 || $0+0 != 1 || (getline v) != 1) { bad=1; exit }
                  sub(/\r$/, "", v)
                  r2013=(v == "AC1027")
              }
            }
            END { if (bad || !eof || entities != 1 || !r2013) exit 1 }
        ' original.dxf || exit 74
        mv original.dxf derivative
        chmod 0444 derivative
        ;;
    *) exit 2 ;;
esac
