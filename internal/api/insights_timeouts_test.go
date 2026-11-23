package apiserver

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// Each hop must give up before the hop outside it, so the component that owns
// the work fails first. From outside in: the API proxy's whole-request deadline,
// its response-header wait, the Insights query budget, and one gateway operation.
// The gateway call inside an operation gets the operation less a margin
// (observe_rest.go), so the gateway deadline ends before the operation does.
func TestInsightsTimeoutsNestOuterToInner(t *testing.T) {
	require.Greater(t, insightsProxyContextTimeout, insightsProxyHeaderTimeout)
	require.Greater(t, insightsProxyHeaderTimeout, insights.DashboardQueryBudget)
	require.Greater(t, insights.DashboardQueryBudget, insights.ObserveOperationTimeout)
}

// Insights and the gateway name the budget header independently. The two names
// must match, or the gateway silently keeps its 30 s default.
func TestObserveBudgetHeaderNameMatchesTheGateway(t *testing.T) {
	require.Equal(t, observabilitygateway.ObserveBudgetHeader, insights.ObserveBudgetHeader)
}
