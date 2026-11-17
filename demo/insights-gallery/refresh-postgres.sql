-- Append-only synthetic observations for the disposable gallery database.
-- Installed only in a PostgreSQL container created by start.py. This is demo
-- telemetry, not an indication that any real service or scrape is healthy.
CREATE TABLE gallery.synthetic_history_clock (
  name text PRIMARY KEY,
  initial_at timestamptz NOT NULL,
  through_at timestamptz NOT NULL
);
INSERT INTO gallery.synthetic_history_clock(name, initial_at, through_at)
SELECT 'probes', max(observed_at), max(observed_at) FROM gallery.service_probe_samples
UNION ALL SELECT 'companies', max(observed_at), max(observed_at) FROM gallery.company_history
UNION ALL SELECT 'nodes', max(observed_at), max(observed_at) FROM gallery.node_history
UNION ALL SELECT 'edge', max(observed_at), max(observed_at) FROM gallery.edge_source_history
UNION ALL SELECT 'edge-blocks', max(occurred_at), max(occurred_at) FROM gallery.edge_blocked_requests
UNION ALL SELECT 'edge-events', max(occurred_at), max(occurred_at) FROM gallery.edge_events;

-- One invocation owns at most one day of catch-up per dataset. The checkpoint
-- and inserts are committed atomically, so interruption cannot leave a
-- half-written interval. The transaction-scoped lock serializes concurrent
-- workers; re-running at the same time adds nothing.
CREATE FUNCTION gallery.refresh_synthetic_history(as_of timestamptz) RETURNS void
LANGUAGE plpgsql SET timezone = 'UTC' AS $$
DECLARE
  clock_name text;
  first_at timestamptz;
  last_at timestamptz;
  next_at timestamptz;
  interval_size interval;
BEGIN
  IF as_of IS NULL THEN RAISE EXCEPTION 'Synthetic history requires an observation time'; END IF;
  PERFORM pg_advisory_xact_lock(1809240114, 1900276080);
  FOREACH clock_name IN ARRAY ARRAY['probes', 'companies', 'nodes', 'edge', 'edge-blocks', 'edge-events'] LOOP
    SELECT initial_at, through_at INTO STRICT first_at, last_at FROM gallery.synthetic_history_clock WHERE name = clock_name FOR UPDATE;
    interval_size := CASE clock_name WHEN 'probes' THEN interval '5 minutes' WHEN 'edge' THEN interval '1 minute' WHEN 'edge-blocks' THEN interval '2 minutes' WHEN 'edge-events' THEN interval '15 minutes' ELSE interval '1 hour' END;
    -- Align to the originally seeded series, not wall-clock buckets, and do
    -- not advance a checkpoint backwards when a worker's clock moves backward.
    next_at := greatest(last_at, least(last_at + interval '1 day', first_at + floor(extract(epoch FROM (as_of - first_at)) / extract(epoch FROM interval_size)) * interval_size));
    IF clock_name = 'probes' THEN
      INSERT INTO gallery.service_probe_samples(service, observed_at, up)
      SELECT svc.service, tick.at, (8640 + (extract(epoch FROM (tick.at - first_at)) / 300)::integer + svc.idx * 61) % (ARRAY[730,2400,700,1400,4500,3200])[svc.idx+1] >= 1
      FROM (VALUES (0,'api-gateway'),(1,'checkout'),(2,'payments'),(3,'worker'),(4,'catalog'),(5,'notifications')) svc(idx,service)
      CROSS JOIN generate_series(last_at + interval_size, next_at, interval_size) tick(at);
    ELSIF clock_name = 'companies' THEN
      INSERT INTO gallery.company_history(symbol, observed_at, value)
      SELECT c.symbol, tick.at, round((c.short_percent + sin((47 + extract(epoch FROM (tick.at - first_at)) / 3600)::double precision / 7 + length(c.name))*0.4)::numeric,3)::double precision
      FROM gallery.companies c CROSS JOIN generate_series(last_at + interval_size, next_at, interval_size) tick(at);
    ELSIF clock_name = 'nodes' THEN
      INSERT INTO gallery.node_history(cluster, node, observed_at, cpu_ratio)
      SELECT n.cluster, n.node, tick.at,
        round((0.3+((47 + (extract(epoch FROM (tick.at - first_at)) / 3600)::integer)%7)*0.03+0.08*sin((47 + extract(epoch FROM (tick.at - first_at)) / 3600)::double precision/4+substring(n.node from 6)::integer)+substring(n.node from 6)::integer*0.015)::numeric,4)::double precision
      FROM gallery.nodes n CROSS JOIN generate_series(last_at + interval_size, next_at, interval_size) tick(at);
    ELSIF clock_name = 'edge' THEN
      INSERT INTO gallery.edge_source_history(cluster, source, observed_at, requests)
      SELECT s.cluster, s.source, tick.at,
        (20 + s.risk + 12*sin((59 + extract(epoch FROM (tick.at - first_at)) / 60)::double precision/5+length(s.source)) + CASE WHEN (59 + (extract(epoch FROM (tick.at - first_at)) / 60)::integer)%17=0 THEN s.risk/2 ELSE 0 END)::double precision
      FROM gallery.edge_sources s CROSS JOIN generate_series(last_at + interval_size, next_at, interval_size) tick(at);
    ELSIF clock_name = 'edge-blocks' THEN
      -- Fictional documentation-only addresses, never recorded customer data.
      -- Each cluster gets one explicitly synthetic row per tick.
      INSERT INTO gallery.edge_blocked_requests(cluster, occurred_at, source, destination, rule, count, status)
      SELECT c.cluster, tick.at, '198.51.100.' || (11 + (n.idx % 24))::text,
        '192.0.2.' || (11 + (n.idx % 10))::text || ':443',
        (ARRAY['geo-block: country','rule: injection','rule: scanner-detect','geo-block: tor-exit'])[1 + (n.idx % 4)::integer],
        22 + 7 * (n.idx % 24), 'Blocked'
      FROM (VALUES ('omega'), ('delta')) c(cluster)
      CROSS JOIN generate_series(last_at + interval_size, next_at, interval_size) tick(at)
      CROSS JOIN LATERAL (SELECT (extract(epoch FROM (tick.at - first_at)) / 120)::bigint AS idx) n;
    ELSE
      INSERT INTO gallery.edge_events(cluster, occurred_at, label, severity)
      SELECT c.cluster, tick.at,
        (ARRAY['Synthetic edge policy applied','Synthetic traffic investigation','Synthetic gateway deployment'])[1 + (n.idx % 3)::integer],
        (ARRAY['info','warning','info'])[1 + (n.idx % 3)::integer]
      FROM (VALUES ('omega'), ('delta')) c(cluster)
      CROSS JOIN generate_series(last_at + interval_size, next_at, interval_size) tick(at)
      CROSS JOIN LATERAL (SELECT (extract(epoch FROM (tick.at - first_at)) / 900)::bigint AS idx) n;
    END IF;
    UPDATE gallery.synthetic_history_clock SET through_at = next_at WHERE name = clock_name;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION gallery.refresh_synthetic_history(timestamptz) FROM PUBLIC;
