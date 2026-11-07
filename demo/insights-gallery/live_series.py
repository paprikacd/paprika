"""Bounded deterministic continuation of the gallery's synthetic history.

The common integrated activity factor keeps related histogram buckets ordered
and counters monotonic, independent of scrape frequency or process restarts.
"""
import hashlib
import math


def integrated_activity(elapsed, phase=0.0):
    elapsed = max(0.0, elapsed)
    angular_rate = 2 * math.pi / 1200
    # The derivative is 1 + 0.25*sin(angular_rate*t + phase), strictly positive.
    return elapsed + .25 / angular_rate * (math.cos(phase) - math.cos(angular_rate * elapsed + phase))


def node_condition(node_index, cluster_index, minute):
    """Synthetic observed condition: 0 unavailable, 1 pressure, 2 ready.

    This is an independent emulated signal, not derived from CPU utilization.
    Reuse the same cycle in backfill and live continuation.
    """
    phase = (minute // 6 + node_index * 11 + cluster_index * 7) % 89
    return 0 if phase in (56, 57) else 1 if 20 <= phase <= 25 else 2


def network_value(minute, cluster_index, direction):
    """Synthetic Mb/s at a fractional minute on the gallery history clock.

    Stable minute-level variation makes individual peaks and troughs useful
    for testing selection and tooltips. Interpolation keeps sub-minute live
    scrapes continuous and independent of scrape frequency or process restarts.
    """
    base = (842 if direction == "inbound" else 218) * (1 if cluster_index == 0 else .82)
    phase = cluster_index * 1.13 + (0 if direction == "inbound" else 2.17)
    minute = max(0.0, minute)
    whole = math.floor(minute)
    def noise(index):
        digest = hashlib.sha256(f"gallery-network:{cluster_index}:{direction}:{index}".encode()).digest()
        return int.from_bytes(digest[:4], "big") / (2**32 - 1) * 2 - 1
    fraction = minute - whole
    jitter = noise(whole) * (1 - fraction) + noise(whole + 1) * fraction
    return base * (.92 + .14 * math.sin(minute / 19 + phase) + .09 * math.sin(minute / 3.3 + phase * 1.4) + .16 * jitter)


def continued_value(key, last, previous, now):
    stamp, value = last
    elapsed = max(0.0, now - stamp)
    name = key.split("{", 1)[0]
    phase = int.from_bytes(hashlib.sha256(key.encode()).digest()[:4], "big") / 2**32 * 2 * math.pi
    if name.endswith(("_total", "_bucket", "_sum", "_count")):
        if previous and stamp > previous[0]:
            slope = max(0.0, (value - previous[1]) / (stamp - previous[0]))
            # All buckets, count and sum in a histogram use the same activity
            # clock; unrelated counters vary independently (including errors).
            histogram = name.endswith(("_bucket", "_sum", "_count"))
            # Pipeline counters continue from their last historical slope with
            # a common activity clock: rate order stays stable and the first
            # live derivative matches the backfill instead of jumping at scrape.
            shared_clock = histogram or name == "paprika_demo_pipeline_items_total"
            return value + slope * integrated_activity(elapsed, 0.0 if shared_clock else phase)
        return value

    # Keep observations continuous at the backfill boundary. Stable phase
    # offsets make nodes and other series move independently across restarts.
    wave = math.sin(elapsed / 360 + phase) - math.sin(phase)
    if name in ("paprika_demo_node_cpu_ratio", "paprika_demo_node_memory_ratio"):
        return min(1.0, max(0.0, value + .045 * wave))
    if name == "paprika_demo_node_condition_state":
        index = next((i for i in range(8) if f'node="node-{i + 1:02}"' in key), None)
        if index is None:
            return value
        cluster_index = 1 if 'cluster="delta"' in key else 0
        return node_condition(index, cluster_index, 360 + int(elapsed // 60))
    if name == "paprika_demo_node_disk_free_bytes":
        return min(128e9, max(0.0, value + 1.5e9 * wave))
    if name == "paprika_demo_network_mbps":
        cluster_index = 1 if 'cluster="delta"' in key else 0
        direction = "outbound" if 'direction="outbound"' in key else "inbound"
        # Preserve the actual (possibly rounded or older) last backfilled
        # sample exactly while continuing with the same synthetic clock.
        return max(0.0, value + (network_value(360 + elapsed / 60, cluster_index, direction) - network_value(360, cluster_index, direction)))
    if name in ("paprika_demo_edge_connections", "paprika_demo_destination_requests", "paprika_demo_source_freshness_seconds"):
        return max(0.0, value * (1 + .08 * wave))
    if name == "paprika_demo_job_execution_state":
        jobs = ("scrape-metrics", "collect-traces", "ingest-logs", "enrich-events", "route-data", "write-storage")
        index = next((i for i, job in enumerate(jobs) if f'task="{job}"' in key), None)
        if index is None:
            return value
        cluster_index = 1 if 'cluster="delta"' in key else 0
        phase = ((360 + int(elapsed // 60)) // 5 + index * 7 + cluster_index * 11) % 59
        return 0 if phase in (17, 18) else 1 if phase in (3, 4, 38) else 2
    return value
