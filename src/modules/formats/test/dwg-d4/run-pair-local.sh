#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
run=$(CDPATH= cd -- "${1:?Supply local evidence directory}" && pwd)
export DOCKER_CONTEXT="${DOCKER_CONTEXT:-orbstack}"
base='debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3'
expected='sha256:a3bba7dc7dbcc1f37c2856c51fc9a7fac96608f50cb87b1b4e4d8b8c85ae988e linux/amd64'
identity=$(docker image inspect --platform linux/amd64 --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$base")
test "$identity" = "$expected"
test -r "$run/tools/bin/dwg2dxf"
test -r "$run/pair/pair-plan.json"
output=raw
if [ "${FACADE_D4_ODA_CONTROL:-0}" = 1 ]; then
  test -n "${FACADE_D4_ODA_APP:-}"
  test -z "${FACADE_D4_ODA_AUDIT_FROM:-}"
  output=control-raw
elif [ -n "${FACADE_D4_ODA_AUDIT_FROM:-}" ]; then
  test -n "${FACADE_D4_ODA_APP:-}"
  output=audit-raw
fi
test ! -e "$run/$output"
mkdir "$run/$output"
printf '%s\n' "$identity" >"$run/base-image.txt"

case_names=$(node --input-type=module - "$run/pair/pair-plan.json" "${FACADE_D4_ODA_AUDIT_FROM:-}" <<'JS'
import { readFileSync } from "node:fs";
const { cases } = JSON.parse(readFileSync(process.argv[2]));
const report = process.argv[3] ? JSON.parse(readFileSync(process.argv[3])) : null;
for (const { name, sha256, signature } of cases) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid case name");
  if (report && report.cases[name]?.sha256 !== sha256) throw new Error("Pair input differs from the main result");
  if (report && (!/^AC10\d{2}$/.test(signature) || report.cases[name].oda.state !== "held")) continue;
  console.log(name);
}
JS
)

test -n "$case_names"
set -- --mount "type=bind,src=$run/tools,dst=/libredwg,readonly"
if [ "$output" = audit-raw ]; then set -- "$@" -e FACADE_D4_ODA_AUDIT=1; fi
if [ "$output" = control-raw ]; then
  set -- "$@" -e FACADE_D4_ODA_CONTROL=1 \
    --mount "type=bind,src=$here/fixtures/oda-positive-r12.dxf,dst=/positive.dxf,readonly"
fi
if [ -n "${FACADE_D4_ODA_APP:-}" ]; then
  deps="$run/desktop-runtime/root"
  set -- "$@" \
    --mount "type=bind,src=$FACADE_D4_ODA_APP,dst=/oda,readonly" \
    --mount "type=bind,src=$deps,dst=/deps,readonly" \
    --mount "type=bind,src=$deps/usr/bin/xkbcomp,dst=/usr/bin/xkbcomp,readonly" \
    --mount "type=bind,src=$deps/usr/share/fonts,dst=/usr/share/fonts,readonly"
fi

# Names were checked above. Each one is a single ASCII token.
# shellcheck disable=SC2086
docker run --rm --pull=never --init --platform linux/amd64 --network=none --read-only \
  --user=65534:65534 --cap-drop=ALL --security-opt=no-new-privileges=true \
  --cpus=1 --memory=512m --memory-swap=512m --pids-limit=64 \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=96m,mode=1777 "$@" \
  --mount "type=bind,src=$run/pair,dst=/pair,readonly" \
  --mount "type=bind,src=$here/linux-paired-run.sh,dst=/trial.sh,readonly" \
  --entrypoint /bin/sh "$base" /trial.sh $case_names \
  >"$run/$output.tar" 2>"$run/$output.container.stderr"
tar -xf "$run/$output.tar" -C "$run/$output"
