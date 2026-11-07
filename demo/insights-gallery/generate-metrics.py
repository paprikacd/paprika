#!/usr/bin/env python3
"""Generate reproducible synthetic OpenMetrics history for a local gallery.

The timestamps end one minute before generation, with minute samples over six
hours and five-minute samples over 31 days for the small uptime history.
No production data, external endpoints, or credentials are used.
"""
import argparse
import math
import time
from pathlib import Path
from live_series import network_value, node_condition


def labels(values):
    return "{" + ",".join(f'{k}="{v}"' for k, v in values.items()) + "}"


def error_activity(stamp, end, service_index):
    """Independent synthetic error intensity with two recorded incidents.

    The two 9-hour triangular incidents match seed.sql's reliability events.
    The slowly changing baseline makes 1h and 6h rates meaningfully different
    while all request counters remain monotonic.
    """
    age_hours = (end - stamp) / 3600
    baseline = 1 + .32 * math.sin(age_hours / 3.7 + service_index) + .15 * math.sin(age_hours / 13 + service_index * .4)
    incident = sum(3.4 * max(0, 1 - abs(age_hours - center) / 4.5) for center in (120 + service_index * 2, 420 + service_index * 3))
    return baseline + incident


def pipeline_rate(signal_index, pipeline_index, cluster_index, sample_index):
    """Synthetic per-pipeline observation rates, with distinct signal volumes.

    The four pipeline shares sum to one. These are deliberately synthetic
    counters, not measurements of a real pipeline; rate() derives the displayed
    throughput from their monotonic histories.
    """
    signal_rates = (125_000, 39_000, 61_000)  # metrics, logs, traces
    shares = (.19, .23, .27, .31)
    phase = signal_index * 1.7 + cluster_index * .6
    activity = 1 + .09 * math.sin(sample_index / 29 + phase) + .04 * math.sin(sample_index / 7 + phase * 1.3)
    return signal_rates[signal_index] * shares[pipeline_index] * (1 if cluster_index == 0 else .74) * activity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--end", type=int, default=None, help="Last Unix-second boundary; defaults to the current minute")
    args = parser.parse_args()
    end = (args.end or int(time.time())) // 60 * 60 - 60
    count = 361
    services = ["api-gateway", "checkout", "payments", "worker", "catalog", "notifications"]
    clusters = ["omega", "delta"]
    nodes = [f"node-{index:02}" for index in range(1, 9)]
    timestamps = [end - (count - 1 - n) * 60 for n in range(count)]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        def metric(name, kind, series):
            f.write(f"# TYPE {name} {kind}\n")
            for sample_name, tags, points in series:
                tag = labels(tags)
                for timestamp, value in points:
                    f.write(f"{sample_name}{tag} {value:.8g} {timestamp}\n")

        requests, latency, cpu, memory, disk, disk_total, status, probes, monitors, node_states = [], [], [], [], [], [], [], [], [], []
        for c, cluster in enumerate(clusters):
            for i, service in enumerate(services):
                base = 14 + 5 * i + c * 4
                for code, factor in [("2xx", .9718), ("4xx", .027), ("5xx", .0012)]:
                    total = 1000.0
                    points = []
                    # Five-minute samples cover the 30-day burn-rate view;
                    # the final six hours retain the high-resolution history.
                    for n, stamp in enumerate(range(end - 31 * 86400, timestamps[0], 300)):
                        intensity = error_activity(stamp, end, i) if code == "5xx" else 1
                        total += base * factor * (1 + .15 * math.sin(n / 35 + i)) * intensity * 300
                        points.append((stamp, total))
                    for n, stamp in enumerate(timestamps):
                        wave = 1 + .24 * math.sin(n / 31 + i) + .07 * math.sin(n / 4 + c)
                        intensity = error_activity(stamp, end, i) if code == "5xx" else 1
                        spike = 5 if code == "5xx" and 195 <= n <= 210 and i in (0, 2) else 1
                        total += base * factor * wave * intensity * spike * 60
                        points.append((stamp, total))
                    requests.append(("paprika_demo_requests_total", {"cluster": cluster, "service": service, "code": code}, points))
                # Prometheus canonicalizes OpenMetrics integer histogram bounds
                # to a decimal label during backfill. Scrape the same spelling
                # so rate() cannot see two overlapping 1-second buckets.
                buckets = [(.025, .06), (.05, .18), (.1, .39), (.25, .74), (.5, .91), (1.0, .985), ("+Inf", 1)]
                count_points = []
                for bound, fraction in buckets:
                    total = 0.0
                    points = []
                    for n, stamp in enumerate(timestamps):
                        wave = 1 + .24 * math.sin(n / 31 + i) + .07 * math.sin(n / 4 + c)
                        # Every bucket increases monotonically and remains cumulative.
                        shape = (1 + .22 * math.sin(n / 29 + i)) * (1.55 if 195 <= n <= 210 and i in (0, 2) else 1)
                        total += base * wave * 60 * fraction ** shape
                        points.append((stamp, total))
                    latency.append(("paprika_demo_request_duration_seconds_bucket", {"cluster": cluster, "service": service, "le": str(bound)}, points))
                    if bound == "+Inf":
                        count_points = points
                latency.append(("paprika_demo_request_duration_seconds_count", {"cluster": cluster, "service": service}, count_points))
                duration_total, sum_points = 0.0, []
                midpoints = [.0125, .0375, .075, .175, .375, .75, 1.25]
                for n, stamp in enumerate(timestamps):
                    wave = 1 + .24 * math.sin(n / 31 + i) + .07 * math.sin(n / 4 + c)
                    shape = (1 + .22 * math.sin(n / 29 + i)) * (1.55 if 195 <= n <= 210 and i in (0, 2) else 1)
                    fractions = [fraction ** shape for _, fraction in buckets]
                    average = sum((fraction - (fractions[j - 1] if j else 0)) * midpoints[j] for j, fraction in enumerate(fractions))
                    duration_total += base * wave * 60 * average
                    sum_points.append((stamp, duration_total))
                latency.append(("paprika_demo_request_duration_seconds_sum", {"cluster": cluster, "service": service}, sum_points))
                points = [(stamp, 0 if (i == 2 and 195 <= n <= 208) or (i == 4 and 301 <= n <= 308) else 1) for n, stamp in enumerate(timestamps)]
                status.append(("paprika_demo_service_up", {"cluster": cluster, "service": service}, points))
                history = [(stamp, 0 if (n + i * 61 + c * 17) % [730, 2400, 700, 1400, 4500, 3200][i] < 1 else 1) for n, stamp in enumerate(range(end - 31 * 86400, end + 1, 300))]
                probes.append(("paprika_demo_probe_up", {"cluster": cluster, "service": service}, history))
            for i, node in enumerate(nodes):
                for dest, metric_name, floor, amplitude in [(cpu, "paprika_demo_node_cpu_ratio", .26 + i * .05, .08), (memory, "paprika_demo_node_memory_ratio", .42 + i * .04, .05), (disk, "paprika_demo_node_disk_free_bytes", 27e9 + i * 13e9, 1.8e9)]:
                    points = [(stamp, floor + amplitude * math.sin(n / 37 + i + c)) for n, stamp in enumerate(timestamps)]
                    dest.append((metric_name, {"cluster": cluster, "node": node}, points))
                disk_total.append(("paprika_demo_node_disk_total_bytes", {"cluster": cluster, "node": node}, [(stamp, 128e9) for stamp in timestamps]))
                # Observed, synthetic condition history. A deliberate missing
                # interval stays unknown rather than being treated as ready.
                points = [(stamp, node_condition(i, c, n)) for n, stamp in enumerate(timestamps) if not (i == 5 and 245 <= n < 261)]
                node_states.append(("paprika_demo_node_condition_state", {"cluster": cluster, "node": node}, points))
            for i in range(240):
                points = [(stamp, 0 if (i * 19 + n // 12 + c * 5) % 167 < 2 else 1) for n, stamp in enumerate(timestamps)]
                monitors.append(("paprika_demo_monitor_up", {"cluster": cluster, "monitor": f"monitor-{i + 1:03}"}, points))
        metric("paprika_demo_requests", "counter", requests)
        metric("paprika_demo_request_duration_seconds", "histogram", latency)
        metric("paprika_demo_node_cpu_ratio", "gauge", cpu)
        metric("paprika_demo_node_memory_ratio", "gauge", memory)
        metric("paprika_demo_node_disk_free_bytes", "gauge", disk)
        metric("paprika_demo_node_disk_total_bytes", "gauge", disk_total)
        metric("paprika_demo_node_condition_state", "gauge", node_states)
        metric("paprika_demo_service_up", "gauge", status)
        metric("paprika_demo_probe_up", "gauge", probes)
        metric("paprika_demo_monitor_up", "gauge", monitors)
        sources, pipelines, rejected, burns, network, edge_requests, connections, component_up, destinations, job_states = [], [], [], [], [], [], [], [], [], []
        for c, cluster in enumerate(clusters):
            for i, source in enumerate(["prometheus", "tempo", "shorted-api", "brandbrain", "market-sync"]):
                points = [(stamp, max(.1, (42 if i == 4 and cluster == "omega" else (i + 1) * 2) + 2 * math.sin(n / 27 + i) + (12 if i == 4 and 210 < n < 240 else 0))) for n, stamp in enumerate(timestamps)]
                sources.append(("paprika_demo_source_freshness_seconds", {"cluster": cluster, "source": source}, points))
        for c, cluster in enumerate(clusters):
            # Sampled execution-state gauge, distinct from gallery.jobs rows.
            # 0=failed, 1=running, 2=complete. A deliberate interval without
            # samples lets the history expose unknown rather than inventing a
            # successful execution. Every label is synthetic.
            for i, job in enumerate(["scrape-metrics", "collect-traces", "ingest-logs", "enrich-events", "route-data", "write-storage"]):
                points = []
                for n, stamp in enumerate(timestamps):
                    if i == 4 and 245 <= n < 265:
                        continue
                    phase = (n // 5 + i * 7 + c * 11) % 59
                    value = 0 if phase in (17, 18) else 1 if phase in (3, 4, 38) else 2
                    points.append((stamp, value))
                # `job` is reserved by Prometheus scrape labels; a task label
                # preserves series identity between backfill and live scrape.
                job_states.append(("paprika_demo_job_execution_state", {"cluster": cluster, "task": job}, points))
            for i, pipeline in enumerate(["collect", "normalize", "enrich", "publish"]):
                for j, signal in enumerate(["metrics", "logs", "traces"]):
                    total = 0.0
                    points = []
                    for n, stamp in enumerate(timestamps):
                        total += 60 * pipeline_rate(j, i, c, n)
                        points.append((stamp, total))
                    pipelines.append(("paprika_demo_pipeline_items_total", {"cluster": cluster, "pipeline": pipeline, "signal": signal}, points))
                rejected.append(("paprika_demo_pipeline_rejected_total", {"cluster": cluster, "pipeline": pipeline}, [(stamp, (n + 1) * (2 + i) * 300) for n, stamp in enumerate(timestamps)]))
            for direction in ("inbound", "outbound"):
                points = [(stamp, network_value(n, c, direction)) for n, stamp in enumerate(timestamps)]
                network.append(("paprika_demo_network_mbps", {"cluster": cluster, "direction": direction}, points))
            connections.append(("paprika_demo_edge_connections", {"cluster": cluster}, [(stamp, 18432 + c * 1250 + 280 * math.sin(n / 31) + n * .4) for n, stamp in enumerate(timestamps)]))
            place_counts = {"omega": [("Melbourne", 420), ("Singapore", 960), ("Frankfurt", 1210), ("Virginia", 840), ("San Francisco", 180)], "delta": [("Tokyo", 710), ("London", 633), ("Sydney", 550)]}
            for place, value in place_counts[cluster]:
                destinations.append(("paprika_demo_destination_requests", {"cluster": cluster, "destination": place}, [(stamp, value) for stamp in timestamps]))
            for outcome, base in [("allowed", 700), ("blocked", 20), ("challenged", 215)]:
                total, points = 0.0, []
                for n, stamp in enumerate(timestamps):
                    total += base * 60 * (1 + .2 * math.sin(n / 23 + c))
                    points.append((stamp, total))
                edge_requests.append(("paprika_demo_edge_requests_total", {"cluster": cluster, "outcome": outcome}, points))
            for i, service in enumerate(services):
                for component in ["frontend", "database", "queue"]:
                    points = [(stamp, 0 if i == 2 and component == "database" and 195 <= n <= 208 else 1) for n, stamp in enumerate(timestamps)]
                    component_up.append(("paprika_demo_component_up", {"cluster": cluster, "service": service, "component": component}, points))
                for window, scale in [("1h", 1.0), ("6h", .6)]:
                    points = [(stamp, max(0, .3 + i * .08 + scale * (2 if 195 <= n <= 210 and i == 2 else .1) + .07 * math.sin(n / 40))) for n, stamp in enumerate(timestamps)]
                    burns.append(("paprika_demo_slo_burn_ratio", {"cluster": cluster, "service": service, "window": window}, points))
        metric("paprika_demo_source_freshness_seconds", "gauge", sources)
        metric("paprika_demo_pipeline_items", "counter", pipelines)
        metric("paprika_demo_pipeline_rejected", "counter", rejected)
        metric("paprika_demo_slo_burn_ratio", "gauge", burns)
        metric("paprika_demo_network_mbps", "gauge", network)
        metric("paprika_demo_edge_requests", "counter", edge_requests)
        metric("paprika_demo_edge_connections", "gauge", connections)
        metric("paprika_demo_destination_requests", "gauge", destinations)
        metric("paprika_demo_component_up", "gauge", component_up)
        metric("paprika_demo_job_execution_state", "gauge", job_states)
        sectors = ["Technology", "Healthcare", "Financials", "Energy", "Industrials", "Consumer"]
        company_count, short_values, changes, coverage = [], [], [], []
        for sector_index, sector in enumerate(sectors):
            members = [i for i in range(1, 97) if (i - 1) % 6 == sector_index]
            base = sum(1 + (i % 23) * .43 for i in members) / len(members)
            cov = sum(94 + (i % 7) for i in members) / len(members)
            tags = {"sector": sector}
            company_count.append(("paprika_demo_market_companies", tags, [(stamp, len(members)) for stamp in timestamps]))
            coverage.append(("paprika_demo_market_coverage_percent", tags, [(stamp, cov) for stamp in timestamps]))
            # Match the hourly synthetic values seeded in gallery.company_history.
            def history_at(stamp):
                hour = stamp // 3600 * 3600
                last = end // 3600 * 3600
                i = 47 + (hour - last) / 3600
                return base + math.sin(i / 7 + len("Example company 001")) * .4
            short_values.append(("paprika_demo_market_short_percent", tags, [(stamp, history_at(stamp)) for stamp in timestamps]))
            changes.append(("paprika_demo_market_change", tags, [(stamp, history_at(stamp) - history_at(stamp - 3600)) for stamp in timestamps]))
        metric("paprika_demo_market_companies", "gauge", company_count)
        metric("paprika_demo_market_short_percent", "gauge", short_values)
        metric("paprika_demo_market_change", "gauge", changes)
        metric("paprika_demo_market_coverage_percent", "gauge", coverage)
        f.write("# EOF\n")


if __name__ == "__main__":
    main()
