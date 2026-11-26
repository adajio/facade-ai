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

complete_dxf_framing() {
    # Check the ASCII group stream without decoding or changing the entity values.
    LC_ALL=C awk '
        function token(line) {
            gsub(/^[ \t]+|[ \t]+$/, "", line)
            return line
        }
        function group_code(line) {
            line=token(line)
            return (line ~ /^[0-9]+$/ && length(line) <= 4) ? line+0 : -1
        }
        function invalid() { bad=1; exit }
        function read_value(    status) {
            status=(getline value)
            if (status < 0) { io=1; exit }
            if (status == 0) invalid()
        }
        # In CRLF output, a bare LF can belong to the value rather than the framing.
        NR == 1 {
            sub(/^\357\273\277/, "")
            if (/\r$/) { RS="\r\n"; sub(/\r$/, "") }
        }
        {
            code=group_code($0)
            if (eof || code < 0) invalid()
            read_value()
            multiline = (code == 1 || code == 3) && (record == "MTEXT" ||
                (section == "OBJECTS" && record == "XRECORD"))
            if (value ~ /\r/ || (value ~ /\n/ && !multiline)) invalid()
            if (code == 0) {
                record=toupper(token(value))
                if (record == "SECTION") {
                    if (section) invalid()
                    read_value()
                    if (group_code(value) != 2) invalid()
                    read_value()
                    section=toupper(token(value))
                    if (section !~ /^[A-Z0-9_]+$/ || (section == "ENTITIES" && ++entities != 1)) invalid()
                } else if (record == "ENDSEC") {
                    if (!section) invalid()
                    section=""
                } else if (record == "EOF") {
                    if (section) invalid()
                    eof=1
                } else if (!section) invalid()
            } else if (!section && code != 999) invalid()
        }
        END { if (io) exit 2; if (bad || !eof || entities != 1) exit 1 }
    ' "$1"
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
            if [ "$2" -eq 73 ] || [ "$2" -eq 153 ] || { [ -f "$1" ] &&
                [ "$(stat -c %s "$1")" -ge "$FACADE_DWG_OUTPUT_BUDGET" ]; }; then
                exit 73
            fi
        }
        result=0
        dwg2dxf "$@" -o original.dxf /original.dwg >&2 || result=$?
        check_disk_result original.dxf "$result"
        case "$result" in 124|137|143) exit "$result" ;; esac
        framing=1
        if [ "$result" -eq 0 ] && [ -s original.dxf ]; then
            framing=0
            complete_dxf_framing original.dxf || framing=$?
            [ "$framing" -le 1 ] || exit "$framing"
        fi
        if [ "$framing" -eq 0 ]; then
            mv original.dxf derivative
        else
            rm -f original.dxf
            result=0
            dwgread -O JSON -o recovered.json /original.dwg >&2 || result=$?
            check_disk_result recovered.json "$result"
            [ "$result" -eq 0 ] || exit "$result"
            [ -s recovered.json ] || exit 1
            mv recovered.json derivative
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
