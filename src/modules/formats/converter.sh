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
