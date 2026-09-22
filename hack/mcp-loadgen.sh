#!/usr/bin/env bash
# Load generator: hammers read tools through the MCP endpoint.
#
# Requires an MCP access token (OAuth 2.1 + PKCE, aud=paprika-mcp) supplied
# via MCP_TOKEN or a file at MCP_TOKEN_FILE.
#
# Usage:
#   MCP_TOKEN=... BASE=http://localhost:13000 hack/mcp-loadgen.sh [seconds]
#   MCP_TOKEN_FILE=/tmp/mcp-token BASE=http://localhost:13000 hack/mcp-loadgen.sh 60
set -euo pipefail

BASE="${BASE:-http://localhost:13000}"
DURATION="${1:-60}"
TOOLS="${TOOLS:-fleet_status list_applications fleet_map}"

TOKEN="${MCP_TOKEN:-}"
if [[ -z "$TOKEN" && -n "${MCP_TOKEN_FILE:-}" && -f "$MCP_TOKEN_FILE" ]]; then
  TOKEN="$(cat "$MCP_TOKEN_FILE")"
fi
if [[ -z "$TOKEN" ]]; then
  echo "error: set MCP_TOKEN or MCP_TOKEN_FILE" >&2
  exit 1
fi

END=$((SECONDS + DURATION))
calls=0
fails=0
start=$(date +%s%N)
while (( SECONDS < END )); do
  for tool in $TOOLS; do
    if curl -sf -o /dev/null -X POST "$BASE/mcp" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":{}}}"; then
      calls=$((calls + 1))
    else
      fails=$((fails + 1))
    fi
  done
done
elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
echo "loadgen: ${calls} ok, ${fails} failed in ${elapsed}ms -> $(( calls * 1000 / elapsed )) calls/s" >&2
