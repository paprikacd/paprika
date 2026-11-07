import importlib.util
import json
import os
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve().parent


class GallerySeedTest(unittest.TestCase):
    def test_bootstrap_clock_fills_past_minutes_before_resuming_live_scrapes(self):
        spec = importlib.util.spec_from_file_location("sample_clock", HERE / "sample_clock.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        clock = module.SampleClock(120)
        self.assertEqual(clock.next(310), (180, False))
        self.assertEqual(clock.next(311), (240, False))
        self.assertEqual(clock.next(312), (300, False))
        self.assertEqual(clock.next(313), (313, True))
        self.assertEqual(clock.next(314), (314, True))
        empty = module.SampleClock(None)
        self.assertEqual(empty.next(100), (100, True))

    def test_bootstrap_scrape_config_retains_series_identity(self):
        spec = importlib.util.spec_from_file_location("gallery_start", HERE / "start.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fast = module.prometheus_config("gallery-exporter", "1s")
        normal = module.prometheus_config("gallery-exporter", "1m")
        for config in (fast, normal):
            self.assertIn("targets: ['gallery-exporter:8000']", config)
            self.assertIn("regex: 'instance|job'", config)
        self.assertIn("scrape_interval: 1s", fast)
        self.assertIn("scrape_interval: 1m", normal)

    def test_cancelled_start_stops_only_its_owned_resources_and_keeps_data(self):
        spec = importlib.util.spec_from_file_location("gallery_start", HERE / "start.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        resources = {"names": {"postgres": "p-owned", "prometheus": "m-owned", "tempo": "t-owned", "exporter": "e-owned"}, "importer": "import-owned", "network": "network-owned"}
        with patch.object(module.subprocess, "run") as run:
            module.cleanup_interrupted(resources)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0], ["docker", "stop", "import-owned", "p-owned", "m-owned", "t-owned", "e-owned"])
        self.assertEqual(commands[1], ["docker", "network", "rm", "network-owned"])
        self.assertFalse(any("volume" in command for command in commands), "Cancellation must retain generated data")

    def test_sigterm_during_start_cleans_up_owned_resources(self):
        # Exercise the real signal path with a fake Docker executable: this
        # never touches any actual containers, networks, volumes or secrets.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker, calls, state = root / "docker", root / "calls", root / "state"
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$PAPRIKA_FAKE_DOCKER_LOG"\nif [ "$1" = image ]; then exec sleep 60; fi\nexit 0\n', encoding="utf-8")
            docker.chmod(0o755)
            env = {**os.environ, "PATH": f"{root}{os.pathsep}{os.environ.get('PATH', '')}", "PAPRIKA_FAKE_DOCKER_LOG": str(calls)}
            process = subprocess.Popen([sys.executable, str(HERE / "start.py"), "--state-dir", str(state)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not (calls.exists() and "image inspect" in calls.read_text()):
                    if process.poll() is not None:
                        self.fail("Startup exited before the test reached its interrupt point")
                    time.sleep(.05)
                self.assertTrue(calls.exists(), "Startup must reach its owned Docker process")
                process.send_signal(signal.SIGTERM)
                _, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 130)
                self.assertIn("owned containers stopped", stderr)
                recorded = json.loads((state / "state.json").read_text())
                commands = calls.read_text().splitlines()
                stop = next(line for line in commands if line.startswith("stop "))
                network = next(line for line in commands if line.startswith("network rm "))
                self.assertTrue(all(name in stop for name in recorded["names"].values()))
                self.assertIn(recorded["network"], network)
                self.assertFalse(any(line.startswith("volume rm ") for line in commands))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_metric_history_is_labeled_ordered_and_histograms_are_cumulative(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.openmetrics"
            subprocess.run([sys.executable, str(HERE / "generate-metrics.py"), "--out", str(path), "--end", "1793254800"], check=True)
            keys, observed, previous, histogram_count = set(), {}, {}, None
            boundary_spellings = set()
            request_times, probe_times, probe_down = [], [], 0
            job_values, job_keys, job_times = set(), set(), []
            node_state_values, node_state_keys, node_missing_times = set(), set(), []
            pipeline_previous, pipeline_tails, rejection_tails = {}, {}, {}
            network_points = {}
            with path.open(encoding="utf-8") as stream:
                for line in stream:
                    if line.startswith("#"):
                        continue
                    key, value, timestamp = line.rsplit(" ", 2)
                    value, timestamp = float(value), int(timestamp)
                    if key.startswith("paprika_demo_network_mbps"):
                        network_points.setdefault(key, []).append((timestamp, value))
                    if key.startswith("paprika_demo_node_cpu_ratio") and 'cluster="omega"' in key:
                        keys.add(key)
                    if key.startswith("paprika_demo_node_condition_state"):
                        node_state_values.add(value)
                        node_state_keys.add(key)
                        if 'cluster="omega"' in key and 'node="node-06"' in key:
                            node_missing_times.append(timestamp)
                    if key.startswith("paprika_demo_market_companies"):
                        self.assertEqual(value, 16)
                    if key.startswith("paprika_demo_job_execution_state"):
                        self.assertNotIn('job="', key, "Prometheus scrape labels must not rewrite a synthetic identity")
                        job_values.add(value)
                        job_keys.add(key)
                        if 'cluster="omega"' in key and 'task="route-data"' in key:
                            job_times.append(timestamp)
                    if key.startswith("paprika_demo_probe_up") and 'cluster="omega"' in key and 'service="checkout"' in key:
                        probe_times.append(timestamp)
                        probe_down += value == 0
                    if key.startswith("paprika_demo_requests_total") and 'cluster="omega"' in key and 'service="checkout"' in key and 'code="5xx"' in key:
                        request_times.append(timestamp)
                    if key.startswith("paprika_demo_requests_total"):
                        self.assertGreaterEqual(value, previous.get(key, value))
                        previous[key] = value
                    if key.startswith("paprika_demo_pipeline_items_total"):
                        self.assertGreaterEqual(value, pipeline_previous.get(key, value), "Synthetic pipeline counters must never reset")
                        pipeline_previous[key] = value
                        pipeline_tails[key] = (pipeline_tails.get(key, []) + [(timestamp, value)])[-2:]
                    if key.startswith("paprika_demo_pipeline_rejected_total"):
                        rejection_tails[key] = (rejection_tails.get(key, []) + [(timestamp, value)])[-2:]
                    if key.startswith("paprika_demo_request_duration_seconds_bucket") and 'cluster="omega"' in key and 'service="checkout"' in key:
                        boundary_spellings.add(key.split('le="', 1)[1].split('"', 1)[0])
                        if timestamp == 1793254740:
                            bound = key.split('le="', 1)[1].split('"', 1)[0]
                            observed[float("inf") if bound == "+Inf" else float(bound)] = value
                    if key.startswith("paprika_demo_request_duration_seconds_count") and 'cluster="omega"' in key and 'service="checkout"' in key and timestamp == 1793254740:
                        histogram_count = value
            self.assertEqual(len(keys), 8)
            self.assertEqual(len(network_points), 4)
            network_spec = importlib.util.spec_from_file_location("network_series", HERE / "live_series.py")
            network_module = importlib.util.module_from_spec(network_spec)
            network_spec.loader.exec_module(network_module)
            for key, points in network_points.items():
                cluster_index = 1 if 'cluster="delta"' in key else 0
                direction = "outbound" if 'direction="outbound"' in key else "inbound"
                self.assertEqual(len(points), 361)
                for index in (0, 60, 360):
                    self.assertAlmostEqual(points[index][1], network_module.network_value(index, cluster_index, direction), delta=.00001)
                self.assertEqual(network_module.continued_value(key, points[-1], points[-2], points[-1][0]), points[-1][1])
            self.assertEqual(len(job_keys), 12)
            self.assertEqual(len(node_state_keys), 16)
            self.assertEqual(node_state_values, {0, 1, 2})
            self.assertTrue(any(b - a > 5 * 60 for a, b in zip(node_missing_times, node_missing_times[1:])), "Node-condition gaps must remain missing")
            self.assertEqual(len(pipeline_tails), 24)
            for cluster in ("omega", "delta"):
                totals = {}
                for signal in ("metrics", "traces", "logs"):
                    pairs = [pair for key, pair in pipeline_tails.items() if f'cluster="{cluster}"' in key and f'signal="{signal}"' in key]
                    self.assertEqual(len(pairs), 4)
                    totals[signal] = sum((tail[1][1] - tail[0][1]) / (tail[1][0] - tail[0][0]) for tail in pairs)
                self.assertGreater(totals["metrics"], totals["traces"])
                self.assertGreater(totals["traces"], totals["logs"])
                self.assertGreater(totals["metrics"], 50_000)
                rejected = sum((tail[1][1] - tail[0][1]) / (tail[1][0] - tail[0][0]) for key, tail in rejection_tails.items() if f'cluster="{cluster}"' in key)
                rejection_percent = 100 * rejected / sum(totals.values())
                self.assertGreater(rejection_percent, .01)
                self.assertLess(rejection_percent, .1)
            self.assertEqual(job_values, {0, 1, 2})
            self.assertTrue(any(b - a > 5 * 60 for a, b in zip(job_times, job_times[1:])), "Missing samples must remain missing")
            self.assertGreaterEqual(max(request_times) - min(request_times), 30 * 86400)
            self.assertGreaterEqual(max(probe_times) - min(probe_times), 30 * 86400)
            self.assertGreater(probe_down, 0)
            self.assertLess(probe_down / len(probe_times), .001)
            self.assertEqual(len(observed), 7)
            self.assertIn("1.0", boundary_spellings)
            self.assertNotIn("1", boundary_spellings)
            values = [observed[key] for key in sorted(observed)]
            self.assertEqual(values, sorted(values))
            self.assertEqual(values[-1], histogram_count)

    def test_request_error_history_has_recorded_incident_peaks_and_positive_baseline(self):
        spec = importlib.util.spec_from_file_location("gallery_metrics", HERE / "generate-metrics.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        end = 1_793_254_800
        for service in range(6):
            for center in (120 + service * 2, 420 + service * 3):
                midpoint = module.error_activity(end - center * 3600, end, service)
                before = module.error_activity(end - (center + 6) * 3600, end, service)
                after = module.error_activity(end - (center - 6) * 3600, end, service)
                self.assertGreater(midpoint, 3.5)
                self.assertGreater(midpoint, max(before, after) + 2)
            for age in range(0, 31 * 24, 3):
                self.assertGreater(module.error_activity(end - age * 3600, end, service), 0)

    def test_live_job_states_continue_the_recorded_cycle(self):
        spec = importlib.util.spec_from_file_location("live_series", HERE / "live_series.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for cluster_index, cluster in enumerate(("omega", "delta")):
            for index, job in enumerate(("scrape-metrics", "collect-traces", "ingest-logs", "enrich-events", "route-data", "write-storage")):
                key = f'paprika_demo_job_execution_state{{cluster="{cluster}",task="{job}"}}'
                phase = (360 // 5 + index * 7 + cluster_index * 11) % 59
                last = 0 if phase in (17, 18) else 1 if phase in (3, 4, 38) else 2
                self.assertEqual(module.continued_value(key, (100, last), None, 100), last)
                self.assertEqual({module.continued_value(key, (100, last), None, 100 + minute * 60) for minute in range(300)}, {0, 1, 2})

    def test_live_node_conditions_continue_the_recorded_cycle(self):
        spec = importlib.util.spec_from_file_location("live_series", HERE / "live_series.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for cluster_index, cluster in enumerate(("omega", "delta")):
            for index in range(8):
                key = f'paprika_demo_node_condition_state{{cluster="{cluster}",node="node-{index + 1:02}"}}'
                last = module.node_condition(index, cluster_index, 360)
                self.assertEqual(module.continued_value(key, (100, last), None, 100), last)
                self.assertEqual({module.continued_value(key, (100, last), None, 100 + minute * 60) for minute in range(540)}, {0, 1, 2})

    def test_network_history_and_live_continuation_share_a_bounded_jagged_signal(self):
        spec = importlib.util.spec_from_file_location("live_series", HERE / "live_series.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        paths = []
        for cluster_index, cluster in enumerate(("omega", "delta")):
            for direction in ("inbound", "outbound"):
                key = f'paprika_demo_network_mbps{{cluster="{cluster}",direction="{direction}"}}'
                historical = [module.network_value(minute, cluster_index, direction) for minute in range(361)]
                anchor = (1_793_254_740, historical[-1])
                self.assertEqual(module.continued_value(key, anchor, None, anchor[0]), historical[-1])
                live = [module.continued_value(key, anchor, None, anchor[0] + minute * 60) for minute in range(61)]
                for minute, value in enumerate(live):
                    self.assertAlmostEqual(value, module.network_value(360 + minute, cluster_index, direction), delta=1e-9)
                self.assertEqual(live, [module.continued_value(key, anchor, None, anchor[0] + minute * 60) for minute in range(61)], "Restarting does not change the signal")
                self.assertTrue(all(0 < value < 1500 for value in historical + live))
                self.assertGreater(max(live) - min(live), (842 if direction == "inbound" else 218) * .15)
                turns = sum((live[i] - live[i - 1]) * (live[i + 1] - live[i]) < 0 for i in range(1, 60))
                self.assertGreater(turns, 10, "Traffic should have minute-scale variation, not just a slow sine wave")
                near_boundary = module.continued_value(key, anchor, None, anchor[0] + .001)
                self.assertAlmostEqual(near_boundary, historical[-1], delta=.01)
                paths.append(live)
        self.assertEqual(len({tuple(path) for path in paths}), 4)

    def test_synthetic_traces_have_real_otlp_ids_times_and_service_labels(self):
        spec = importlib.util.spec_from_file_location("gallery_start", HERE / "start.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data = json.loads(module.traces())
        self.assertEqual(len(data["resourceSpans"]), 660 * 4)
        traces = {}
        shapes = set()
        for resource in data["resourceSpans"]:
            span = resource["scopeSpans"][0]["spans"][0]
            self.assertEqual(len(span["traceId"]), 32)
            self.assertLess(int(span["startTimeUnixNano"]), int(span["endTimeUnixNano"]))
            self.assertTrue(any(attribute["key"] == "service.name" for attribute in resource["resource"]["attributes"]))
            traces.setdefault(span["traceId"], []).append(span)
        for spans in traces.values():
            self.assertEqual(len(spans), 4)
            root = next(span for span in spans if "parentSpanId" not in span)
            root_start = int(root["startTimeUnixNano"])
            root_end = int(root["endTimeUnixNano"])
            shapes.add(tuple((span["name"], int(span["startTimeUnixNano"]) - root_start, int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])) for span in spans if span.get("parentSpanId")))
            ids = {span["spanId"] for span in spans}
            self.assertEqual(len(ids), 4)
            self.assertEqual(sum(span.get("parentSpanId") == root["spanId"] for span in spans), 2)
            self.assertTrue(all(span.get("parentSpanId") in ids for span in spans if "parentSpanId" in span))
            by_id = {span["spanId"]: span for span in spans}
            for span in spans:
                self.assertLessEqual(root_start, int(span["startTimeUnixNano"]))
                self.assertLessEqual(int(span["endTimeUnixNano"]), root_end)
                if span.get("parentSpanId"):
                    parent = by_id[span["parentSpanId"]]
                    self.assertLessEqual(int(parent["startTimeUnixNano"]), int(span["startTimeUnixNano"]))
                    self.assertLessEqual(int(span["endTimeUnixNano"]), int(parent["endTimeUnixNano"]))
            root_attrs = {entry["key"]: entry["value"] for entry in root["attributes"]}
            self.assertEqual(root_attrs["http.request.method"]["stringValue"], "GET")
            self.assertEqual(root_attrs["http.flavor"]["stringValue"], "2")
            self.assertEqual(root_attrs["http.response.status_code"]["intValue"] == "500", root["status"]["code"] == 2)
            rpc = next(span for span in spans if span["name"] == "Lookup products")
            rpc_attrs = {entry["key"]: entry["value"] for entry in rpc["attributes"]}
            self.assertEqual(rpc_attrs["rpc.grpc.status_code"]["intValue"], "0")
            store = next(span for span in spans if span["name"] == "SELECT orders")
            store_attrs = {entry["key"]: entry["value"] for entry in store["attributes"]}
            self.assertEqual(store_attrs["db.system.name"]["stringValue"], "postgresql")
        self.assertGreaterEqual(len(shapes), 6, "Bootstrap traces should exhibit varied duration and child timing")

    def test_geo_migration_is_additive_and_scoped_to_geo_table(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "state.json").write_text(json.dumps({"names": {"postgres": "paprika-gallery-postgres-01234567"}}), encoding="utf-8")
            with patch.object(sys, "argv", ["seed-geo-existing.py", str(state)]), patch("subprocess.run") as run:
                runpy.run_path(str(HERE / "seed-geo-existing.py"), run_name="__main__")
            sql = run.call_args.kwargs["input"]
            self.assertIn("CREATE TABLE IF NOT EXISTS gallery.geo_events", sql)
            self.assertEqual(sql.count("NOT EXISTS (SELECT 1 FROM gallery.geo_events)"), 2)
            self.assertNotIn("gallery.edge_destinations", sql)
            self.assertNotIn("gallery.stress_observations", sql)

    def test_live_trace_batch_sustains_unique_recent_spans_per_service(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
        requests = []
        fixed_time = 1_793_254_800_000_000_000
        with tempfile.TemporaryDirectory() as directory:
            empty_metrics = Path(directory) / "empty.openmetrics"
            empty_metrics.write_text("# EOF\n", encoding="utf-8")
            spec = importlib.util.spec_from_file_location("gallery_live_exporter", HERE / "live-exporter.py")
            module = importlib.util.module_from_spec(spec)
            sys.path.insert(0, str(HERE))
            try:
                with patch.dict("os.environ", {"PAPRIKA_DEMO_METRICS": str(empty_metrics), "PAPRIKA_DEMO_TEMPO": "http://127.0.0.1:1/v1/traces"}):
                    spec.loader.exec_module(module)
                with patch.object(module.time, "time_ns", return_value=fixed_time), patch.object(module.time, "sleep", side_effect=StopIteration), patch.object(module.urllib.request, "urlopen", side_effect=lambda req, **_: requests.append(req) or Response()):
                    with self.assertRaises(StopIteration): module.emit_traces()
            finally:
                sys.path.remove(str(HERE))
        data = json.loads(requests[0].data)
        roots, trace_spans = {}, {}
        for resource in data["resourceSpans"]:
            span = resource["scopeSpans"][0]["spans"][0]
            labels = {item["key"]: item["value"]["stringValue"] for item in resource["resource"]["attributes"]}
            trace_spans.setdefault(span["traceId"], []).append((labels, span))
            if "parentSpanId" in span: continue
            roots.setdefault((labels["cluster"], labels["service.name"]), []).append(span)
            self.assertGreaterEqual(int(span["startTimeUnixNano"]), fixed_time - 60_000_000_000)
            self.assertLessEqual(int(span["endTimeUnixNano"]), fixed_time)
        self.assertEqual(len(roots), 12)
        for spans in roots.values():
            self.assertEqual(len(spans), 6)
            self.assertEqual(len({span["traceId"] for span in spans}), 6)
            durations = [int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"]) for span in spans]
            self.assertIn(200_000_000, durations, "Each service and cluster retains the canonical 200ms fixture")
            self.assertGreaterEqual(len(set(durations)), 5, "Live traces should have meaningfully varied duration")
            self.assertEqual(sum(span["status"]["code"] == 2 for span in spans), 1)
            for span in spans:
                http_status = next(item["value"]["intValue"] for item in span["attributes"] if item["key"] == "http.response.status_code")
                self.assertEqual(http_status == "500", span["status"]["code"] == 2)
        self.assertEqual(len(trace_spans), 72)
        for spans in trace_spans.values():
            self.assertEqual(len(spans), 4)
            self.assertEqual(len({labels["cluster"] for labels, _ in spans}), 1)
            root = next(span for _, span in spans if "parentSpanId" not in span)
            by_id = {span["spanId"]: span for _, span in spans}
            for _, span in spans:
                if span.get("parentSpanId"):
                    parent = by_id[span["parentSpanId"]]
                    self.assertLessEqual(int(parent["startTimeUnixNano"]), int(span["startTimeUnixNano"]))
                    self.assertLessEqual(int(span["endTimeUnixNano"]), int(parent["endTimeUnixNano"]))
            error_children = [span for _, span in spans if "parentSpanId" in span and span["status"]["code"] == 2]
            self.assertEqual(bool(error_children), root["status"]["code"] == 2)
        self.assertEqual(len(data["resourceSpans"]), 2 * 6 * 6 * 4)

    def test_live_series_vary_without_resetting_counters_or_histograms(self):
        spec = importlib.util.spec_from_file_location("live_series", HERE / "live_series.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # The same activity clock drives each cumulative bucket, so the
        # inequalities remain true at every scrape even when rates change.
        keys = [f'paprika_demo_request_duration_seconds_bucket{{le="{bound}"}}' for bound in ("0.1", "0.5", "+Inf")]
        values = [[module.continued_value(key, (100, last), (40, prev), 100 + elapsed) for key, last, prev in zip(keys, [500, 800, 1000], [470, 750, 940])] for elapsed in (0, 60, 300, 900, 1800)]
        for row in values:
            self.assertEqual(row, sorted(row))
        for index in range(len(keys)):
            self.assertEqual([row[index] for row in values], sorted(row[index] for row in values))
        rates = [(values[i + 1][2] - values[i][2]) / (end - start) for i, (start, end) in enumerate(zip((0, 60, 300, 900), (60, 300, 900, 1800)))]
        self.assertGreater(max(rates) - min(rates), .01)
        request_keys = ['paprika_demo_requests_total{service="checkout",code="2xx"}', 'paprika_demo_requests_total{service="checkout",code="5xx"}']
        rates = [[(module.continued_value(key, (100, 1000), (40, 940), 100 + end) - module.continued_value(key, (100, 1000), (40, 940), 100 + start)) / (end - start) for key in request_keys] for start, end in ((0, 60), (300, 360))]
        self.assertGreater(abs(rates[0][1] / rates[0][0] - rates[1][1] / rates[1][0]), .001)
        # Live pipeline series all start at their backfilled values and share
        # a smooth clock, preserving the relative signal rates across scrapes.
        pipeline_keys = [f'paprika_demo_pipeline_items_total{{signal="{signal}"}}' for signal in ("metrics", "traces", "logs")]
        slopes = (125_000, 61_000, 39_000)
        for key, slope in zip(pipeline_keys, slopes):
            last, previous = (100, 1_000_000_000), (40, 1_000_000_000 - slope * 60)
            self.assertEqual(module.continued_value(key, last, previous, 100), last[1])
            initial_rate = module.continued_value(key, last, previous, 101) - last[1]
            self.assertAlmostEqual(initial_rate / slope, 1, delta=.002)
            samples = [module.continued_value(key, last, previous, 100 + elapsed) for elapsed in (0, 60, 300, 900)]
            self.assertEqual(samples, sorted(samples))
        key = 'paprika_demo_node_cpu_ratio{node="node-01"}'
        first = module.continued_value(key, (100, .5), (40, .45), 100)
        samples = [module.continued_value(key, (100, .5), (40, .45), 100 + elapsed) for elapsed in (60, 300, 900)]
        self.assertEqual(first, .5)
        self.assertTrue(all(0 <= sample <= 1 for sample in samples))
        self.assertTrue(any(abs(sample - first) > .001 for sample in samples))

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.openmetrics"
            subprocess.run([sys.executable, str(HERE / "generate-metrics.py"), "--out", str(path), "--end", "1793254800"], check=True)
            pairs = {}
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.startswith("paprika_demo_request_duration_seconds_"):
                    continue
                key, number, stamp = line.rsplit(" ", 2)
                if 'cluster="omega"' not in key or 'service="checkout"' not in key:
                    continue
                if int(stamp) in (1793254680, 1793254740):
                    pairs.setdefault(key, []).append((int(stamp), float(number)))
            buckets = [(float("inf") if 'le="+Inf"' in key else float(key.split('le="', 1)[1].split('"', 1)[0]), key, pair) for key, pair in pairs.items() if "_bucket{" in key]
            buckets.sort()
            self.assertEqual(len(buckets), 7)
            for elapsed in (0, 60, 300, 900, 1800):
                observations = [module.continued_value(key, pair[1], pair[0], 1793254740 + elapsed) for _, key, pair in buckets]
                self.assertEqual(observations, sorted(observations))
                count_key = next(key for key in pairs if "_count{" in key)
                pair = pairs[count_key]
                count = module.continued_value(count_key, pair[1], pair[0], 1793254740 + elapsed)
                self.assertEqual(observations[-1], count)


if __name__ == "__main__":
    unittest.main()
