package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benebsworth/paprika/internal/version"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPrincipalRateLimiter_BurstThenRefuse(t *testing.T) {
	l := newPrincipalRateLimiter()
	for i := 0; i < mcpRateBurst; i++ {
		require.True(t, l.Allow("alice"), "request %d within burst should pass", i)
	}
	assert.False(t, l.Allow("alice"), "burst exhausted should refuse")
	// Another subject has an independent bucket.
	assert.True(t, l.Allow("bob"))
}

func TestPrincipalRateLimiter_SweepEvictsIdle(t *testing.T) {
	l := newPrincipalRateLimiter()
	now := time.Now()
	l.now = func() time.Time { return now }

	for i := 0; i < mcpLimiterSweepAt; i++ {
		l.Allow(fmt.Sprintf("subject-%d", i))
	}
	// Force a sweep by pushing past the threshold; entries older than the
	// TTL must go, recent ones must stay.
	l.Allow("recent")
	now = now.Add(mcpLimiterIdleTTL + time.Second)
	l.lims["recent"].lastSeen = now // keep it fresh

	for i := 0; i < mcpLimiterSweepAt+1; i++ {
		l.Allow(fmt.Sprintf("new-%d", i)) // triggers sweep on each oversized insert
	}
	_, evicted := l.lims["subject-0"]
	assert.False(t, evicted, "idle entries should be swept")
	_, kept := l.lims["recent"]
	assert.True(t, kept, "active entries survive the sweep")
}

func TestServeHTTP_RateLimited(t *testing.T) {
	srv := newTestServer(t)
	srv.rateLimit.per = 1
	srv.rateLimit.burst = 1
	token := bearerFor(t, ScopeRead)

	call := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp",
			strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+token)
		srv.Handler().ServeHTTP(rec, req)
		return rec
	}

	require.Equal(t, http.StatusOK, call().Code, "first request passes")
	require.Equal(t, http.StatusTooManyRequests, call().Code, "over-limit request rejected")
}

func TestServeHTTP_RejectsOversizedBody(t *testing.T) {
	srv := newTestServer(t)
	token := bearerFor(t, ScopeRead)

	big := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"` +
		strings.Repeat("x", (1<<20)+10) + `"}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp", big)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	srv.Handler().ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusOK, rec.Code, "oversized body must not reach tool dispatch")
}

func TestInitializeAdvertisesBuildVersion(t *testing.T) {
	srv := newTestServer(t)
	resp := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}`,
		bearerFor(t, ScopeRead))

	var out struct {
		Result struct {
			ServerInfo struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(resp, &out))
	assert.Equal(t, "paprika", out.Result.ServerInfo.Name)
	// The advertised version is the build identity, not a hardcoded constant.
	assert.Equal(t, version.Version, out.Result.ServerInfo.Version)
}
