-- Synthetic data for a dedicated local-only Paprika gallery database.
-- No real companies or operational events are imported; geographic locations are synthetic.
CREATE SCHEMA gallery;
CREATE TABLE gallery.services (cluster text NOT NULL, service text NOT NULL, team text NOT NULL, target_percent double precision NOT NULL);
INSERT INTO gallery.services
SELECT cluster, service, team, 99.9 FROM (VALUES ('omega'), ('delta')) c(cluster)
CROSS JOIN (VALUES ('api-gateway','platform'),('checkout','commerce'),('payments','commerce'),('worker','platform'),('catalog','market'),('notifications','platform')) s(service,team);

-- A separate recorded probe set powers the relational SLO comparison table.
-- Samples are synthetic observations, not an assertion of continuous uptime.
CREATE TABLE gallery.service_probe_samples (service text NOT NULL, observed_at timestamptz NOT NULL, up boolean NOT NULL);
INSERT INTO gallery.service_probe_samples
SELECT service, date_trunc('minute',now()) - (8640-n)*interval '5 minutes', (n + service_index*61)%(ARRAY[730,2400,700,1400,4500,3200])[service_index+1] >= 1
FROM (VALUES (0,'api-gateway'),(1,'checkout'),(2,'payments'),(3,'worker'),(4,'catalog'),(5,'notifications')) s(service_index,service)
CROSS JOIN generate_series(0,8640) n;
CREATE INDEX ON gallery.service_probe_samples(service,observed_at);

CREATE TABLE gallery.companies (symbol text PRIMARY KEY, name text NOT NULL, sector text NOT NULL, market_cap bigint NOT NULL, short_percent double precision NOT NULL, coverage_percent double precision NOT NULL);
INSERT INTO gallery.companies
SELECT 'DEMO' || lpad(i::text,3,'0'), 'Example company ' || lpad(i::text,3,'0'),
  (ARRAY['Technology','Healthcare','Financials','Energy','Industrials','Consumer'])[1+(i-1)%6],
  1000000000::bigint + i::bigint*381000000, round((1 + (i%23)*0.43)::numeric,2)::double precision, 94+(i%7)
FROM generate_series(1,96) i;

CREATE TABLE gallery.company_history (symbol text NOT NULL REFERENCES gallery.companies(symbol), observed_at timestamptz NOT NULL, value double precision);
INSERT INTO gallery.company_history
SELECT c.symbol, date_trunc('hour',now()) - (47-i)*interval '1 hour',
  round((c.short_percent + sin(i::double precision/7 + length(c.name))*0.4)::numeric,3)::double precision
FROM gallery.companies c CROSS JOIN generate_series(0,47) i;
CREATE INDEX ON gallery.company_history(symbol, observed_at);

CREATE TABLE gallery.nodes (cluster text NOT NULL, node text NOT NULL, namespace text NOT NULL, cores double precision NOT NULL, memory_bytes bigint NOT NULL, memory_ratio double precision NOT NULL, disk_used_ratio double precision NOT NULL);
INSERT INTO gallery.nodes
SELECT cluster, 'node-'||lpad(i::text,2,'0'), (ARRAY['platform','commerce','observability'])[1+(i-1)%3], 4+(i%3)*2, (8+(i%3)*8)::bigint*1073741824,
  0.42+(i-1)*0.04+0.05*sin(360.0/37+(i-1)+CASE WHEN cluster='omega' THEN 0 ELSE 1 END),
  1-(27000000000.0+(i-1)*13000000000.0+1800000000.0*sin(360.0/37+(i-1)+CASE WHEN cluster='omega' THEN 0 ELSE 1 END))/128000000000.0
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN generate_series(1,8) i;
CREATE TABLE gallery.node_history (cluster text NOT NULL, node text NOT NULL, observed_at timestamptz NOT NULL, cpu_ratio double precision);
INSERT INTO gallery.node_history
SELECT n.cluster,n.node,date_trunc('hour',now())-(47-i)*interval '1 hour',
 round((0.3+(i%7)*0.03+0.08*sin(i::double precision/4+substring(n.node from 6)::integer) + substring(n.node from 6)::integer*0.015)::numeric,4)::double precision
FROM gallery.nodes n CROSS JOIN generate_series(0,47) i;
CREATE INDEX ON gallery.node_history(cluster,node,observed_at);

CREATE TABLE gallery.incidents (id text PRIMARY KEY, cluster text NOT NULL, service text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, severity text NOT NULL, summary text NOT NULL);
INSERT INTO gallery.incidents
SELECT 'incident-'||lpad(i::text,3,'0'), CASE WHEN ((i-1)/6)%2=0 THEN 'omega' ELSE 'delta' END,
  (ARRAY['api-gateway','checkout','payments','worker','catalog','notifications'])[1+(i-1)%6],
  CASE WHEN i=2 THEN now()-interval '8 minutes' WHEN i=3 THEN now()-interval '15 minutes' ELSE now()-i*interval '18 hours' END,
  CASE WHEN i=1 THEN NULL WHEN i=2 THEN now()-interval '4 minutes' WHEN i=3 THEN now()-interval '5 minutes' ELSE now()-i*interval '18 hours'+interval '18 minutes' END,
  CASE WHEN i%5=0 THEN 'critical' ELSE 'warning' END,
  (ARRAY['Synthetic gateway request errors','Synthetic checkout upstream timeout','Synthetic payment authorization latency','Synthetic worker queue backlog','Synthetic catalog connection saturation','Synthetic notification delivery delay'])[1+(i-1)%6]
FROM generate_series(1,30) i;

-- Simulated 9-hour error incidents correspond to the triangular error-rate
-- spikes in generate-metrics.py. The recorded timestamps, not chart styling,
-- determine the shaded interval shown by the dashboard.
INSERT INTO gallery.incidents
SELECT 'reliability-'||cluster||'-'||service||'-'||incident_index::text, cluster, service,
  date_trunc('minute',now()) - ((center_hours+4.5)*interval '1 hour'),
  date_trunc('minute',now()) - ((center_hours-4.5)*interval '1 hour'),
  CASE WHEN incident_index=1 THEN 'critical' ELSE 'warning' END,
  CASE WHEN incident_index=1 THEN 'Synthetic elevated request errors' ELSE 'Synthetic upstream error burst' END
FROM (VALUES ('omega'),('delta')) c(cluster)
CROSS JOIN (VALUES (0,'api-gateway'),(1,'checkout'),(2,'payments'),(3,'worker'),(4,'catalog'),(5,'notifications')) svc(service_index,service)
CROSS JOIN LATERAL (VALUES (1,120+service_index*2),(2,420+service_index*3)) events(incident_index,center_hours);

-- A distinct incident-severity demonstration, kept separate from operational
-- incidents and their aligned metric/trace windows. Only insert on a past UTC
-- day with no existing incident for that service, so the unknown rank cannot
-- mask a known severity. On the first day of a month a free day may not yet
-- exist; in that case no sample is invented for that service.
CREATE TABLE gallery.incident_severity_samples (cluster text NOT NULL, service text NOT NULL, started_at timestamptz NOT NULL, severity text NOT NULL, summary text NOT NULL);
INSERT INTO gallery.incident_severity_samples
SELECT 'omega', svc.service, free.day, 'unclassified', 'Synthetic incident with unclassified severity'
FROM (VALUES ('checkout'),('payments')) svc(service)
CROSS JOIN LATERAL (
  SELECT (date_trunc('day',now() AT TIME ZONE 'UTC') - n * interval '1 day') AT TIME ZONE 'UTC' AS day
  FROM generate_series(0,30) n
  WHERE date_trunc('day',now() AT TIME ZONE 'UTC') - n * interval '1 day' >= date_trunc('month',now() AT TIME ZONE 'UTC')
    AND NOT EXISTS (SELECT 1 FROM gallery.incidents i WHERE i.cluster='omega' AND i.service=svc.service AND (i.started_at AT TIME ZONE 'UTC')::date = (date_trunc('day',now() AT TIME ZONE 'UTC') - n * interval '1 day')::date)
  ORDER BY n LIMIT 1
) free;

CREATE TABLE gallery.destinations (cluster text NOT NULL, label text NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL, requests bigint NOT NULL, status text NOT NULL);
INSERT INTO gallery.destinations VALUES
('omega','Melbourne',-37.81,144.96,420,'Allowed'),('omega','Singapore',1.35,103.82,960,'Allowed'),('omega','Frankfurt',50.11,8.68,1210,'Blocked'),('omega','Virginia',37.43,-78.65,840,'Allowed'),('omega','San Francisco',37.77,-122.42,180,'Blocked'),
('delta','Tokyo',35.68,139.69,710,'Allowed'),('delta','London',51.50,-0.12,633,'Allowed'),('delta','Sydney',-33.87,151.21,550,'Blocked');

-- Explicit synthetic observations for directional-traffic annotations.
CREATE TABLE gallery.edge_events (cluster text NOT NULL, occurred_at timestamptz NOT NULL, label text NOT NULL, severity text NOT NULL);
INSERT INTO gallery.edge_events
SELECT cluster, now() - minutes_ago * interval '1 minute', label, severity
FROM (VALUES ('omega'),('delta')) c(cluster)
CROSS JOIN (VALUES (12,'Edge policy applied','info'),(38,'Synthetic traffic investigation','warning'),(95,'Gateway deployment','info')) e(minutes_ago,label,severity);
CREATE INDEX ON gallery.edge_events(cluster,occurred_at);

-- Synthetic geographic observations. These fixed sample coordinates are on
-- simplified Natural Earth 1:50m land polygons, within ~2.2 degrees of each
-- named center. They are illustrative points, not actual clients, population,
-- addresses, or exact geocoding. See README.md for provenance and limitations.
CREATE TABLE gallery.geo_events (cluster text NOT NULL, label text NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL, requests double precision NOT NULL, status text NOT NULL);
INSERT INTO gallery.geo_events
WITH coordinates(city_index,city,sample_index,latitude,longitude) AS (VALUES
  (1,'Melbourne',1,-37.8100::double precision,144.9600::double precision), (1,'Melbourne',2,-37.6900::double precision,144.8400::double precision), (1,'Melbourne',3,-37.6900::double precision,145.0800::double precision), (1,'Melbourne',4,-37.9300::double precision,145.0800::double precision),
  (1,'Melbourne',5,-37.8900::double precision,144.8400::double precision), (1,'Melbourne',6,-37.9300::double precision,144.9600::double precision), (1,'Melbourne',7,-37.6900::double precision,144.9600::double precision), (1,'Melbourne',8,-37.8100::double precision,145.0800::double precision),
  (1,'Melbourne',9,-37.8100::double precision,145.3200::double precision), (1,'Melbourne',10,-35.6500::double precision,144.9600::double precision), (1,'Melbourne',11,-37.8100::double precision,142.8000::double precision), (1,'Melbourne',12,-36.7300::double precision,146.7600::double precision),
  (1,'Melbourne',13,-39.0700::double precision,146.4000::double precision), (1,'Melbourne',14,-36.5500::double precision,143.5200::double precision), (1,'Melbourne',15,-37.9900::double precision,146.9400::double precision), (1,'Melbourne',16,-38.7100::double precision,143.7000::double precision),
  (1,'Melbourne',17,-36.7300::double precision,145.1400::double precision), (1,'Melbourne',18,-37.6300::double precision,144.0600::double precision), (1,'Melbourne',19,-36.0100::double precision,146.0400::double precision), (1,'Melbourne',20,-37.2700::double precision,146.0400::double precision),
  (1,'Melbourne',21,-38.5300::double precision,145.6800::double precision), (1,'Melbourne',22,-37.0900::double precision,142.9800::double precision), (1,'Melbourne',23,-36.1900::double precision,144.4200::double precision), (1,'Melbourne',24,-38.3500::double precision,144.7800::double precision),
  (2,'Singapore',1,1.3500::double precision,103.8200::double precision), (2,'Singapore',2,1.4700::double precision,103.9400::double precision), (2,'Singapore',3,1.4700::double precision,103.7000::double precision), (2,'Singapore',4,1.3100::double precision,103.7000::double precision),
  (2,'Singapore',5,1.3500::double precision,103.9400::double precision), (2,'Singapore',6,1.4300::double precision,103.7800::double precision), (2,'Singapore',7,1.2700::double precision,103.8200::double precision), (2,'Singapore',8,1.3900::double precision,103.7000::double precision),
  (2,'Singapore',9,1.7100::double precision,103.8200::double precision), (2,'Singapore',10,-0.6300::double precision,103.1000::double precision), (2,'Singapore',11,1.3500::double precision,101.6600::double precision), (2,'Singapore',12,-0.2700::double precision,104.9000::double precision),
  (2,'Singapore',13,3.1500::double precision,102.7400::double precision), (2,'Singapore',14,0.6300::double precision,102.7400::double precision), (2,'Singapore',15,2.7900::double precision,104.1800::double precision), (2,'Singapore',16,2.0700::double precision,102.5600::double precision),
  (2,'Singapore',17,0.9900::double precision,104.5400::double precision), (2,'Singapore',18,0.2700::double precision,103.6400::double precision), (2,'Singapore',19,-0.0900::double precision,102.3800::double precision), (2,'Singapore',20,2.4300::double precision,103.4600::double precision),
  (2,'Singapore',21,0.6300::double precision,101.8400::double precision), (2,'Singapore',22,2.6100::double precision,102.2000::double precision), (2,'Singapore',23,1.1700::double precision,102.3800::double precision), (2,'Singapore',24,-0.6300::double precision,104.3600::double precision),
  (3,'Tokyo',1,35.6800::double precision,139.6900::double precision), (3,'Tokyo',2,35.5600::double precision,139.5700::double precision), (3,'Tokyo',3,35.8000::double precision,139.5700::double precision), (3,'Tokyo',4,35.8000::double precision,139.8100::double precision),
  (3,'Tokyo',5,35.5600::double precision,139.7700::double precision), (3,'Tokyo',6,35.6800::double precision,139.5700::double precision), (3,'Tokyo',7,35.8000::double precision,139.6900::double precision), (3,'Tokyo',8,35.6800::double precision,139.8100::double precision),
  (3,'Tokyo',9,35.6800::double precision,139.3300::double precision), (3,'Tokyo',10,37.8400::double precision,139.6900::double precision), (3,'Tokyo',11,36.9400::double precision,138.0700::double precision), (3,'Tokyo',12,34.9600::double precision,137.7100::double precision),
  (3,'Tokyo',13,36.5800::double precision,140.5900::double precision), (3,'Tokyo',14,36.7600::double precision,139.3300::double precision), (3,'Tokyo',15,35.3200::double precision,140.4100::double precision), (3,'Tokyo',16,34.7800::double precision,138.9700::double precision),
  (3,'Tokyo',17,36.0400::double precision,137.7100::double precision), (3,'Tokyo',18,37.4800::double precision,140.7700::double precision), (3,'Tokyo',19,37.4800::double precision,138.7900::double precision), (3,'Tokyo',20,35.5000::double precision,138.4300::double precision),
  (3,'Tokyo',21,36.2200::double precision,138.6100::double precision), (3,'Tokyo',22,36.2200::double precision,139.8700::double precision), (3,'Tokyo',23,37.1200::double precision,140.0500::double precision), (3,'Tokyo',24,34.9600::double precision,139.8700::double precision),
  (4,'Sydney',1,-33.8700::double precision,151.2100::double precision), (4,'Sydney',2,-33.9900::double precision,151.0900::double precision), (4,'Sydney',3,-33.7500::double precision,151.0900::double precision), (4,'Sydney',4,-33.7500::double precision,151.2900::double precision),
  (4,'Sydney',5,-33.8700::double precision,151.0900::double precision), (4,'Sydney',6,-33.9500::double precision,151.2500::double precision), (4,'Sydney',7,-33.7900::double precision,151.1700::double precision), (4,'Sydney',8,-33.9500::double precision,151.1700::double precision),
  (4,'Sydney',9,-33.8700::double precision,150.8500::double precision), (4,'Sydney',10,-31.7100::double precision,151.2100::double precision), (4,'Sydney',11,-35.6700::double precision,150.1300::double precision), (4,'Sydney',12,-32.6100::double precision,149.5900::double precision),
  (4,'Sydney',13,-34.4100::double precision,149.2300::double precision), (4,'Sydney',14,-32.4300::double precision,152.4700::double precision), (4,'Sydney',15,-32.7900::double precision,151.0300::double precision), (4,'Sydney',16,-34.7700::double precision,150.4900::double precision),
  (4,'Sydney',17,-33.5100::double precision,149.4100::double precision), (4,'Sydney',18,-32.0700::double precision,150.3100::double precision), (4,'Sydney',19,-35.1300::double precision,149.5900::double precision), (4,'Sydney',20,-33.3300::double precision,150.3100::double precision),
  (4,'Sydney',21,-34.0500::double precision,149.9500::double precision), (4,'Sydney',22,-32.9700::double precision,151.7500::double precision), (4,'Sydney',23,-32.2500::double precision,151.7500::double precision), (4,'Sydney',24,-33.5100::double precision,151.3900::double precision),
  (5,'Frankfurt',1,50.1100::double precision,8.6800::double precision), (5,'Frankfurt',2,49.9900::double precision,8.8000::double precision), (5,'Frankfurt',3,50.2300::double precision,8.8000::double precision), (5,'Frankfurt',4,49.9900::double precision,8.5600::double precision),
  (5,'Frankfurt',5,50.2300::double precision,8.5600::double precision), (5,'Frankfurt',6,50.0700::double precision,8.5600::double precision), (5,'Frankfurt',7,50.1500::double precision,8.5600::double precision), (5,'Frankfurt',8,50.0300::double precision,8.6800::double precision),
  (5,'Frankfurt',9,50.1100::double precision,8.3200::double precision), (5,'Frankfurt',10,52.2700::double precision,8.6800::double precision), (5,'Frankfurt',11,47.9500::double precision,8.6800::double precision), (5,'Frankfurt',12,49.3900::double precision,10.6600::double precision),
  (5,'Frankfurt',13,51.0100::double precision,10.4800::double precision), (5,'Frankfurt',14,49.0300::double precision,6.8800::double precision), (5,'Frankfurt',15,51.1900::double precision,6.8800::double precision), (5,'Frankfurt',16,50.1100::double precision,6.5200::double precision),
  (5,'Frankfurt',17,49.0300::double precision,9.0400::double precision), (5,'Frankfurt',18,51.1900::double precision,8.6800::double precision), (5,'Frankfurt',19,50.1100::double precision,9.7600::double precision), (5,'Frankfurt',20,51.7300::double precision,9.7600::double precision),
  (5,'Frankfurt',21,48.4900::double precision,9.9400::double precision), (5,'Frankfurt',22,48.4900::double precision,7.7800::double precision), (5,'Frankfurt',23,51.7300::double precision,7.7800::double precision), (5,'Frankfurt',24,49.3900::double precision,7.9600::double precision),
  (6,'London',1,51.5000::double precision,-0.1200::double precision), (6,'London',2,51.3800::double precision,-0.2400::double precision), (6,'London',3,51.6200::double precision,-0.2400::double precision), (6,'London',4,51.3800::double precision,0.0000::double precision),
  (6,'London',5,51.6200::double precision,0.0000::double precision), (6,'London',6,51.4600::double precision,-0.2400::double precision), (6,'London',7,51.5400::double precision,-0.2400::double precision), (6,'London',8,51.4200::double precision,-0.1200::double precision),
  (6,'London',9,51.5000::double precision,-0.4800::double precision), (6,'London',10,49.5200::double precision,0.6000::double precision), (6,'London',11,53.4800::double precision,0.0600::double precision), (6,'London',12,50.9600::double precision,1.8600::double precision),
  (6,'London',13,52.4000::double precision,1.6800::double precision), (6,'London',14,52.5800::double precision,-1.9200::double precision), (6,'London',15,50.7800::double precision,-2.1000::double precision), (6,'London',16,52.4000::double precision,0.0600::double precision),
  (6,'London',17,51.6800::double precision,-2.1000::double precision), (6,'London',18,50.7800::double precision,0.2400::double precision), (6,'London',19,53.3000::double precision,-1.2000::double precision), (6,'London',20,51.6800::double precision,0.7800::double precision),
  (6,'London',21,52.9400::double precision,0.7800::double precision), (6,'London',22,50.7800::double precision,-0.8400::double precision), (6,'London',23,52.0400::double precision,-1.2000::double precision), (6,'London',24,52.5800::double precision,-0.8400::double precision),
  (7,'Paris',1,48.8600::double precision,2.3500::double precision), (7,'Paris',2,48.7400::double precision,2.2300::double precision), (7,'Paris',3,48.9800::double precision,2.2300::double precision), (7,'Paris',4,48.7400::double precision,2.4700::double precision),
  (7,'Paris',5,48.9800::double precision,2.4700::double precision), (7,'Paris',6,48.8200::double precision,2.2300::double precision), (7,'Paris',7,48.9000::double precision,2.2300::double precision), (7,'Paris',8,48.7800::double precision,2.3500::double precision),
  (7,'Paris',9,48.8600::double precision,2.7100::double precision), (7,'Paris',10,51.0200::double precision,2.3500::double precision), (7,'Paris',11,46.7000::double precision,2.3500::double precision), (7,'Paris',12,48.1400::double precision,0.3700::double precision),
  (7,'Paris',13,49.7600::double precision,0.5500::double precision), (7,'Paris',14,47.7800::double precision,4.1500::double precision), (7,'Paris',15,49.9400::double precision,4.1500::double precision), (7,'Paris',16,47.7800::double precision,1.9900::double precision),
  (7,'Paris',17,48.8600::double precision,4.5100::double precision), (7,'Paris',18,49.9400::double precision,2.1700::double precision), (7,'Paris',19,48.8600::double precision,1.2700::double precision), (7,'Paris',20,50.4800::double precision,3.2500::double precision),
  (7,'Paris',21,47.2400::double precision,1.0900::double precision), (7,'Paris',22,47.2400::double precision,3.2500::double precision), (7,'Paris',23,48.1400::double precision,3.0700::double precision), (7,'Paris',24,49.4000::double precision,3.4300::double precision),
  (8,'Virginia',1,37.4300::double precision,-78.6500::double precision), (8,'Virginia',2,37.3100::double precision,-78.5300::double precision), (8,'Virginia',3,37.5500::double precision,-78.5300::double precision), (8,'Virginia',4,37.3100::double precision,-78.7700::double precision),
  (8,'Virginia',5,37.5500::double precision,-78.7700::double precision), (8,'Virginia',6,37.4300::double precision,-78.5300::double precision), (8,'Virginia',7,37.4300::double precision,-78.7700::double precision), (8,'Virginia',8,37.3100::double precision,-78.6500::double precision),
  (8,'Virginia',9,37.4300::double precision,-79.0100::double precision), (8,'Virginia',10,39.5900::double precision,-78.6500::double precision), (8,'Virginia',11,35.2700::double precision,-78.6500::double precision), (8,'Virginia',12,37.4300::double precision,-76.4900::double precision),
  (8,'Virginia',13,36.3500::double precision,-80.4500::double precision), (8,'Virginia',14,38.5100::double precision,-80.4500::double precision), (8,'Virginia',15,36.1700::double precision,-77.2100::double precision), (8,'Virginia',16,38.6900::double precision,-77.2100::double precision),
  (8,'Virginia',17,37.4300::double precision,-80.8100::double precision), (8,'Virginia',18,38.5100::double precision,-78.8300::double precision), (8,'Virginia',19,36.3500::double precision,-78.8300::double precision), (8,'Virginia',20,37.2500::double precision,-77.7500::double precision),
  (8,'Virginia',21,35.6300::double precision,-79.7300::double precision), (8,'Virginia',22,39.2300::double precision,-79.7300::double precision), (8,'Virginia',23,37.0700::double precision,-79.9100::double precision), (8,'Virginia',24,38.1500::double precision,-77.9300::double precision),
  (9,'San Francisco',1,37.7700::double precision,-122.4200::double precision), (9,'San Francisco',2,37.8900::double precision,-122.5400::double precision), (9,'San Francisco',3,37.8900::double precision,-122.3000::double precision), (9,'San Francisco',4,37.6500::double precision,-122.5000::double precision),
  (9,'San Francisco',5,37.6500::double precision,-122.3800::double precision), (9,'San Francisco',6,37.8100::double precision,-122.3000::double precision), (9,'San Francisco',7,37.7300::double precision,-122.5000::double precision), (9,'San Francisco',8,37.8500::double precision,-122.5000::double precision),
  (9,'San Francisco',9,37.7700::double precision,-122.0600::double precision), (9,'San Francisco',10,39.9300::double precision,-122.4200::double precision), (9,'San Francisco',11,35.9700::double precision,-121.3400::double precision), (9,'San Francisco',12,38.8500::double precision,-120.6200::double precision),
  (9,'San Francisco',13,37.2300::double precision,-120.4400::double precision), (9,'San Francisco',14,38.8500::double precision,-123.5000::double precision), (9,'San Francisco',15,38.8500::double precision,-122.0600::double precision), (9,'San Francisco',16,36.8700::double precision,-121.7000::double precision),
  (9,'San Francisco',17,39.5700::double precision,-121.3400::double precision), (9,'San Francisco',18,37.9500::double precision,-120.9800::double precision), (9,'San Francisco',19,38.1300::double precision,-122.9600::double precision), (9,'San Francisco',20,39.5700::double precision,-123.3200::double precision),
  (9,'San Francisco',21,36.5100::double precision,-120.8000::double precision), (9,'San Francisco',22,38.3100::double precision,-121.7000::double precision), (9,'San Francisco',23,37.4100::double precision,-121.3400::double precision), (9,'San Francisco',24,39.0300::double precision,-122.7800::double precision),
  (10,'Toronto',1,43.6500::double precision,-79.3800::double precision), (10,'Toronto',2,43.7700::double precision,-79.5000::double precision), (10,'Toronto',3,43.5300::double precision,-79.5000::double precision), (10,'Toronto',4,43.7700::double precision,-79.2600::double precision),
  (10,'Toronto',5,43.5300::double precision,-79.2600::double precision), (10,'Toronto',6,43.6500::double precision,-79.5000::double precision), (10,'Toronto',7,43.5300::double precision,-79.3800::double precision), (10,'Toronto',8,43.7700::double precision,-79.3800::double precision),
  (10,'Toronto',9,43.6500::double precision,-79.7400::double precision), (10,'Toronto',10,45.8100::double precision,-79.3800::double precision), (10,'Toronto',11,41.4900::double precision,-79.3800::double precision), (10,'Toronto',12,42.9300::double precision,-77.4000::double precision),
  (10,'Toronto',13,44.7300::double precision,-77.5800::double precision), (10,'Toronto',14,42.5700::double precision,-81.1800::double precision), (10,'Toronto',15,44.7300::double precision,-81.1800::double precision), (10,'Toronto',16,43.6500::double precision,-81.5400::double precision),
  (10,'Toronto',17,42.5700::double precision,-79.0200::double precision), (10,'Toronto',18,44.7300::double precision,-79.2000::double precision), (10,'Toronto',19,43.8300::double precision,-78.3000::double precision), (10,'Toronto',20,41.8500::double precision,-80.4600::double precision),
  (10,'Toronto',21,45.4500::double precision,-80.4600::double precision), (10,'Toronto',22,41.8500::double precision,-78.3000::double precision), (10,'Toronto',23,45.4500::double precision,-78.3000::double precision), (10,'Toronto',24,42.7500::double precision,-80.1000::double precision),
  (11,'São Paulo',1,-23.5500::double precision,-46.6300::double precision), (11,'São Paulo',2,-23.6700::double precision,-46.5100::double precision), (11,'São Paulo',3,-23.4300::double precision,-46.5100::double precision), (11,'São Paulo',4,-23.6700::double precision,-46.7500::double precision),
  (11,'São Paulo',5,-23.4300::double precision,-46.7500::double precision), (11,'São Paulo',6,-23.5500::double precision,-46.5100::double precision), (11,'São Paulo',7,-23.5500::double precision,-46.7500::double precision), (11,'São Paulo',8,-23.6700::double precision,-46.6300::double precision),
  (11,'São Paulo',9,-23.5500::double precision,-46.9900::double precision), (11,'São Paulo',10,-22.8300::double precision,-44.6500::double precision), (11,'São Paulo',11,-21.3900::double precision,-46.6300::double precision), (11,'São Paulo',12,-24.9900::double precision,-48.0700::double precision),
  (11,'São Paulo',13,-22.2900::double precision,-48.2500::double precision), (11,'São Paulo',14,-23.5500::double precision,-48.7900::double precision), (11,'São Paulo',15,-23.9100::double precision,-45.3700::double precision), (11,'São Paulo',16,-22.6500::double precision,-46.0900::double precision),
  (11,'São Paulo',17,-21.7500::double precision,-45.5500::double precision), (11,'São Paulo',18,-22.4700::double precision,-47.1700::double precision), (11,'São Paulo',19,-24.0900::double precision,-47.8900::double precision), (11,'São Paulo',20,-23.1900::double precision,-47.8900::double precision),
  (11,'São Paulo',21,-21.7500::double precision,-47.5300::double precision), (11,'São Paulo',22,-23.5500::double precision,-46.0900::double precision), (11,'São Paulo',23,-24.4500::double precision,-47.1700::double precision), (11,'São Paulo',24,-23.1900::double precision,-45.3700::double precision),
  (12,'Cape Town',1,-33.9200::double precision,18.4200::double precision), (12,'Cape Town',2,-33.8000::double precision,18.5400::double precision), (12,'Cape Town',3,-34.0400::double precision,18.5400::double precision), (12,'Cape Town',4,-34.0400::double precision,18.3400::double precision),
  (12,'Cape Town',5,-33.9200::double precision,18.5400::double precision), (12,'Cape Town',6,-34.0000::double precision,18.4200::double precision), (12,'Cape Town',7,-33.8000::double precision,18.4600::double precision), (12,'Cape Town',8,-33.8400::double precision,18.5000::double precision),
  (12,'Cape Town',9,-33.9200::double precision,18.7800::double precision), (12,'Cape Town',10,-31.7600::double precision,18.4200::double precision), (12,'Cape Town',11,-32.6600::double precision,20.0400::double precision), (12,'Cape Town',12,-34.4600::double precision,20.4000::double precision),
  (12,'Cape Town',13,-32.8400::double precision,17.8800::double precision), (12,'Cape Town',14,-33.5600::double precision,19.8600::double precision), (12,'Cape Town',15,-33.0200::double precision,18.9600::double precision), (12,'Cape Town',16,-32.1200::double precision,19.3200::double precision),
  (12,'Cape Town',17,-34.6400::double precision,19.5000::double precision), (12,'Cape Town',18,-32.4800::double precision,18.6000::double precision), (12,'Cape Town',19,-33.3800::double precision,18.2400::double precision), (12,'Cape Town',20,-33.2000::double precision,20.4000::double precision),
  (12,'Cape Town',21,-34.1000::double precision,19.6800::double precision), (12,'Cape Town',22,-33.9200::double precision,20.5800::double precision), (12,'Cape Town',23,-32.8400::double precision,19.5000::double precision), (12,'Cape Town',24,-34.2800::double precision,18.4200::double precision)
)
SELECT cluster, city || ' sample ' || i, latitude, longitude,
  (40 + i*7 + ((city_index*97 + i*13)%450))::double precision,
  CASE WHEN (city_index+i)%9=0 THEN 'Blocked' ELSE 'Allowed' END
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN coordinates CROSS JOIN generate_series(1,8) i
WHERE sample_index = i
UNION ALL
SELECT cluster, city || ' region sample ' || i, latitude, longitude,
  (30 + i*5 + ((city_index*71 + i*19)%440))::double precision,
  CASE WHEN (city_index+i)%11=0 THEN 'Blocked' ELSE 'Allowed' END
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN coordinates CROSS JOIN generate_series(1,16) i
WHERE sample_index = i + 8;

-- Additional globally distributed land-checked observations for the map.
-- They are synthetic coordinates, not clients or population estimates. They
-- are separate from the 288 named-city records used by the honeycomb.
CREATE TABLE gallery.geo_global_events (cluster text NOT NULL, label text NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL, requests double precision NOT NULL, status text NOT NULL);
INSERT INTO gallery.geo_global_events
WITH global_coordinates(sample_index,latitude,longitude) AS (VALUES
  (1,14.26::double precision,20.24::double precision),
  (2,-44.46::double precision,-72.51::double precision),
  (3,43.41::double precision,-106.06::double precision),
  (4,61.16::double precision,-107.30::double precision),
  (5,-21.40::double precision,23.42::double precision),
  (6,-45.86::double precision,166.88::double precision),
  (7,50.84::double precision,7.24::double precision),
  (8,-21.27::double precision,146.82::double precision),
  (9,50.08::double precision,49.01::double precision),
  (10,34.26::double precision,113.02::double precision),
  (11,51.01::double precision,67.94::double precision),
  (12,68.07::double precision,135.07::double precision),
  (13,-9.15::double precision,-60.69::double precision),
  (14,71.00::double precision,136.87::double precision),
  (15,66.65::double precision,148.01::double precision),
  (16,63.08::double precision,-146.53::double precision),
  (17,26.22::double precision,42.07::double precision),
  (18,37.38::double precision,129.25::double precision),
  (19,-29.81::double precision,24.00::double precision),
  (20,55.50::double precision,-77.20::double precision),
  (21,49.17::double precision,128.60::double precision),
  (22,54.34::double precision,61.94::double precision),
  (23,63.89::double precision,-145.32::double precision),
  (24,23.33::double precision,-11.27::double precision),
  (25,-8.70::double precision,-47.23::double precision),
  (26,35.13::double precision,-112.78::double precision),
  (27,35.81::double precision,114.31::double precision),
  (28,63.92::double precision,78.11::double precision),
  (29,61.49::double precision,105.59::double precision),
  (30,42.02::double precision,120.06::double precision),
  (31,-18.16::double precision,30.20::double precision),
  (32,21.05::double precision,-0.92::double precision),
  (33,70.17::double precision,120.70::double precision),
  (34,-41.51::double precision,-70.42::double precision),
  (35,49.75::double precision,103.30::double precision),
  (36,66.29::double precision,-108.84::double precision),
  (37,27.47::double precision,-10.91::double precision),
  (38,11.35::double precision,17.70::double precision),
  (39,46.75::double precision,58.38::double precision),
  (40,62.92::double precision,15.45::double precision),
  (41,55.85::double precision,-114.00::double precision),
  (42,61.33::double precision,-148.06::double precision),
  (43,61.38::double precision,48.85::double precision),
  (44,31.41::double precision,-102.26::double precision),
  (45,-27.62::double precision,141.05::double precision),
  (46,43.47::double precision,25.46::double precision),
  (47,30.53::double precision,12.47::double precision),
  (48,4.14::double precision,-59.33::double precision),
  (49,67.32::double precision,164.94::double precision),
  (50,41.88::double precision,-85.67::double precision),
  (51,65.87::double precision,117.66::double precision),
  (52,9.96::double precision,-65.54::double precision),
  (53,-33.13::double precision,138.43::double precision),
  (54,46.58::double precision,71.88::double precision),
  (55,13.08::double precision,108.91::double precision),
  (56,59.99::double precision,-131.89::double precision),
  (57,52.39::double precision,112.19::double precision),
  (58,48.43::double precision,131.76::double precision),
  (59,62.76::double precision,100.41::double precision),
  (60,49.59::double precision,-97.85::double precision),
  (61,37.36::double precision,78.68::double precision),
  (62,65.23::double precision,19.52::double precision),
  (63,40.54::double precision,17.16::double precision),
  (64,67.45::double precision,-93.07::double precision),
  (65,21.91::double precision,-11.94::double precision),
  (66,-7.33::double precision,108.81::double precision),
  (67,56.24::double precision,-4.65::double precision),
  (68,67.89::double precision,67.50::double precision),
  (69,36.57::double precision,60.00::double precision),
  (70,15.83::double precision,13.70::double precision),
  (71,64.95::double precision,69.51::double precision),
  (72,41.90::double precision,59.31::double precision),
  (73,47.68::double precision,37.66::double precision),
  (74,-20.60::double precision,142.80::double precision),
  (75,20.03::double precision,29.91::double precision),
  (76,57.71::double precision,-128.18::double precision),
  (77,34.57::double precision,5.13::double precision),
  (78,21.71::double precision,50.15::double precision),
  (79,68.24::double precision,23.14::double precision),
  (80,27.02::double precision,14.46::double precision),
  (81,64.46::double precision,-114.35::double precision),
  (82,37.61::double precision,-92.31::double precision),
  (83,60.41::double precision,134.20::double precision),
  (84,-9.12::double precision,16.16::double precision),
  (85,-1.21::double precision,-47.64::double precision),
  (86,-19.97::double precision,127.67::double precision),
  (87,-8.63::double precision,-40.20::double precision),
  (88,71.57::double precision,83.76::double precision),
  (89,36.09::double precision,79.68::double precision),
  (90,54.11::double precision,61.15::double precision),
  (91,48.84::double precision,21.33::double precision),
  (92,21.99::double precision,46.88::double precision),
  (93,-1.62::double precision,-52.78::double precision),
  (94,-21.53::double precision,145.08::double precision),
  (95,15.42::double precision,18.63::double precision),
  (96,10.15::double precision,106.70::double precision),
  (97,37.99::double precision,79.96::double precision),
  (98,35.27::double precision,-113.71::double precision),
  (99,-22.12::double precision,-45.14::double precision),
  (100,6.92::double precision,-77.43::double precision),
  (101,26.05::double precision,43.91::double precision),
  (102,57.85::double precision,70.11::double precision),
  (103,9.66::double precision,29.85::double precision),
  (104,55.30::double precision,92.74::double precision),
  (105,59.65::double precision,151.66::double precision),
  (106,-14.39::double precision,-55.29::double precision),
  (107,44.17::double precision,-108.68::double precision),
  (108,49.42::double precision,121.97::double precision),
  (109,61.15::double precision,119.28::double precision),
  (110,65.21::double precision,107.81::double precision),
  (111,6.60::double precision,-63.60::double precision),
  (112,54.63::double precision,55.59::double precision),
  (113,-32.74::double precision,-67.94::double precision),
  (114,24.15::double precision,117.10::double precision),
  (115,48.73::double precision,61.71::double precision),
  (116,23.73::double precision,54.44::double precision),
  (117,39.15::double precision,-114.82::double precision),
  (118,-31.68::double precision,124.18::double precision),
  (119,54.21::double precision,160.00::double precision),
  (120,66.71::double precision,153.59::double precision),
  (121,-14.94::double precision,26.61::double precision),
  (122,-30.22::double precision,-57.68::double precision),
  (123,28.73::double precision,-110.63::double precision),
  (124,55.89::double precision,86.33::double precision),
  (125,69.87::double precision,157.33::double precision),
  (126,43.74::double precision,113.61::double precision),
  (127,-22.74::double precision,146.08::double precision),
  (128,6.15::double precision,27.03::double precision),
  (129,-10.43::double precision,22.94::double precision),
  (130,42.52::double precision,104.33::double precision),
  (131,9.04::double precision,16.71::double precision),
  (132,19.14::double precision,49.02::double precision),
  (133,26.40::double precision,-3.78::double precision),
  (134,2.14::double precision,38.56::double precision),
  (135,46.79::double precision,-122.40::double precision),
  (136,44.19::double precision,-95.80::double precision),
  (137,-20.04::double precision,123.59::double precision),
  (138,50.47::double precision,89.36::double precision),
  (139,61.08::double precision,154.97::double precision),
  (140,50.71::double precision,-97.31::double precision),
  (141,50.57::double precision,14.49::double precision),
  (142,50.45::double precision,-111.33::double precision),
  (143,37.28::double precision,-79.06::double precision),
  (144,44.17::double precision,130.00::double precision)
)
SELECT cluster, 'Global land sample ' || lpad(sample_index::text, 3, '0'), latitude, longitude,
  (35 + (sample_index * 31 + CASE WHEN cluster = 'delta' THEN 17 ELSE 0 END) % 190)::double precision,
  CASE WHEN sample_index % 13 = 0 THEN 'Blocked' ELSE 'Allowed' END
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN global_coordinates;

-- Documentation-only network addresses and fictional ASNs, never customer data.
CREATE TABLE gallery.edge_destinations (cluster text NOT NULL, destination text NOT NULL, traffic_mbps double precision NOT NULL);
INSERT INTO gallery.edge_destinations
SELECT cluster, '192.0.2.' || (10+i)::text, (460.0 / (1 + i*0.36) + CASE WHEN cluster='delta' THEN 22 ELSE 0 END)::double precision
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN generate_series(1,10) i;

CREATE TABLE gallery.edge_sources (cluster text NOT NULL, source text NOT NULL, country text NOT NULL, risk double precision NOT NULL, status text NOT NULL);
INSERT INTO gallery.edge_sources
SELECT cluster, 'AS' || (64500+i)::text, (ARRAY['🇺🇸','🇨🇳','🇷🇺','🇩🇪','🇮🇳'])[i],
 (ARRAY[94.0,76.0,54.0,31.0,18.0])[i], (ARRAY['Blocking','Challenging','Monitoring','Allowed','Allowed'])[i]
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN generate_series(1,5) i;
CREATE TABLE gallery.edge_source_history (cluster text NOT NULL, source text NOT NULL, observed_at timestamptz NOT NULL, requests double precision NOT NULL);
INSERT INTO gallery.edge_source_history
SELECT s.cluster,s.source,date_trunc('minute',now())-(59-i)*interval '1 minute',
 (20 + s.risk + 12*sin(i::double precision/5+length(s.source)) + CASE WHEN i%17=0 THEN s.risk/2 ELSE 0 END)::double precision
FROM gallery.edge_sources s CROSS JOIN generate_series(0,59) i;
CREATE INDEX ON gallery.edge_source_history(cluster,source,observed_at);

CREATE TABLE gallery.edge_blocked_requests (cluster text NOT NULL, occurred_at timestamptz NOT NULL, source text NOT NULL, destination text NOT NULL, rule text NOT NULL, count bigint NOT NULL, status text NOT NULL);
INSERT INTO gallery.edge_blocked_requests
SELECT cluster, now()-i*interval '2 minutes', '198.51.100.'||(10+i)::text,
 '192.0.2.'||(10+(i%10))::text || ':443', (ARRAY['geo-block: country','rule: injection','rule: scanner-detect','geo-block: tor-exit'])[1+(i-1)%4],
 (15+i*7)::bigint, 'Blocked'
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN generate_series(1,24) i;
CREATE INDEX ON gallery.edge_blocked_requests(cluster,occurred_at);

-- Bounded stress scenario: >1,000 source rows per cluster with exact zero,
-- null, outliers and mixed states. Values are synthetic and deterministic.
CREATE TABLE gallery.stress_observations (cluster text NOT NULL, id text NOT NULL, observed_at timestamptz NOT NULL, latency_ms double precision, requests bigint NOT NULL, state text NOT NULL);
INSERT INTO gallery.stress_observations
SELECT cluster, 'sample-'||lpad(i::text,4,'0'), date_trunc('minute',now()) - (i%60)*interval '1 minute',
  CASE WHEN i%113=0 THEN NULL WHEN i%97=0 THEN 0 WHEN i%89=0 THEN 2400 ELSE (10+(i%150)*1.7)::double precision END,
  (i%101)::bigint, CASE WHEN i%31=0 THEN 'Failed' WHEN i%17=0 THEN 'Degraded' ELSE 'Healthy' END
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN generate_series(1,1320) i;
CREATE INDEX ON gallery.stress_observations(cluster,id);

CREATE TABLE gallery.sources (cluster text NOT NULL, source text NOT NULL, state text NOT NULL, freshness_seconds double precision NOT NULL, rows_processed bigint NOT NULL);
INSERT INTO gallery.sources
SELECT cluster, source, CASE WHEN i=5 AND cluster='omega' THEN 'Degraded' ELSE 'Healthy' END, CASE WHEN i=5 AND cluster='omega' THEN 42 ELSE i*3.5 END, (100000*i)::bigint
FROM (VALUES ('omega'),('delta')) c(cluster) CROSS JOIN (VALUES (1,'prometheus'),(2,'tempo'),(3,'shorted-api'),(4,'brandbrain'),(5,'market-sync')) s(i,source);

CREATE TABLE gallery.pipeline_edges (cluster text NOT NULL, source text NOT NULL, target text NOT NULL, items bigint NOT NULL, state text NOT NULL);
INSERT INTO gallery.pipeline_edges
SELECT cluster, source, target, items, state FROM (VALUES ('omega'),('delta')) c(cluster)
CROSS JOIN (VALUES ('collect','normalize',85000::bigint,'Healthy'),('normalize','enrich',82000,'Healthy'),('enrich','publish',77000,'Healthy'),('enrich','retry',1200,'Warning')) p(source,target,items,state);

CREATE TABLE gallery.jobs (cluster text NOT NULL, pipeline text NOT NULL, job text NOT NULL, started_at timestamptz NOT NULL, duration_ms bigint NOT NULL, state text NOT NULL, message text NOT NULL);
INSERT INTO gallery.jobs
SELECT CASE WHEN i%2=0 THEN 'omega' ELSE 'delta' END,
  (ARRAY['collect','normalize','enrich','publish'])[1+(i-1)%4], 'job-'||lpad(i::text,4,'0'),
  now()-i*interval '9 minutes', 200+(i*173)%11000,
  CASE WHEN i%11=0 THEN 'Failed' WHEN i%13=0 THEN 'Retrying' ELSE 'Succeeded' END,
  CASE WHEN i%11=0 THEN 'Synthetic upstream timeout' WHEN i%13=0 THEN 'Synthetic retry scheduled' ELSE 'Completed' END
FROM generate_series(1,160) i;

CREATE TABLE gallery.records (service text NOT NULL, cluster text NOT NULL, observed_at timestamptz NOT NULL, requests bigint NOT NULL, errors bigint NOT NULL, latency_ms double precision NOT NULL);
INSERT INTO gallery.records
SELECT s.service,s.cluster,date_trunc('minute',now())-(60-i)*interval '1 minute',
  (1000+i*13+length(s.service)*37)::bigint, (i%13)::bigint, round((36+i%17+length(s.service)*2)::numeric,2)::double precision
FROM gallery.services s CROSS JOIN generate_series(0,60) i;
CREATE INDEX ON gallery.records(cluster, service, observed_at);
