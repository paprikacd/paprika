package insights

import (
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A gateway 429 keeps the scope it names, for each of the four limits.
func TestObserveHTTPErrorForKeepsEachLimitScope(t *testing.T) {
	t.Parallel()
	for _, scope := range []string{"edge", "budget", "provider", "queue"} {
		var remote *observeError
		require.ErrorAs(t, observeHTTPErrorFor(http.StatusTooManyRequests, "2", scope), &remote)
		assert.Equal(t, scope, remote.scope)
		assert.Equal(t, 2, remote.retryAfter)
	}
}

// An unknown or missing scope is dropped, so a gateway cannot put free text into the error.
func TestObserveHTTPErrorForDropsUnknownScope(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"", "gateway said hello", "EDGE"} {
		var remote *observeError
		require.ErrorAs(t, observeHTTPErrorFor(http.StatusTooManyRequests, "", value), &remote)
		assert.Empty(t, remote.scope, value)
	}
}

// A scope is kept only on a 429: other statuses never name one.
func TestObserveHTTPErrorForScopeOnlyOn429(t *testing.T) {
	t.Parallel()
	var remote *observeError
	require.ErrorAs(t, observeHTTPErrorFor(http.StatusServiceUnavailable, "", "provider"), &remote)
	assert.Empty(t, remote.scope)
}

// A rate-limited query carries its scope to the error class and the receipt.
func TestRateLimitedFailureCarriesLimitScope(t *testing.T) {
	t.Parallel()
	for _, scope := range []string{"edge", "budget", "provider", "queue"} {
		err := observeHTTPErrorFor(http.StatusTooManyRequests, "", scope)
		failure := classifyQueryFailure(err)
		assert.Equal(t, "rate_limited", failure.Code)
		assert.Equal(t, scope, failure.LimitScope)

		diagnostics := &QueryDiagnostics{}
		diagnostics.complete(nil, err)
		assert.Equal(t, "capacity", diagnostics.Outcome)
		assert.Equal(t, scope, diagnostics.LimitScope)
	}
}

// A local capacity refusal has no gateway scope.
func TestLocalCapacityRefusalHasNoLimitScope(t *testing.T) {
	t.Parallel()
	failure := classifyQueryFailure(errQueryCapacity)
	assert.Equal(t, "rate_limited", failure.Code)
	assert.Empty(t, failure.LimitScope)
}

// A gateway 5xx or an unreachable gateway is its own class, not provider_error.
func TestGatewayFailureHasItsOwnClass(t *testing.T) {
	t.Parallel()
	err := observeHTTPError(http.StatusBadGateway)
	failure := classifyQueryFailure(err)
	assert.Equal(t, "gateway_unavailable", failure.Code)
	assert.True(t, failure.transient)
	assert.True(t, transientQueryCodes[failure.Code] || failure.transient)

	var remote *observeError
	require.True(t, errors.As(err, &remote))
	assert.NotEqual(t, "provider_error", failure.Code)
}
