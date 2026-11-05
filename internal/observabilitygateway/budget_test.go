package observabilitygateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

type budgetConnector struct {
	run func(context.Context) error
}

func (*budgetConnector) Descriptor() connector.Descriptor {
	return connector.Descriptor{Name: "budget", Signals: []connector.Signal{connector.SignalMetrics}}
}
func (*budgetConnector) ValidateConfig(json.RawMessage) error { return nil }
func (c *budgetConnector) Query(ctx context.Context, _ connector.QueryRequest) (*connector.QueryResult, error) {
	return &connector.QueryResult{State: connector.StateOK}, c.run(ctx)
}
func (c *budgetConnector) Explore(ctx context.Context, _ connector.ExploreRequest) (*connector.ExploreResult, error) {
	return &connector.ExploreResult{State: connector.StateOK}, c.run(ctx)
}

func budgetBackend(t *testing.T, budget *executionBudget, run func(context.Context) error) *k8sBackend {
	t.Helper()
	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(providerCR("obs", "prom", connector.ProviderPrometheus, nil)).Build()
	return &k8sBackend{client: cl, budget: budget, newConnector: func(string) (connector.Connector, error) {
		return &budgetConnector{run: run}, nil
	}}
}

func TestBackendDeadlineAndCancellation(t *testing.T) {
	t.Parallel()
	for _, operation := range []string{"query", "explore"} {
		t.Run(operation, func(t *testing.T) {
			b := budgetBackend(t, newExecutionBudget(1, 20*time.Millisecond), func(ctx context.Context) error {
				<-ctx.Done()
				return ctx.Err()
			})
			call := func(ctx context.Context) error {
				if operation == "query" {
					_, err := b.Query(ctx, "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
					return err
				}
				_, err := b.Explore(ctx, "obs/prom", connector.ExploreRequest{Kind: connector.ExploreMetricNames})
				return err
			}
			require.Equal(t, connect.CodeDeadlineExceeded, connect.CodeOf(call(context.Background())))
			require.Empty(t, b.budget.active, "deadline releases the active-work slot")
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			require.Equal(t, connect.CodeCanceled, connect.CodeOf(call(ctx)))
			require.Empty(t, b.budget.active)
		})
	}
}

func TestBackendConcurrencyLimitAndRecovery(t *testing.T) {
	t.Parallel()
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	b := budgetBackend(t, newExecutionBudget(1, time.Second), func(ctx context.Context) error {
		started <- struct{}{}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	first := make(chan error, 1)
	go func() {
		_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Query: "up"})
		first <- err
	}()
	<-started
	second := make(chan error, 1)
	go func() {
		_, err := b.Explore(context.Background(), "obs/prom", connector.ExploreRequest{Kind: connector.ExploreMetricNames})
		second <- err
	}()
	select {
	case err := <-second:
		t.Fatalf("queued exploration returned before capacity was released: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	require.NoError(t, <-first)
	require.NoError(t, <-second, "discovery should wait and use the shared work slot")
	_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Query: "up"})
	require.NoError(t, err, "a completed query frees capacity")
}

func TestExecutionBudgetPerProviderIsolation(t *testing.T) {
	b := newExecutionBudget(2, time.Second)
	b.perProvider = 1
	_, doneFirst, err := b.begin(t.Context(), "obs/hot")
	require.NoError(t, err)
	waiting := make(chan error, 1)
	go func() {
		_, done, err := b.begin(t.Context(), "obs/hot")
		if done != nil {
			done()
		}
		waiting <- err
	}()
	require.Eventually(t, func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		slots := b.providers["obs/hot"]
		return slots != nil && len(slots.waiting) == 1
	}, time.Second, time.Millisecond)
	_, doneOther, err := b.begin(t.Context(), "obs/independent")
	require.NoError(t, err, "a hot provider cannot take every global execution slot")
	doneOther()
	doneFirst()
	require.NoError(t, <-waiting)
	b.mu.Lock()
	defer b.mu.Unlock()
	require.Empty(t, b.providers, "finished work must release provider bulkheads")
}

func TestExecutionBudgetQueueBoundedAndCancellation(t *testing.T) {
	b := newExecutionBudget(1, time.Second)
	b.perProvider = 1
	b.perProviderWaiting = 1
	b.queueTimeout = time.Second
	_, done, err := b.begin(t.Context(), "obs/prom")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	waiting := make(chan error, 1)
	go func() {
		_, cleanup, err := b.begin(ctx, "obs/prom")
		if cleanup != nil {
			cleanup()
		}
		waiting <- err
	}()
	require.Eventually(t, func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		slots := b.providers["obs/prom"]
		return slots != nil && len(slots.waiting) == 1
	}, time.Second, time.Millisecond)
	_, _, err = b.begin(t.Context(), "obs/prom")
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err),
		"overflow rejects new work rather than growing unbounded")
	cancel()
	require.Equal(t, connect.CodeCanceled, connect.CodeOf(<-waiting))
	done()
	b.mu.Lock()
	require.Empty(t, b.providers)
	b.mu.Unlock()
	_, cleanup, err := b.begin(t.Context(), "obs/prom")
	require.NoError(t, err, "cancellation must free all queued and active permits")
	cleanup()
}

func TestExecutionBudgetQueueTimeout(t *testing.T) {
	b := newExecutionBudget(1, time.Second)
	b.perProvider = 1
	b.queueTimeout = 20 * time.Millisecond
	_, done, err := b.begin(t.Context(), "obs/prom")
	require.NoError(t, err)
	defer done()
	started := time.Now()
	_, _, err = b.begin(t.Context(), "obs/prom")
	require.Equal(t, connect.CodeDeadlineExceeded, connect.CodeOf(err))
	require.Less(t, time.Since(started), time.Second)
}

func TestExecutionBudgetKeepsEarlierDeadline(t *testing.T) {
	t.Parallel()
	b := newExecutionBudget(1, queryTimeout)
	deadline := time.Now().Add(time.Second)
	parent, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	ctx, done, err := b.begin(parent, "obs/prom")
	require.NoError(t, err)
	defer done()
	actual, ok := ctx.Deadline()
	require.True(t, ok)
	require.Equal(t, deadline, actual)
}

func TestBoundQueryRejectsUnboundedWork(t *testing.T) {
	t.Parallel()
	end := time.Now()
	for name, req := range map[string]connector.QueryRequest{
		"reversed":                   {Range: connector.TimeRange{Start: end, End: end.Add(-time.Minute)}},
		"equal":                      {Range: connector.TimeRange{Start: end, End: end}},
		"too wide":                   {Range: connector.TimeRange{Start: end.Add(-maxQueryWindow - time.Second), End: end}},
		"too many":                   {Limit: maxQueryResults + 1},
		"negative":                   {Limit: -1},
		"expression":                 {Query: strings.Repeat("x", maxQueryBytes+1)},
		"token without stable range": {PageToken: "opaque-next-page"}, //nolint:gosec // G101: a fixed noncredential pagination fixture.
		"oversized token":            {PageToken: strings.Repeat("x", 4097)},
	} {
		t.Run(name, func(t *testing.T) {
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(boundQuery(&req)))
		})
	}
	req := connector.QueryRequest{}
	require.NoError(t, boundQuery(&req))
	require.Equal(t, defaultQueryWindow, req.Range.End.Sub(req.Range.Start))
	require.Equal(t, 100, req.Limit)
}

func TestMissingConfiguredCredentialKeyNeverFallsBackToAmbientIdentity(t *testing.T) {
	t.Parallel()
	for _, data := range []map[string][]byte{nil, {"credentials": {}}, {"credentials": []byte(" \n")}} {
		secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: "obs", Name: "creds"}, Data: data}
		b, stub := newStubBackend(t, secret, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
			cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "creds"}
		}))
		_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Query: "up"})
		require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
		require.Nil(t, stub.gotCtx, "connector must never run with missing configured credentials")
	}
}

func TestUnsupportedProviderRejectsPageTokenBeforeCredentialRead(t *testing.T) {
	t.Parallel()
	b, stub := newStubBackend(t, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "must-not-be-read"}
	}))
	end := time.Now()
	_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Query: "up", PageToken: "opaque-next-page", Range: connector.TimeRange{Start: end.Add(-time.Minute), End: end}}) //nolint:gosec // G101: a fixed noncredential pagination fixture.
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	require.Nil(t, stub.gotCtx)
}

func TestToolsEnforceIntegerLimitsAndStablePaginationRange(t *testing.T) {
	t.Parallel()
	for _, tool := range []string{"query_metrics", "query_logs", "query_traces", "query_records"} {
		for _, suffix := range []string{`,"limit":1.5`, `,"limit":1001`, `,"limit":-1`, `,"limit":"10"`, `,"page_token":"next"`, `,"start":"2026-10-15T01:00:00Z","end":"2026-10-15T00:00:00Z"`, `,"start":"2026-09-13T00:00:00Z","end":"2026-10-15T00:00:00Z"`} {
			b := &fakeBackend{}
			reg := newRegisteredTools(t, b)
			_, err := invokeTool(t, reg, tool, `{"provider":"obs/prom","query":"up"`+suffix+`}`)
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), tool+suffix)
			require.Empty(t, b.lastProvider, "invalid input is rejected before backend work")
		}
		if tool == "query_records" {
			continue // Application/SQL frames do not expose provider-native pagination tokens.
		}
		b := &fakeBackend{queryResult: &connector.QueryResult{State: connector.StateOK}}
		reg := newRegisteredTools(t, b)
		_, err := invokeTool(t, reg, tool, `{"provider":"obs/prom","query":"up","limit":10,"page_token":"opaque-next","start":"2026-10-15T00:00:00Z","end":"2026-10-15T00:01:00Z"}`)
		require.NoError(t, err)
		require.Equal(t, "opaque-next", b.lastReq.PageToken)
		require.Equal(t, 10, b.lastReq.Limit)
	}
}
