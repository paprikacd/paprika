#!/usr/bin/env python3
"""Start isolated real Prometheus, PostgreSQL and Tempo gallery providers.

All ports bind to loopback, Docker names are unique, and generated credentials
are written only to a mode-0600 file in a mode-0700 local state directory.
Nothing uses or modifies an existing container, database, or cluster.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import secrets
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PROM_IMAGE = "prom/prometheus:v3.5.0"
PG_IMAGE = "postgres:16-alpine"
TEMPO_IMAGE = "grafana/tempo:2.8.2"
EXPORTER_IMAGE = "python:3.12-alpine"
ACTIVE_RESOURCES = None


def cleanup_interrupted(resources):
    """Stop only this interrupted run; preserve its synthetic volume."""
    subprocess.run(["docker", "stop", resources["importer"], *resources["names"].values()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    subprocess.run(["docker", "network", "rm", resources["network"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def run(args, *, data=None, silent=False):
    result = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        # Commands may receive generated passwords, so withhold stdout/stderr.
        raise RuntimeError(f"{args[0]} failed ({result.returncode}); diagnostics withheld")
    return "" if silent else result.stdout.strip()


def wait(check, label, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(.3)
    raise RuntimeError(f"Timed out waiting for {label}")


def port(container, internal):
    output = run(["docker", "port", container, str(internal) + "/tcp"])
    return int(output.rsplit(":", 1)[-1])


def ready(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return response.status == 200


def scrape_ready(port_number):
    with urllib.request.urlopen(f"http://127.0.0.1:{port_number}/api/v1/query?query=up%7Bjob%3D%22paprika-gallery%22%7D", timeout=3) as response:
        payload = json.load(response)
    return any(item.get("value", [None, "0"])[1] == "1" for item in payload.get("data", {}).get("result", []))


def rates_ready(port_number):
    # A long backfill can finish after the five-minute PromQL lookback. Wait
    # for two fresh scrapes so rate() dashboards never start as empty.
    query = "http://127.0.0.1:%d/api/v1/query?query=rate(paprika_demo_requests_total%%5B5m%%5D)" % port_number
    with urllib.request.urlopen(query, timeout=3) as response:
        payload = json.load(response)
    return bool(payload.get("data", {}).get("result", []))


def bootstrap_ready(port_number):
    query = "http://127.0.0.1:%d/api/v1/query?query=paprika_demo_bootstrap_complete" % port_number
    with urllib.request.urlopen(query, timeout=3) as response:
        payload = json.load(response)
    return any(item.get("value", [None, "0"])[1] == "1" for item in payload.get("data", {}).get("result", []))


def prometheus_config(exporter, interval):
    # The configured names are generated locally, never user-supplied URLs.
    return f"global:\n  scrape_interval: {interval}\nscrape_configs:\n  - job_name: paprika-gallery\n    static_configs:\n      - targets: ['{exporter}:8000']\n    metric_relabel_configs:\n      - action: labeldrop\n        regex: 'instance|job'\n"


def reload_prometheus(port_number):
    request = urllib.request.Request(f"http://127.0.0.1:{port_number}/-/reload", data=b"", method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError("Could not restore the normal synthetic scrape interval")


def write_private(path, content):
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)


def traces():
    spec = importlib.util.spec_from_file_location("gallery_trace_patterns", HERE / "trace_patterns.py")
    patterns = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patterns)
    now = time.time_ns()
    resource_spans = []
    for index in range(660):
        service = ["api-gateway", "checkout", "payments", "worker", "catalog", "notifications"][index % 6]
        trace_id = hashlib.md5(f"paprika-gallery-v2-{index}".encode(), usedforsecurity=False).hexdigest()
        start = now - 3_000_000_000 - (index + 1) * 50_000_000
        timings = patterns.trace_timing(index // 6, duration_ms=160 + index * 3)
        ids = [hashlib.sha256(f"v2-{index}-{part}".encode()).hexdigest()[:16] for part in range(4)]
        for part, (span_service, name, offset, length, parent) in enumerate([
            (service, f"GET /{service}", *timings[0], None),
            ("catalog-service", "Lookup products", *timings[1], 0),
            ("payment-service", "Authorize payment", *timings[2], 0),
            ("order-store", "SELECT orders", *timings[3], 1),
        ]):
            attrs = ([{"key": "http.request.method", "value": {"stringValue": "GET"}},
                      {"key": "http.response.status_code", "value": {"intValue": "500" if index % 11 == 0 else "200"}},
                      {"key": "http.flavor", "value": {"stringValue": "2"}}] if part == 0 else
                     [{"key": "db.system.name", "value": {"stringValue": "postgresql"}},
                      {"key": "db.operation.name", "value": {"stringValue": "SELECT"}}] if part == 3 else
                     [{"key": "rpc.system", "value": {"stringValue": "grpc"}},
                      {"key": "rpc.grpc.status_code", "value": {"intValue": "13" if index % 11 == 0 and part == 2 else "0"}}])
            span = {"traceId": trace_id, "spanId": ids[part], "name": name, "kind": 2,
                    "startTimeUnixNano": str(start + offset), "endTimeUnixNano": str(start + offset + length),
                    "attributes": attrs, "status": {"code": 2 if index % 11 == 0 and part in (0, 2) else 1}}
            if parent is not None:
                span["parentSpanId"] = ids[parent]
            resource_spans.append({"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": span_service}},
                                                                  {"key": "cluster", "value": {"stringValue": "omega"}}]},
                                   "scopeSpans": [{"scope": {"name": "paprika.gallery.demo"}, "spans": [span]}]})
    return json.dumps({"resourceSpans": resource_spans}).encode()


def main():
    global ACTIVE_RESOURCES
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, default=None)
    args = parser.parse_args()
    suffix = secrets.token_hex(4)
    state = (args.state_dir or ROOT / "artifacts" / "insights" / f"gallery-live-{suffix}").resolve()
    state.mkdir(mode=0o700, parents=True, exist_ok=False)
    state.chmod(0o700)
    names = {kind: f"paprika-gallery-{kind}-{suffix}" for kind in ("postgres", "prometheus", "tempo", "exporter")}
    volume = f"paprika-gallery-prometheus-{suffix}"
    network = f"paprika-gallery-network-{suffix}"
    importer = f"paprika-gallery-import-{suffix}"
    # Record only resource identities before any Docker mutation, so an
    # interrupted setup can be inspected without exposing credentials.
    write_private(state / "state.json", json.dumps({"names": names, "volume": volume, "network": network, "status": "starting"}, indent=2))
    ACTIVE_RESOURCES = {"names": names, "importer": importer, "network": network}
    print(f"Local state: {state}", flush=True)
    password, reader_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    write_private(state / "postgres.env", f"POSTGRES_USER=postgres\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=gallery_demo\n")
    write_private(state / "tempo.yaml", """server:
  http_listen_port: 3200
query_frontend:
  search:
    max_duration: 744h
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
ingester:
  trace_idle_period: 2s
  max_block_duration: 1m
storage:
  trace:
    backend: local
    wal:
      path: /tmp/tempo/wal
    local:
      path: /tmp/tempo/blocks
""")
    for image in (PG_IMAGE, PROM_IMAGE, TEMPO_IMAGE, EXPORTER_IMAGE):
        subprocess.run(["docker", "image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0 or run(["docker", "pull", image], silent=True)
    run(["docker", "network", "create", network], silent=True)
    print("Starting isolated PostgreSQL and Tempo…", flush=True)
    run(["docker", "run", "-d", "--rm", "--name", names["postgres"], "--env-file", str(state / "postgres.env"), "-p", "127.0.0.1::5432", PG_IMAGE], silent=True)
    # pg_isready can succeed against the temporary init server before the
    # target database exists. Require a successful query against that database.
    wait(lambda: subprocess.run(["docker", "exec", names["postgres"], "sh", "-c", 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d gallery_demo -At -c "SELECT 1"'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, "local PostgreSQL")
    sql = (HERE / "seed.sql").read_text(encoding="utf-8")
    sql += "\n" + (HERE / "refresh-postgres.sql").read_text(encoding="utf-8")
    sql += "\nSELECT gallery.refresh_synthetic_history(clock_timestamp());\n"
    sql += f"\nCREATE ROLE gallery_reader LOGIN PASSWORD '{reader_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\nGRANT USAGE ON SCHEMA gallery TO gallery_reader;\nGRANT SELECT ON ALL TABLES IN SCHEMA gallery TO gallery_reader;\n"
    run(["docker", "exec", "-i", names["postgres"], "psql", "-U", "postgres", "-d", "gallery_demo", "-v", "ON_ERROR_STOP=1"], data=sql, silent=True)
    # The worker runs inside this newly-created disposable container and exits
    # with it. It has no host/database endpoint and cannot attach to an
    # existing deployment. The refresher is append-only and catches up in
    # bounded chunks after pauses; its log is local to the container.
    run(["docker", "exec", "-d", "--user", "postgres", names["postgres"], "sh", "-c", "while :; do psql -U postgres -d gallery_demo -v ON_ERROR_STOP=1 -c 'SELECT gallery.refresh_synthetic_history(clock_timestamp())' >/dev/null 2>/tmp/paprika-synthetic-history-error.log; sleep 60; done"], silent=True)
    pg_port = port(names["postgres"], 5432)
    run(["docker", "run", "-d", "--rm", "--network", network, "--name", names["tempo"], "-p", "127.0.0.1::3200", "-p", "127.0.0.1::4318", "-v", f"{state / 'tempo.yaml'}:/etc/tempo.yaml:ro", TEMPO_IMAGE, "-config.file=/etc/tempo.yaml"], silent=True)
    tempo_port, otlp_port = port(names["tempo"], 3200), port(names["tempo"], 4318)
    wait(lambda: ready(f"http://127.0.0.1:{tempo_port}/ready"), "local Tempo")
    req = urllib.request.Request(f"http://127.0.0.1:{otlp_port}/v1/traces", data=traces(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError("Could not ingest local synthetic traces")
    print("Generating and importing synthetic Prometheus history…", flush=True)
    metrics = state / "metrics.openmetrics"
    run([sys.executable, str(HERE / "generate-metrics.py"), "--out", str(metrics)], silent=True)
    run(["docker", "volume", "create", volume], silent=True)
    run(["docker", "run", "--rm", "--name", importer, "--user", "0:0", "-v", f"{metrics}:/input/metrics.openmetrics:ro", "-v", f"{volume}:/prometheus", "--entrypoint=promtool", PROM_IMAGE, "tsdb", "create-blocks-from", "openmetrics", "--quiet", "/input/metrics.openmetrics", "/prometheus"], silent=True)
    run(["docker", "run", "-d", "--rm", "--network", network, "--name", names["exporter"], "-e", f"PAPRIKA_DEMO_TEMPO=http://{names['tempo']}:4318/v1/traces", "-e", "PAPRIKA_DEMO_BOOTSTRAP=true", "-v", f"{metrics}:/data/metrics.openmetrics:ro", "-v", f"{HERE / 'live-exporter.py'}:/app/live-exporter.py:ro", "-v", f"{HERE / 'live_series.py'}:/app/live_series.py:ro", "-v", f"{HERE / 'sample_clock.py'}:/app/sample_clock.py:ro", "-v", f"{HERE / 'trace_patterns.py'}:/app/trace_patterns.py:ro", EXPORTER_IMAGE, "python", "/app/live-exporter.py"], silent=True)
    config = state / "prometheus.yaml"
    # Drop scraper-added labels so live samples continue the imported series
    # rather than showing duplicate lines for the first five minutes.
    config.write_text(prometheus_config(names["exporter"], "1s"), encoding="utf-8")
    run(["docker", "run", "-d", "--rm", "--network", network, "--user", "0:0", "--name", names["prometheus"], "-p", "127.0.0.1::9090", "-v", f"{volume}:/prometheus", "-v", f"{config}:/etc/prometheus/prometheus.yml:ro", PROM_IMAGE, "--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=35d", "--web.listen-address=0.0.0.0:9090", "--web.enable-lifecycle"], silent=True)
    prom_port = port(names["prometheus"], 9090)
    wait(lambda: ready(f"http://127.0.0.1:{prom_port}/-/ready"), "local Prometheus", 120)
    wait(lambda: scrape_ready(prom_port), "fresh synthetic metrics scrape", 120)
    wait(lambda: bootstrap_ready(prom_port), "synthetic history catch-up", 180)
    config.write_text(prometheus_config(names["exporter"], "1m"), encoding="utf-8")
    reload_prometheus(prom_port)
    wait(lambda: rates_ready(prom_port), "two fresh samples for rate queries", 180)
    providers = [
        {"name": "gallery-prometheus", "type": "prometheus", "config": {"endpoint": f"http://127.0.0.1:{prom_port}"}, "credentials": ""},
        {"name": "gallery-postgresql", "type": "postgresql", "config": {"host": "127.0.0.1", "port": pg_port, "database": "gallery_demo", "sslmode": "disable"}, "credentials": {"username": "gallery_reader", "password": reader_password}},
        {"name": "gallery-tempo", "type": "tempo", "config": {"endpoint": f"http://127.0.0.1:{tempo_port}"}, "credentials": ""},
    ]
    write_private(state / "providers.json", json.dumps(providers))
    write_private(state / "state.json", json.dumps({"names": names, "volume": volume, "network": network, "prometheus": f"http://127.0.0.1:{prom_port}", "postgresPort": pg_port, "tempo": f"http://127.0.0.1:{tempo_port}", "providersFile": str(state / "providers.json")}, indent=2))
    print(f"Ready. Local state: {state}\nProvider definitions: {state / 'providers.json'}\nPrometheus: http://127.0.0.1:{prom_port}\nTempo: http://127.0.0.1:{tempo_port}\nPostgreSQL: 127.0.0.1:{pg_port} (credentials in private provider file)", flush=True)


if __name__ == "__main__":
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except KeyboardInterrupt:
        if ACTIVE_RESOURCES:
            cleanup_interrupted(ACTIVE_RESOURCES)
        print("Gallery setup interrupted; owned containers stopped and synthetic data retained.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        if ACTIVE_RESOURCES:
            cleanup_interrupted(ACTIVE_RESOURCES)
        print(f"Gallery setup failed: {exc}", file=sys.stderr)
        sys.exit(1)
