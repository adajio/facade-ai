#!/bin/sh
set -eu
export HOME=/tmp
umask 077

office() {
    input="$1"
    shift
    soffice -env:UserInstallation=file:///tmp/profile --headless --nologo --nodefault \
        --norestore "$@" --outdir /tmp "$input" >&2
}

has_word_table() {
    [ -s "$1" ] && unzip -p "$1" word/document.xml | grep -E -q '<w:tbl[ >]'
}

case "$1" in
    version-office) exec soffice --version ;;
    version-dwg) exec dwg2dxf --version ;;
    dwg)
        set --
        if [ "$(head -c 6 /original.dwg)" = AC1027 ]; then
            set -- --as r2013
        fi
        cd /out
        check_disk_result() {
            if [ "$2" -eq 153 ] || { [ -f "$1" ] &&
                [ "$(stat -c %s "$1")" -ge "$FACADE_DWG_OUTPUT_BUDGET" ]; }; then
                exit 73
            fi
        }
        result=0
        dwg2dxf "$@" -o original.dxf /original.dwg >&2 || result=$?
        check_disk_result original.dxf "$result"
        if [ "$result" -eq 0 ] && [ "$(tail -n 1 original.dxf | tr -d '\r')" = EOF ]; then
            mv original.dxf derivative
        else
            rm -f original.dxf
            result=0
            dwgread -O JSON -o derivative /original.dwg >&2 || result=$?
            check_disk_result derivative "$result"
            [ "$result" -eq 0 ] || exit "$result"
        fi
        chmod 0444 derivative
        ;;
    doc)
        format='docx:Office Open XML Text'
        if office /original.doc --convert-to "$format" && has_word_table /tmp/original.docx; then
            exec cat /tmp/original.docx
        fi
        if java -Xmx128m -Djava.awt.headless=true -jar /opt/tika/tika-app.jar --xml /original.doc \
            >/tmp/recovered.html && grep -E -q '<table[ >]' /tmp/recovered.html &&
            office /tmp/recovered.html --infilter='HTML (StarWriter)' --convert-to "$format" &&
            has_word_table /tmp/recovered.docx; then
            exec cat /tmp/recovered.docx
        fi
        exec cat /tmp/original.docx
        ;;
    xls)
        office /original.xls --convert-to 'xlsx:Calc MS Excel 2007 XML'
        exec cat /tmp/original.xlsx
        ;;
    *) exit 2 ;;
esac
