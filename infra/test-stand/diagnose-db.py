#!/usr/bin/env python3
"""Measure isolated synthetic PostgreSQL load and logical recovery."""

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from time import monotonic, sleep
from uuid import uuid4


HERE = Path(__file__).resolve().parent
DOCKER = ["docker", "--context", "orbstack"]
SOURCE = "facade-ai-test-server-postgres-1"
IMAGE = "postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657"


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def db_command(container, *args):
    return DOCKER + ["exec", "-i", "--user", "postgres", container, *args]


def sql(container, database, statement, user="postgres"):
    return run(
        db_command(container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database),
        input=statement, text=True, capture_output=True,
    ).stdout.strip()


def new_db(label):
    env = Path(run([HERE / "stand", "new-db", label], capture_output=True, text=True).stdout.strip())
    return env.parent.name, env.parent / "objects", env.parents[2]


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def resources(container):
    return run(db_command(
        container, "sh", "-c",
        'df -B1 "$PGDATA"; head -1 /proc/stat; '
        'for file in cpu.stat memory.current memory.peak io.stat; do '
        'printf "\n%s\n" "$file"; cat "/sys/fs/cgroup/$file" 2>/dev/null || :; done',
    ), text=True, capture_output=True).stdout


def benchmark(database, clients, seconds, prefix, results):
    with (results / f"{prefix}.log").open("wb") as log:
        process = subprocess.Popen(db_command(
            SOURCE, "pgbench", "-U", database, "-c", str(clients), "-j", "2", "-T", str(seconds),
            "-P", "2", "--log", f"--log-prefix=/tmp/{prefix}", database,
        ), stdout=log, stderr=subprocess.STDOUT)
    return process


def collect_benchmark(process, prefix, results):
    if process.wait(timeout=90):
        raise RuntimeError(f"pgbench failed, see {prefix}.log")
    transactions = results / f"{prefix}-latencies.tsv"
    # A generated hex suffix and fixed prefixes are the only shell interpolation.
    with transactions.open("wb") as output:
        run(db_command(SOURCE, "sh", "-c", f"cat /tmp/{prefix}.* && rm /tmp/{prefix}.*"), stdout=output)
    latencies = sorted(int(line.split()[2]) for line in transactions.read_text().splitlines())
    summary = (results / f"{prefix}.log").read_text()
    tps = float(re.search(r"tps = ([0-9.]+)", summary).group(1))
    return {"transactions": len(latencies), "tps": tps,
            "p95_ms": latencies[math.ceil(0.95 * len(latencies)) - 1] / 1000}


def main():
    os.umask(0o077)
    token = uuid4().hex[:12]
    restore = f"facade-ai-test-server-restore-{token}"
    volume = f"{restore}-postgres"
    a, _, stand = new_db("diag_load")
    b, objects, _ = new_db("diag_restore")
    results = stand / "backups" / f"diagnostic-{token}"
    results.mkdir(mode=0o700)
    print(results, flush=True)

    for database, scale in [(a, "10"), (b, "3")]:
        with (results / f"{database}-init.log").open("wb") as log:
            run(db_command(SOURCE, "pgbench", "-U", database, "-i", "-s", scale, database),
                stdout=log, stderr=subprocess.STDOUT)

    fixture = objects / "synthetic.bin"
    fixture.write_bytes(b"facade-ai-step14\x00" * (2 ** 19))
    checksum = sha256(fixture)
    sql(SOURCE, b, f"""
        CREATE TABLE evidence (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
        INSERT INTO evidence VALUES ('synthetic.bin', '{checksum}');
        CREATE TABLE checkpoints (point TEXT PRIMARY KEY);
        INSERT INTO checkpoints VALUES ('in_backup');
    """, b)
    retained_at = monotonic()
    before_wal = sql(SOURCE, "postgres", "SELECT pg_current_wal_insert_lsn();")
    (results / "source-before.txt").write_text(resources(SOURCE))

    single_name = f"facade-single-{token}"
    single = collect_benchmark(benchmark(a, 6, 12, single_name, results), single_name, results)

    prefix_a = f"facade-dual-a-{token}"
    prefix_b = f"facade-dual-b-{token}"
    dual_a = benchmark(a, 6, 16, prefix_a, results)
    dual_b = benchmark(b, 4, 16, prefix_b, results)
    sleep(2)
    dump = results / "db.dump"
    dump_start = monotonic()
    assert dual_a.poll() is None and dual_b.poll() is None
    with dump.open("wb") as output:
        run(db_command(SOURCE, "pg_dump", "-U", b, "-Fc", "--no-acl", "--no-owner", b), stdout=output)
    fixture_copy = results / fixture.name
    shutil.copyfile(fixture, fixture_copy)
    backup_seconds = monotonic() - dump_start
    assert sha256(fixture_copy) == checksum
    sql(SOURCE, b, "INSERT INTO checkpoints VALUES ('after_backup');", b)
    dual = {
        "a": collect_benchmark(dual_a, prefix_a, results),
        "b": collect_benchmark(dual_b, prefix_b, results),
    }
    wal_bytes = int(sql(SOURCE, "postgres", f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '{before_wal}');"))
    (results / "source-after.txt").write_text(resources(SOURCE))

    fail_start = monotonic()
    sql(SOURCE, "postgres", f'ALTER DATABASE "{b}" ALLOW_CONNECTIONS false;')
    try:
        blocked = subprocess.run(db_command(SOURCE, "psql", "-XAtq", "-U", b, "-d", b, "-c", "SELECT 1;"),
                                 capture_output=True, text=True)
        assert blocked.returncode != 0 and "not currently accepting connections" in blocked.stderr
        detected_at = monotonic()
        recover_start = monotonic()
        run(DOCKER + [
            "run", "-d", "--name", restore, "--network", "none", "--cpuset-cpus", "0-3",
            "--memory", "768m", "--mount", f"source={volume},target=/var/lib/postgresql/data",
            "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_INITDB_ARGS=--data-checksums",
            IMAGE, "postgres", "-c", "listen_addresses=",
        ], stdout=subprocess.DEVNULL)
        deadline = monotonic() + 60
        while monotonic() < deadline:
            probe = subprocess.run(db_command(restore, "psql", "-XAtq", "-U", "postgres", "-d", "postgres",
                                             "-c", "SELECT current_setting('data_checksums');"),
                                   capture_output=True, text=True)
            # Wait for the real postmaster, not the temporary init server.
            if probe.stdout.strip() == "on" and "ready" in run(
                DOCKER + ["logs", restore], capture_output=True, text=True,
            ).stderr.split("PostgreSQL init process complete")[-1] and "ready to accept connections" in run(
                DOCKER + ["logs", restore], capture_output=True, text=True,
            ).stderr.split("database system is shut down")[-1]:
                break
            sleep(0.5)
        else:
            raise RuntimeError("Isolated restore server did not start")
        run(db_command(restore, "createdb", "-U", "postgres", "recovered"))
        with dump.open("rb") as saved:
            run(db_command(restore, "pg_restore", "-U", "postgres", "--no-acl", "--no-owner",
                           "--single-transaction", "--exit-on-error", "-d", "recovered"), stdin=saved)
        sha_in_db = sql(restore, "recovered", "SELECT sha256 FROM evidence WHERE name = 'synthetic.bin';")
        recovered = results / "restored-synthetic.bin"
        shutil.copyfile(fixture_copy, recovered)
        assert sha256(recovered) == sha_in_db == checksum
        assert sql(restore, "recovered", "SELECT point FROM checkpoints ORDER BY point;") == "in_backup"
        sample = sql(restore, "recovered", "SELECT count(*) FROM pgbench_accounts;")
        assert sample == "300000"
        verify_done = monotonic()

        with recovered.open("r+b") as handle:
            handle.write(b"X")
        assert sha256(recovered) != sha_in_db
        (results / "restore-resources.txt").write_text(resources(restore))
        report = {
            "single_database": single, "dual_database_and_backup": dual,
            "cluster_wal_generated_bytes": wal_bytes, "dump_bytes": dump.stat().st_size,
            "dump_sha256": sha256(dump), "fixture_bytes": fixture.stat().st_size, "fixture_sha256": checksum,
            "backup_s": backup_seconds, "diagnostic_rpo_marker_s": fail_start - retained_at,
            "diagnostic_rto_db_and_object_s": verify_done - fail_start,
            "detection_s": detected_at - fail_start, "restore_and_verify_s": verify_done - recover_start,
            "recovered_marker": "in_backup", "post_backup_marker_lost": True,
            "recovered_rows": int(sample), "corruption_detected": True,
        }
        (results / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    finally:
        sql(SOURCE, "postgres", f'ALTER DATABASE "{b}" ALLOW_CONNECTIONS true;')
        subprocess.run(DOCKER + ["rm", "-f", restore], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(DOCKER + ["volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
