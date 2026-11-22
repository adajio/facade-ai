#!/bin/sh
set -eu
export HOME=/tmp
umask 077

case "$1" in
    version-office) exec soffice --version ;;
    version-dwg) exec dwg2dxf --version ;;
    dwg)
        dwg2dxf -o /tmp/original.dxf /original.dwg >&2
        exec cat /tmp/original.dxf
        ;;
    doc) conversion='docx:Office Open XML Text'; output=docx ;;
    xls) conversion='xlsx:Calc MS Excel 2007 XML'; output=xlsx ;;
    *) exit 2 ;;
esac

soffice -env:UserInstallation=file:///tmp/profile --headless --nologo --nodefault \
    --norestore --convert-to "$conversion" --outdir /tmp "/original.$1" >&2
exec cat "/tmp/original.$output"
