package main

import (
	"io"
	"strings"
	"testing"

	"github.com/go-logr/logr/funcr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestOperatorConsoleSwitch covers the empty --ui-bind-address switch that
// split-mode managers use to run without a console.
func TestOperatorConsoleSwitch(t *testing.T) {
	assert.False(t, operatorConsoleEnabled(""), "an empty ui-bind-address disables the console")
	assert.True(t, operatorConsoleEnabled(":3000"))
	assert.True(t, operatorConsoleEnabled("127.0.0.1:3000"))
}

func TestOperatorInlineWebhookSwitch(t *testing.T) {
	assert.False(t, operatorInlineWebhookEnabled(""), "an empty inline-webhook-bind-address disables /webhook on the manager")
	assert.True(t, operatorInlineWebhookEnabled(":8080"))
}

func TestIsLoopbackListenAddr(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:3000": true,
		"127.0.0.2:3000": true,
		"[::1]:3000":     true,
		"localhost:3000": true,
		":3000":          false,
		"0.0.0.0:3000":   false,
		"[::]:3000":      false,
		"10.0.0.5:3000":  false,
		"example.com:80": false,
		"no-port":        false,
		"":               false,
	}
	for addr, want := range cases {
		assert.Equal(t, want, isLoopbackListenAddr(addr), "addr %q", addr)
	}
}

// TestAuthDisabledBeyondLoopback pins the fail-safe predicate. The operator
// logs an error when it is true; the console still starts so the monolith
// default, `make run` and the kind e2e suite keep working.
func TestAuthDisabledBeyondLoopback(t *testing.T) {
	cases := []struct {
		name        string
		addr        string
		authEnabled bool
		want        bool
	}{
		{"wildcard with auth disabled is flagged", ":3000", false, true},
		{"explicit public address with auth disabled is flagged", "10.0.0.5:3000", false, true},
		{"loopback with auth disabled is not flagged", "127.0.0.1:3000", false, false},
		{"loopback ipv6 with auth disabled is not flagged", "[::1]:3000", false, false},
		{"wildcard with auth is not flagged", ":3000", true, false},
		{"loopback with auth is not flagged", "127.0.0.1:3000", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, authDisabledBeyondLoopback(tc.addr, tc.authEnabled))
		})
	}
}

// TestManagerListenerFlags checks that the empty values reach cliConfig through
// flag parsing and that the defaults still describe today's listeners.
func TestManagerListenerFlags(t *testing.T) {
	defaults, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, ":3000", defaults.UIAddr)
	assert.Equal(t, ":8080", defaults.InlineWebhookAddr)

	split, err := parseManagerConfig([]string{"--ui-bind-address=", "--inline-webhook-bind-address="}, io.Discard)
	require.NoError(t, err)
	assert.Empty(t, split.UIAddr)
	assert.Empty(t, split.InlineWebhookAddr)
	assert.False(t, operatorConsoleEnabled(split.UIAddr))
	assert.False(t, operatorInlineWebhookEnabled(split.InlineWebhookAddr))
}

func TestBuildInlineWebhookServerHonorsAddress(t *testing.T) {
	srv := buildInlineWebhookServer(nil, "127.0.0.1:9080", "secret")
	assert.Equal(t, "127.0.0.1:9080", srv.Addr)
	assert.Equal(t, ":8080", buildInlineWebhookServer(nil, ":8080", "secret").Addr)
}

// TestWarnConsoleAuthDisabled checks that the console authentication warning is
// logged by the shared helper that operator mode and api mode both call, and
// that it is only logged for a console with auth disabled on a non-loopback
// address.
func TestWarnConsoleAuthDisabled(t *testing.T) {
	cases := []struct {
		name        string
		addr        string
		authEnabled bool
		wantLogged  bool
	}{
		{"wildcard console with auth disabled is warned", ":3000", false, true},
		{"loopback console with auth disabled is not warned", "127.0.0.1:3000", false, false},
		{"wildcard console with auth enabled is not warned", ":3000", true, false},
	}
	const warning = "Operator console has authentication disabled and listens beyond loopback"
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out strings.Builder
			log := funcr.New(func(prefix, args string) {
				out.WriteString(prefix + args + "\n")
			}, funcr.Options{})
			warnConsoleAuthDisabled(log, tc.addr, tc.authEnabled)
			assert.Equal(t, tc.wantLogged, strings.Contains(out.String(), warning), "log output: %q", out.String())
		})
	}
}
