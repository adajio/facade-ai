#!/usr/bin/env bash
set -euo pipefail

db_env=${1:?stand new-db environment file}
data=$(dirname -- "$db_env")
[[ "${data##*/}" =~ ^test_project_memory_live_[a-f0-9]{12}$ ]]
journal_db=$(python3 - "$data/runtime.env" <<'PY'
from pathlib import Path
from sys import argv
from urllib.parse import urlsplit
import re
env = dict(line.split('=',1) for line in Path(argv[1]).read_text().splitlines() if '=' in line)
url = urlsplit(env['FACADE_GATEWAY_JOURNAL_URL'])
name = url.path.lstrip('/')
assert url.hostname == 'postgres-journal' and re.fullmatch(r'journal_[a-f0-9]{24}',name)
print(name)
PY
)
docker --context orbstack exec -i --user postgres facade-ai-test-server-postgres-journal-1 \
  psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d "$journal_db" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH route AS (
  SELECT route_id, purpose, state, count(*) AS calls, sum(spent_usd_nanos) AS cost,
    coalesce(sum(ceiling_usd_nanos) FILTER (WHERE state IN ('prepared','sending','unknown')),0) AS reserve,
    count(*) FILTER (WHERE (receipt->>'routeVerified')::boolean) AS verified,
    count(DISTINCT receipt->>'providerId') FILTER (WHERE state='paid') AS distinct_paid,
    coalesce(array_agg(DISTINCT receipt->>'code') FILTER (WHERE receipt ? 'code'),ARRAY[]::text[]) AS codes
    FROM gateway_external_attempts GROUP BY route_id, purpose, state
), total AS (
  SELECT coalesce(sum(cost),0) AS spent, coalesce(sum(reserve),0) AS reserved, coalesce(sum(calls),0) AS attempts FROM route
)
SELECT json_build_object('cap',l.limit_usd_nanos,'frozen',l.frozen,'spent',t.spent,'reserved',t.reserved,
  'available',greatest(l.limit_usd_nanos-t.spent-t.reserved,0),'attempts',t.attempts,
  'routes',coalesce((SELECT json_agg(route ORDER BY route_id,purpose,state) FROM route),'[]'::json))
FROM gateway_external_ledger l CROSS JOIN total t WHERE l.singleton AND l.limit_usd_nanos=5000000000;
COMMIT;
SQL
