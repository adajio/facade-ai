#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=adajio/facade-ai
docker=(docker --context orbstack)
private_network=facade-ai-ci-private
proxy=http://facade-ci-proxy:8888
runner_id=
runner_name=

cleanup() {
  if [[ -n "$runner_name" ]]; then
    "${docker[@]}" stop --time 10 "$runner_name" >/dev/null 2>&1 || true
  fi
  if [[ -n "$runner_id" ]]; then
    gh api --method DELETE "repos/$repo/actions/runners/$runner_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

while true; do
  [[ "$("${docker[@]}" network inspect --format '{{.Internal}} {{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}' "$private_network")" == 'true isolated' ]]
  [[ "$("${docker[@]}" inspect --format '{{.State.Running}}' facade-ai-ci-proxy)" == true ]]

  runner_name="facade-ai-ssd-$(date +%s)-$RANDOM"
  payload=$(jq -n --arg name "$runner_name" '{
    name: $name, runner_group_id: 1, work_folder: "_work",
    labels: ["self-hosted", "Linux", "ARM64", "facade-ai-ssd"]
  }')
  registration=$(printf '%s' "$payload" | gh api --method POST "repos/$repo/actions/runners/generate-jitconfig" --input -)
  runner_id=$(jq -er '.runner.id' <<<"$registration")
  jit=$(jq -er '.encoded_jit_config | select(length > 0)' <<<"$registration")
  unset registration
  printf 'Started ephemeral runner %s\n' "$runner_name"
  result=0
  printf '%s\n' "$jit" | "${docker[@]}" run --rm -i --init --pull never \
    --name "$runner_name" --label io.facade.ci=facade-ai \
    --network "$private_network" --cap-drop ALL --security-opt no-new-privileges \
    --cpuset-cpus 0,1 --memory 3g --memory-swap 3g --pids-limit 256 \
    -e "http_proxy=$proxy" -e "https_proxy=$proxy" \
    -e "HTTP_PROXY=$proxy" -e "HTTPS_PROXY=$proxy" \
    facade-ai-ci-runner:2.338.2 || result=$?
  unset jit
  printf 'Runner %s exited with %s\n' "$runner_name" "$result"
  runner_name=
  cleanup
  runner_id=
  if (( result != 0 )); then
    sleep 15
  fi
done
