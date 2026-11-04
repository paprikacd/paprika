#!/usr/bin/env python3
"""Keep a synthetic backfill fresh, without touching real providers."""
import hashlib
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from live_series import continued_value
from sample_clock import SampleClock
from trace_patterns import trace_timing

DATA = os.environ.get("PAPRIKA_DEMO_METRICS", "/data/metrics.openmetrics")
TEMPO = os.environ.get("PAPRIKA_DEMO_TEMPO")
series = {}
types = []
with open(DATA, encoding="utf-8") as f:
    for line in f:
        if line.startswith("# TYPE"):
            # Prometheus text exposition expects counter TYPE on its _total
            # sample, while OpenMetrics backfill declares the base name.
            fields = line.split()
            types.append(f"# TYPE {fields[2]}_total counter\n" if fields[3] == "counter" else line)
        elif not line.startswith("#") and line.strip():
            key, value, timestamp = line.rsplit(" ", 2)
            old = series.get(key)
            current = (float(timestamp), float(value))
            if old is None or current[0] > old[0][0]:
                series[key] = (current, old[0] if old else None)

# Bootstrap advances through genuine synthetic observations while Prometheus
# temporarily scrapes at 1s. Once caught up, ordinary scrapes carry no explicit
# timestamp and Prometheus assigns its own time. This applies only to the
# isolated gallery stack; the data is never taken from a real provider.
bootstrap = os.environ.get("PAPRIKA_DEMO_BOOTSTRAP") == "true"
clock = SampleClock(max((last[0] for last, _ in series.values()), default=None))
clock_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_error(404)
            return
        with clock_lock:
            now = time.time()
            was_complete = clock.complete
            timestamp, complete = clock.next(now) if bootstrap else (now, True)
            # The scrape that reaches the present still uses its precise
            # sample time; later scrapes use Prometheus's scrape timestamp.
            explicit_timestamp = bootstrap and not was_complete
            output = list(types)
            for key, (last, prev) in series.items():
                value = continued_value(key, last, prev, timestamp)
                suffix = f" {int(timestamp * 1000)}" if explicit_timestamp else ""
                output.append(f"{key} {value:.12g}{suffix}\n")
            output.append(f"# TYPE paprika_demo_bootstrap_complete gauge\npaprika_demo_bootstrap_complete {int(complete)}\n")
        body = "".join(output).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def emit_traces():
    if not TEMPO:
        return
    services = ["api-gateway", "checkout", "payments", "worker", "catalog", "notifications"]
    while True:
        now = time.time_ns()
        spans = []
        # Each cluster receives six traces per service each minute. One of
        # those traces has a failed root and downstream call, so error views
        # remain meaningful after the initial burst ages out.
        for i in range(len(services) * 6 * 2):
            service = services[i % len(services)]
            cluster = ("omega", "delta")[i // (len(services) * 6)]
            sample = (i // len(services)) % 6
            failed = sample == 5
            trace = hashlib.md5(f"{now}-{i}".encode(), usedforsecurity=False).hexdigest()
            ids = [hashlib.sha256(f"{now}-{i}-{part}".encode()).hexdigest()[:16] for part in range(4)]
            start = now - 1_000_000_000 - sample * 10_000_000_000 - (i % len(services)) * 100_000_000
            timings = trace_timing(sample)
            for part, (child_service, name, offset, length, parent) in enumerate([
                (service, f"GET /{service}", *timings[0], None),
                ("catalog-service", "Lookup products", *timings[1], 0),
                ("payment-service", "Authorize payment", *timings[2], 0),
                ("order-store", "SELECT orders", *timings[3], 1),
            ]):
                attributes = ([{"key": "http.request.method", "value": {"stringValue": "GET"}},
                               {"key": "http.response.status_code", "value": {"intValue": "500" if failed else "200"}},
                               {"key": "http.flavor", "value": {"stringValue": "2"}}] if part == 0 else
                              [{"key": "db.system.name", "value": {"stringValue": "postgresql"}},
                               {"key": "db.operation.name", "value": {"stringValue": "SELECT"}}] if part == 3 else
                              [{"key": "rpc.system", "value": {"stringValue": "grpc"}},
                               {"key": "rpc.grpc.status_code", "value": {"intValue": "13" if failed and part == 2 else "0"}}])
                span = {"traceId": trace, "spanId": ids[part], "name": name, "kind": 2,
                        "startTimeUnixNano": str(start + offset), "endTimeUnixNano": str(start + offset + length),
                        "attributes": attributes, "status": {"code": 2 if failed and part in (0, 2) else 1}}
                if parent is not None:
                    span["parentSpanId"] = ids[parent]
                spans.append({"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": child_service}}, {"key": "cluster", "value": {"stringValue": cluster}}]},
                              "scopeSpans": [{"scope": {"name": "paprika.gallery.demo"}, "spans": [span]}]})
        req = urllib.request.Request(TEMPO, data=json.dumps({"resourceSpans": spans}).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5):
                pass
        except OSError:
            pass
        time.sleep(60)


if __name__ == "__main__":
    threading.Thread(target=emit_traces, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
