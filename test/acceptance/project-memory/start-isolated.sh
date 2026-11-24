#!/usr/bin/env bash
set -euo pipefail
umask 077

mode=${1:?api, offline-worker or live-worker}
image=${2:?reader image tag}
db_env=${3:?stand new-db environment file}
port=${4:?isolated loopback port}
data_dir=$(dirname -- "$db_env")
database=${data_dir##*/}
[[ "$image" =~ ^facade-ai-test-server:[a-f0-9]{64}$ ]]
[[ "$database" =~ ^test_project_memory_(rehearsal|live)_([a-f0-9]{12})$ ]]
phase=${BASH_REMATCH[1]}
series=${BASH_REMATCH[2]}
[[ "$port" =~ ^18[0-9]{3}$ && "$port" != 18443 ]]
[[ -f "$data_dir/runtime.env" && ! -L "$data_dir/runtime.env" ]]
if grep -Eq '^(FACADE_HARNESS_MANAGED_URL|FACADE_GATEWAY_OPENROUTER_KEY|FACADE_GATEWAY_LIVE_MODE)=' "$data_dir/runtime.env"; then
  echo 'Model settings belong only in the separate live-worker profile.' >&2
  exit 2
fi

network=facade-ai-test-server_private
prefix=facade-ai-project-memory
common=(--pull=never --init --read-only --cap-drop ALL --security-opt no-new-privileges
  --cpuset-cpus 0-3 --user "$(id -u):$(id -g)" --network "$network"
  -e FACADE_DATA_DIR=/data/objects -e TMPDIR=/data/tmp
  -e "FACADE_PUBLIC_ORIGIN=http://127.0.0.1:$port"
  --mount "type=bind,source=$data_dir/runtime.env,target=/run/facade/runtime.env,readonly"
  --mount "type=bind,source=$data_dir/objects,target=/data/objects"
  --mount "type=bind,source=$data_dir/tmp,target=/data/tmp")
if [[ "$phase" == live ]]; then
  common+=(-e FACADE_GATEWAY_EXPECTED_JOURNAL_LIMIT_USD_NANOS=5000000000)
fi
node_args=(--env-file=/run/facade/runtime.env)

case "$mode" in
  api)
    entry=api
    runtime=(--memory 512m -e HOST=127.0.0.1 -e PORT=3000 -e FACADE_GATEWAY_LIVE_MODE=)
    ;;
  offline-worker)
    entry=worker
    runtime=(--memory 1024m -e FACADE_GATEWAY_LIVE_MODE= -e FACADE_HARNESS_REPLAY_ONLY=1
      -e FACADE_HARNESS_PACKAGE_WALK=1)
    ;;
  live-worker)
    [[ "$phase" == live ]]
    live_env=${5:?separate verified live profile file}
    [[ -f "$live_env" && ! -L "$live_env" && "$(stat -f '%Lp' "$live_env")" == 600 ]]
    live_network="$prefix-internal-$series"
    [[ "$(docker --context orbstack network inspect -f '{{.Internal}}' "$live_network")" == true ]]
    entry=worker
    runtime=(--memory 1536m --network "$live_network" -e FACADE_GATEWAY_LIVE_MODE=step-15
      -e NODE_USE_ENV_PROXY=1 -e HTTPS_PROXY=http://project-memory-openrouter:3128
      -e NO_PROXY=postgres,postgres-journal,objects,localhost,127.0.0.1
      -e FACADE_HARNESS_PACKAGE_EFFECTS=enabled -e FACADE_HARNESS_PACKAGE_WALK=1
      --mount "type=bind,source=$live_env,target=/run/facade/model.env,readonly")
    node_args+=(--env-file=/run/facade/model.env)
    ;;
  *) exit 2 ;;
esac

name="$prefix-$entry-$phase-$series"
docker --context orbstack run -d --name "$name" "${common[@]}" "${runtime[@]}" \
  "$image" "${node_args[@]}" "dist/apps/$entry/src/main.js" >/dev/null
printf '%s\n' "$name"
