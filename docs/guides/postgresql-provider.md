# PostgreSQL dashboard data

The `postgresql` Observe connector executes one read-only SQL statement and
returns typed records or a metric projection. It connects to the database
through the Observe gateway; browsers and dashboard documents never receive
database credentials. An empty query performs a small `SELECT 1` health check
with the same credential and reader-role checks as normal queries.

## Configure a dedicated reader

Create a login with no superuser, role/database creation, replication or
row-security bypass privileges. Grant `CONNECT`, schema `USAGE` and `SELECT`
only on the tables or reporting views that dashboard users may read. For example,
an administrator can run the following, adapting the database and view names:

```sql
CREATE ROLE paprika_reader LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO paprika_reader;
GRANT USAGE ON SCHEMA reporting TO paprika_reader;
GRANT SELECT ON reporting.service_summary TO paprika_reader;
ALTER ROLE paprika_reader SET default_transaction_read_only = on;
```

Set the password using your database's secret-management workflow (for `psql`,
`\password paprika_reader` prompts without embedding it in SQL history).
The gateway rejects privileged role attributes, inherited or assumable
privileged roles, and memberships granting broad writes, server-file access,
server-program execution or administrative signaling. It checks these on every
query. Do not supply the application's writer or migration credentials.

The database grants are the access boundary. `search_path` controls resolution,
not authorization, so there is no `allowedSchemas` setting. Use schema-qualified
SQL and restrict grants. Reporting views can expose only approved columns and
aggregates. Review `EXECUTE` grants, extensions and `SECURITY DEFINER` functions:
read-only transactions prohibit ordinary database writes but do not sandbox all
possible external function effects. PostgreSQL documents the [read-only
transaction restrictions](https://www.postgresql.org/docs/current/sql-set-transaction.html)
and the capabilities of [predefined roles](https://www.postgresql.org/docs/current/predefined-roles.html).

Store exactly this JSON shape in the referenced Secret's `credentials` key:

```json
{"username":"paprika_reader","password":"<managed secret>"}
```

Label that Secret `observability.paprika.io/credentials: "true"`. Do not commit
the credential document. Register the provider with configuration such as:

```yaml
apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: reporting-postgresql
  namespace: observability
spec:
  type: postgresql
  config:
    host: db.example.com
    port: 5432
    database: app
    sslmode: verify-full
  credentialsSecretRef:
    name: reporting-postgresql-credentials
    key: credentials
```

`port` defaults to 5432 and `sslmode` to `verify-full`. TLS verifies the server
hostname and certificate using the gateway's system trust store, with TLS 1.2
or newer. Private certificate authorities must be trusted by that runtime.
There is no insecure verification override or arbitrary DSN. `disable` is
accepted only for a loopback test server; the connected peer is also checked
before sending database startup/authentication data. The connector does not load
`PG*` environment settings, `.pgpass`, service files or ambient client
certificates. See PostgreSQL's [TLS verification explanation](https://www.postgresql.org/docs/current/libpq-ssl.html).

## Queries and parameters

An unparameterized query is ordinary SQL:

```sql
SELECT service, requests, healthy
FROM reporting.service_summary
ORDER BY requests DESC
```

Use a JSON envelope for parameters or an explicit metric projection:

```json
{
  "sql": "SELECT observed_at AS time, service, requests::double precision AS value FROM reporting.service_history WHERE service = $1 AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz ORDER BY observed_at",
  "parameters": ["api", {"range":"start"}, {"range":"end"}],
  "projection": {"value":"value","time":"time","labels":["service"]}
}
```

Parameters are positional strings, numbers, booleans, null, or the exact objects
`{"range":"start"}` and `{"range":"end"}`. Range objects resolve to the query's
absolute start or end as UTC PostgreSQL timestamp bind values; no numeric epoch
unit conversion is needed. An absent referenced boundary or reversed range is an
error. SQL determines inclusivity: the example's `>=` and `<=` include both
endpoints. All values are sent as driver bind values and never concatenated into SQL. Placeholder
positions must exactly match the supplied array. Reusing `$1` is supported.
Raw SQL cannot contain unbound placeholders. Unknown envelope fields,
duplicate JSON keys, other nested parameter objects and unused parameters are rejected.

A saved-query template can put `{{service}}` in the envelope's `parameters`
array, where Paprika's existing typed parameter resolver emits a JSON value.
Keep `$1` in the SQL body. Do not put template expressions into quoted SQL
strings. Dashboard time ranges do not automatically rewrite SQL: use these
range objects with the desired comparison operators. Grafana macros and
arbitrary SQL transformations are not implemented.

Only a single `SELECT` or read-only `WITH` query is accepted. Data-modifying
CTEs, multiple statements, locking queries, session commands and known
side-effect functions are rejected. A trailing semicolon is accepted.
Backslash escape literals and Unicode-escaped identifiers are outside this
bounded SQL shape; use parameters for arbitrary text. Queries are always
prepared, wrapped with a row limit and executed inside `BEGIN READ ONLY`.
Every transaction is rolled back and its connection closed after the request.

## Record and metric shapes

The records signal returns a frame with `columns`, `rows` and optional
`truncated`. Column types are `string`, `number`, `boolean` and `timestamp`;
null is preserved. Timestamps use UTC RFC3339 strings. SQL arrays, binary data,
intervals and other unsupported types need an explicit SQL cast to text.

`NUMERIC`/`DECIMAL` columns are exact text. A bigint column containing values
outside JavaScript's exact integer range becomes text for every row. IDs and
precise decimal values are not silently rounded. Cast to `double precision`
only when an approximate numeric visualization is intended.

The metrics signal uses an explicit `projection` when supplied. Otherwise it
selects the numeric `value` column, or the sole numeric column, and recognizes
`time`, `timestamp` or `date` timestamp columns. Other string columns become
series labels. Ambiguous numeric/time columns require an explicit projection.
Without a time column, each row is an observation at query evaluation time;
the connector does not manufacture a sparkline. Duplicate series/timestamp
observations require aggregation in SQL or distinct projected labels. Null
numeric observations remain gaps. A records query rejects metric projection.

Limits are 100 rows by default, at most 1,000 rows, 64 columns, 16 KiB per text
cell and 4 MiB per frame. Reading one extra row determines `truncated`.
Oversized cells, non-finite numbers and unsupported types produce a fixed
diagnostic rather than altered values. There are at most four concurrent
PostgreSQL requests per gateway process, each using one connection. Statements
time out after five seconds, lock waits after one second, and the whole call,
including queueing and connection establishment, after ten seconds. These are
request limits, not a replacement for database resource administration. See
PostgreSQL's [statement and lock timeout settings](https://www.postgresql.org/docs/current/runtime-config-client.html).

Backend errors are classified but their raw SQL, endpoint, credentials and
server diagnostics are not returned to callers. This initial connector does not
provide schema exploration or continuation tokens.

## Local verification

Unit tests cover configuration, query shapes, typed parameter parsing,
sanitization, TLS refusal and value conversion. The integration test uses a
real PostgreSQL protocol connection, creates a temporary reader and schema,
and removes its own objects on completion. It only accepts an explicitly
configured literal loopback address:

```sh
PAPRIKA_POSTGRES_TEST_DSN='postgres://postgres:<local-test-password>@127.0.0.1:<port>/postgres?sslmode=disable' \
  go test ./internal/observabilitygateway/connector/postgresql -count=1
```

Use an isolated local database/container. Integration coverage includes real
parameter binding, read-only and privileged-role enforcement, a refused write
inside a security-definer function, exact decimal/bigint results, metric gaps,
result limits, cancellation, lock/statement timeouts and connection cleanup.
This test does not provision production credentials or demonstrate access to
any particular deployment's database.
