#!/usr/bin/env bash
# Local mirror of the ci.yml job "application-records" (Application records integration).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init application-records
export GOTOOLCHAIN=auto # ci.yml job env

CI_PG_CONTAINER="paprika-ci-pg-${PAPRIKA_CI_TREE12:-local}-$$"

# Removes the PostgreSQL container on exit, pass or fail (ci.yml services are torn down by GitHub).
ci_cleanup() {
  if [ -n "${CI_PG_CONTAINER:-}" ]; then
    docker rm -f "$CI_PG_CONTAINER" >/dev/null 2>&1 || true
  fi
}

# Upload application records evidence (ci.yml) -> copied on exit.
ci_collect artifacts/insights/application-records artifacts/insights/source-provenance

docker info >/dev/null 2>&1 || ci_die "Docker is not running; start Docker Desktop"

# ci.yml: services.postgres (postgres:16-alpine, same POSTGRES_* values). GitHub maps a random host
# port; here Docker picks a free loopback port and the job reads it back.
docker run -d --name "$CI_PG_CONTAINER" \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres -e POSTGRES_PASSWORD=paprika-local-test \
  -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
pg_id="$(docker inspect -f '{{.Id}}' "$CI_PG_CONTAINER")"
pg_port="$(docker port "$CI_PG_CONTAINER" 5432/tcp | head -1 | awk -F: '{print $NF}')"
# ci.yml health check is `pg_isready -U postgres -d postgres`. The TCP check here waits past the
# temporary init server, which accepts only local socket connections.
for _ in $(seq 1 60); do
  if docker exec "$CI_PG_CONTAINER" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$CI_PG_CONTAINER" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null ||
  ci_die "PostgreSQL did not become ready"

# ci.yml: Set up Go / Set up Node.js (22) -> snapshot, tools.sh and hack/ci/lib.sh.

# ci.yml: Install UI dependencies
(cd ui && npm ci)

# ci.yml: Install Chromium (--with-deps is Linux only; on macOS the browser alone is installed)
if [ "$(uname -s)" = Linux ]; then
  (cd ui && npx playwright install --with-deps chromium)
else
  (cd ui && npx playwright install chromium)
fi

# ci.yml: Verify PostgreSQL reader boundaries against a real database
export PAPRIKA_POSTGRES_TEST_DSN="postgres://postgres:paprika-local-test@127.0.0.1:${pg_port}/postgres?sslmode=disable"
go test -race ./internal/observabilitygateway/connector/postgresql -count=1 -timeout=90s

# ci.yml: Verify service queries with Prometheus and enforce live coverage
node --test hack/service-overview/*.test.mjs hack/shorted-queries/*.test.mjs ui/e2e/service-overview-coverage.test.mjs

# ci.yml: Verify independent source requirements in the example gallery
(cd ui && node e2e/run-insights.mjs e2e/insights-source-provenance.e2e.mjs)

# ci.yml: Verify authenticated application records through MCP and the browser
(
  cd ui
  export PAPRIKA_POSTGRES_CONTAINER="$pg_id" PAPRIKA_POSTGRES_PORT="$pg_port"
  node e2e/run-insights.mjs e2e/insights-application-records.e2e.mjs
)
