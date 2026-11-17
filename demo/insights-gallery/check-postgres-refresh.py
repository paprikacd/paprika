#!/usr/bin/env python3
"""Test append-only demo history in a newly created, network-isolated DB.

Creates and removes exactly its own ephemeral Docker container. It never
connects to a user database and does not print credentials or provider files.
"""
import json
import secrets
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = "paprika-gallery-refresh-test-" + secrets.token_hex(4)

def docker(*args, input=None, check=True):
    return subprocess.run(["docker", *args], input=input, text=True, capture_output=True, check=check)

def sql(statement, *, ok=True):
    result = docker("exec", "-i", NAME, "psql", "-U", "postgres", "-d", "gallery_demo", "-v", "ON_ERROR_STOP=1", "-At", input=statement, check=False)
    if ok and result.returncode:
        raise RuntimeError(result.stderr)
    if not ok and not result.returncode:
        raise AssertionError("Expected the read-only role to be denied")
    return result.stdout.strip()

created = False
try:
    docker("run", "-d", "--rm", "--network", "none", "--name", NAME, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=gallery_demo", "postgres:16-alpine")
    created = True
    for _ in range(90):
        ready = docker("exec", NAME, "psql", "-U", "postgres", "-d", "gallery_demo", "-At", "-c", "SELECT 1", check=False)
        if ready.returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError("Disposable PostgreSQL did not become ready")
    sql((HERE / "seed.sql").read_text() + "\n" + (HERE / "refresh-postgres.sql").read_text())
    sql("CREATE ROLE readonly_test NOLOGIN; GRANT USAGE ON SCHEMA gallery TO readonly_test;")
    sql("SET ROLE readonly_test; SELECT gallery.refresh_synthetic_history(clock_timestamp());", ok=False)
    # Sign only the originally recorded data, using deterministic order; later
    # inserts must not rewrite, remove or duplicate any original sample.
    original = sql("""SELECT json_build_array(
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY service, observed_at)) FROM gallery.service_probe_samples x),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY symbol, observed_at)) FROM gallery.company_history x),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, node, observed_at)) FROM gallery.node_history x),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, source, observed_at)) FROM gallery.edge_source_history x),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, occurred_at)) FROM gallery.edge_blocked_requests x),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, occurred_at)) FROM gallery.edge_events x))::text;""")
    counts_query = """SELECT json_build_array((SELECT count(*) FROM gallery.service_probe_samples),(SELECT count(*) FROM gallery.company_history),(SELECT count(*) FROM gallery.node_history),(SELECT count(*) FROM gallery.edge_source_history),(SELECT count(*) FROM gallery.edge_blocked_requests),(SELECT count(*) FROM gallery.edge_events))::text;"""
    clock_query = "SELECT json_object_agg(name, through_at)::text FROM gallery.synthetic_history_clock;"
    counts, clocks = sql(counts_query), sql(clock_query)
    # An interrupted transaction leaves data and checkpoints untouched.
    sql("BEGIN; SELECT gallery.refresh_synthetic_history(clock_timestamp()+interval '70 minutes'); ROLLBACK;")
    assert sql(counts_query) == counts and json.loads(sql(clock_query)) == json.loads(clocks)
    interrupted = subprocess.Popen(["docker", "exec", "-i", "-e", "PGAPPNAME=paprika-refresh-interruption-test", NAME, "psql", "-U", "postgres", "-d", "gallery_demo", "-v", "ON_ERROR_STOP=1"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        interrupted.stdin.write("BEGIN; SELECT gallery.refresh_synthetic_history(clock_timestamp()+interval '70 minutes'); SELECT pg_sleep(120); COMMIT;\n")
        interrupted.stdin.close()
        for _ in range(80):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='paprika-refresh-interruption-test' AND wait_event='PgSleep';") == "1":
                break
            if interrupted.poll() is not None:
                raise RuntimeError("Refresh transaction exited before interruption")
            time.sleep(.1)
        else:
            raise RuntimeError("Refresh transaction never reached the interruption point")
        assert sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='paprika-refresh-interruption-test';") == "t"
        assert interrupted.wait(timeout=10) != 0
    finally:
        if interrupted.poll() is None:
            interrupted.kill()
            interrupted.wait(timeout=10)
    assert sql(counts_query) == counts and json.loads(sql(clock_query)) == json.loads(clocks)
    as_of = sql("SELECT greatest(max(initial_at),clock_timestamp()) + interval '70 minutes' FROM gallery.synthetic_history_clock;")
    sql("SELECT gallery.refresh_synthetic_history('" + as_of + "'::timestamptz);")
    after, first_clocks = json.loads(sql(counts_query)), json.loads(sql(clock_query))
    assert all(new > old for new, old in zip(after, json.loads(counts)))
    sql("SELECT gallery.refresh_synthetic_history('" + as_of + "'::timestamptz);")
    assert json.loads(sql(counts_query)) == after and json.loads(sql(clock_query)) == first_clocks
    # Concurrent retries are serialized by a transaction-scoped lock. A
    # backwards clock must never move a checkpoint or reinsert observations.
    sql("SELECT gallery.refresh_synthetic_history('" + as_of + "'::timestamptz - interval '1 hour');")
    assert json.loads(sql(counts_query)) == after and json.loads(sql(clock_query)) == first_clocks
    statement = "SELECT gallery.refresh_synthetic_history('" + as_of + "'::timestamptz + interval '10 minutes');"
    workers = [subprocess.Popen(["docker", "exec", NAME, "psql", "-U", "postgres", "-d", "gallery_demo", "-v", "ON_ERROR_STOP=1", "-c", statement], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    for worker in workers:
        assert worker.wait(timeout=30) == 0, worker.stderr.read()
    concurrent_counts, first_clocks = json.loads(sql(counts_query)), json.loads(sql(clock_query))
    sql(statement)
    assert json.loads(sql(counts_query)) == concurrent_counts and json.loads(sql(clock_query)) == first_clocks
    # Every generated time is unique per identity, even after a restart/retry.
    duplicates = sql("""SELECT (SELECT count(*) FROM (SELECT service,observed_at FROM gallery.service_probe_samples GROUP BY 1,2 HAVING count(*)>1) x) +
      (SELECT count(*) FROM (SELECT symbol,observed_at FROM gallery.company_history GROUP BY 1,2 HAVING count(*)>1) x) +
      (SELECT count(*) FROM (SELECT cluster,node,observed_at FROM gallery.node_history GROUP BY 1,2,3 HAVING count(*)>1) x) +
      (SELECT count(*) FROM (SELECT cluster,source,observed_at FROM gallery.edge_source_history GROUP BY 1,2,3 HAVING count(*)>1) x) +
      (SELECT count(*) FROM (SELECT cluster,occurred_at FROM gallery.edge_blocked_requests GROUP BY 1,2 HAVING count(*)>1) x) +
      (SELECT count(*) FROM (SELECT cluster,occurred_at FROM gallery.edge_events GROUP BY 1,2 HAVING count(*)>1) x);""")
    assert duplicates == "0"
    preserved = sql("""SELECT json_build_array(
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY service, observed_at)) FROM gallery.service_probe_samples x WHERE observed_at <= (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='probes')),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY symbol, observed_at)) FROM gallery.company_history x WHERE observed_at <= (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='companies')),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, node, observed_at)) FROM gallery.node_history x WHERE observed_at <= (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='nodes')),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, source, observed_at)) FROM gallery.edge_source_history x WHERE observed_at <= (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='edge')),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, occurred_at)) FROM gallery.edge_blocked_requests x WHERE occurred_at <= (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='edge-blocks')),
      (SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY cluster, occurred_at)) FROM gallery.edge_events x WHERE occurred_at <= (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='edge-events')))::text;""")
    assert json.loads(preserved) == json.loads(original)
    # After a long-running session, both clusters still have actual newly
    # recorded rows in the recent window; the source stays append-only.
    for table in ("edge_blocked_requests", "edge_events"):
        recent = sql("SELECT count(DISTINCT cluster) FROM gallery." + table + " WHERE occurred_at > '" + as_of + "'::timestamptz - interval '30 minutes' AND occurred_at <= '" + as_of + "'::timestamptz;")
        assert recent == "2", f"{table} should have recent events for both clusters"
        assert sql("SELECT count(*) FROM gallery." + table + " WHERE occurred_at > '" + as_of + "'::timestamptz + interval '10 minutes';") == "0", f"{table} must not contain future observations"
    assert sql("""SELECT count(*) FROM gallery.edge_blocked_requests
      WHERE occurred_at > (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='edge-blocks')
      AND (source NOT LIKE '198.51.100.%' OR destination NOT LIKE '192.0.2.%:443' OR status <> 'Blocked' OR count < 0);""") == "0"
    assert sql("""SELECT count(*) FROM gallery.edge_events
      WHERE occurred_at > (SELECT initial_at FROM gallery.synthetic_history_clock WHERE name='edge-events')
      AND (label NOT LIKE 'Synthetic %' OR severity NOT IN ('info','warning'));""") == "0"
    # Catch-up is limited to one day per invocation and continues on retry.
    sql("SELECT gallery.refresh_synthetic_history('" + as_of + "'::timestamptz + interval '80 days');")
    capped = json.loads(sql(clock_query))
    advances = sql("""SELECT bool_and(through_at <= '""" + as_of + """'::timestamptz + interval '1 day 10 minutes') FROM gallery.synthetic_history_clock;""")
    assert advances == "t" and all(capped[key] != first_clocks[key] for key in capped)
    sql("SELECT gallery.refresh_synthetic_history('" + as_of + "'::timestamptz + interval '80 days');")
    assert all(value != capped[key] for key, value in json.loads(sql(clock_query)).items())
    print("PASS isolated PostgreSQL: append, interruption, concurrent retry, no duplicates, unchanged history, bounded catch-up, read-only role")
finally:
    if created:
        docker("stop", NAME, check=False)
