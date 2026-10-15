package observabilitygateway

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/go-logr/logr"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// StatusProber periodically probes every ObservabilityProvider visible to the
// gateway and writes the verdict onto the CR's status — State, Reason,
// ObservedGeneration and a Ready condition — so the console's provider board
// and `kubectl get` show reachability without anyone running a query.
// Probing reuses the catalog's per-type health probe (the cheapest read each
// backend accepts) and the backend's credential resolution, so status
// reflects exactly what a query would experience.
type StatusProber struct {
	client   client.Client
	backend  *k8sBackend
	interval time.Duration
	timeout  time.Duration // per-probe deadline
	workers  int
	log      logr.Logger
}

// StatusProberOption tunes one knob of a StatusProber.
type StatusProberOption func(*StatusProber)

// NewStatusProber builds the prober over c. Connector construction goes
// through the package registry exactly as a query does, so a status verdict
// is the answer to "what would query_provider experience right now".
func NewStatusProber(c client.Client, opts ...StatusProberOption) *StatusProber {
	p := &StatusProber{
		client:   c,
		backend:  &k8sBackend{client: c},
		interval: 5 * time.Minute,
		timeout:  10 * time.Second,
		workers:  4,
		log:      logr.Discard(),
	}
	for _, opt := range opts {
		opt(p)
	}
	if p.workers < 1 {
		p.workers = 1
	}
	return p
}

// WithProbeInterval sets how often every registered provider is probed.
func WithProbeInterval(d time.Duration) StatusProberOption {
	return func(p *StatusProber) { p.interval = d }
}

// WithProbeTimeout sets the per-probe deadline.
func WithProbeTimeout(d time.Duration) StatusProberOption {
	return func(p *StatusProber) { p.timeout = d }
}

// WithProbeWorkers sets the number of providers probed concurrently.
func WithProbeWorkers(n int) StatusProberOption {
	return func(p *StatusProber) { p.workers = n }
}

// WithProberLogger sets the logger the prober reports its cycles on.
func WithProberLogger(l logr.Logger) StatusProberOption {
	return func(p *StatusProber) { p.log = l }
}

// Run probes every provider immediately, then on a ticker until ctx ends.
// ctx cancellation returns cleanly; a failed cycle is logged and the next
// tick retries — a transient LIST error must not stop status writes.
func (p *StatusProber) Run(ctx context.Context) {
	p.log.Info("observability provider status prober started",
		"interval", p.interval.String(), "timeout", p.timeout.String(), "workers", p.workers)
	p.cycle(ctx)
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.cycle(ctx)
		}
	}
}

// cycle runs one probe round and logs the outcome; Run owns the retry policy.
func (p *StatusProber) cycle(ctx context.Context) {
	if err := p.runOnce(ctx); err != nil {
		p.log.Error(err, "observability provider status probe cycle failed")
	}
}

// runOnce lists every ObservabilityProvider and fans the probes out across
// the worker pool. It returns an error only when the LIST fails; per-provider
// probe and patch failures are logged and counted into the cycle summary,
// never failing the cycle.
func (p *StatusProber) runOnce(ctx context.Context) error {
	var list observabilityv1alpha1.ObservabilityProviderList
	if err := p.client.List(ctx, &list); err != nil {
		return fmt.Errorf("list observability providers: %w", err)
	}

	jobs := make(chan *observabilityv1alpha1.ObservabilityProvider)
	var wg sync.WaitGroup
	var mu sync.Mutex
	states := map[connector.State]int{}
	writeFailures := 0

	worker := func() {
		defer wg.Done()
		for cr := range jobs {
			state, reason := p.probeProvider(ctx, cr)
			if err := p.writeStatus(ctx, cr, state, reason); err != nil {
				p.log.Error(err, "failed to write observability provider status",
					"provider", cr.Namespace+"/"+cr.Name)
				mu.Lock()
				writeFailures++
				mu.Unlock()
				continue
			}
			mu.Lock()
			states[state]++
			mu.Unlock()
		}
	}

	wg.Add(p.workers)
	for i := 0; i < p.workers; i++ {
		go worker()
	}
feed:
	for i := range list.Items {
		cr := list.Items[i].DeepCopy()
		select {
		case jobs <- cr:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()

	p.log.Info("observability provider status probe cycle complete",
		"providers", len(list.Items), "states", states, "writeFailures", writeFailures)
	return nil
}

// probeProvider runs the catalog's health probe for one CR and reduces the
// outcome to the state/reason pair status carries. Credential resolution
// failure is a NotConfigured verdict, not an error: the provider is missing
// something the operator must supply. A probe error is a deployment bug
// (unknown type, or no connector for a catalog type in this build) and maps
// onto the same closed sentence the validate endpoint reports. Backend
// detail never reaches status — runProbe's finishQuery keeps the raw error
// in the log, exactly as backend.Query does for tool calls.
func (p *StatusProber) probeProvider(ctx context.Context, cr *observabilityv1alpha1.ObservabilityProvider) (connector.State, string) {
	credentials, err := p.backend.resolveCredentials(ctx, cr)
	if err != nil {
		return connector.StateNotConfigured, reasonNotConfigured
	}
	pctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	result, err := runProbe(pctx, cr.Spec.Type, cr.Spec.Config.Raw, credentials)
	if err != nil {
		return connector.StateError, reasonProviderTypeUnavailable
	}
	return result.State, result.Reason
}

// writeStatus patches the verdict onto the CR's status subresource. Nothing
// is written when the status already matches: an unchanged patch would churn
// etcd and wake every watcher for no information. The Ready condition mirrors
// State (True only on OK) with the state as its reason, so
// `kubectl wait --for=condition=Ready` works against providers.
func (p *StatusProber) writeStatus(ctx context.Context, cr *observabilityv1alpha1.ObservabilityProvider, state connector.State, reason string) error {
	updated := cr.DeepCopy()
	updated.Status.State = string(state)
	updated.Status.Reason = reason
	updated.Status.ObservedGeneration = cr.Generation

	conditionStatus := metav1.ConditionFalse
	if state == connector.StateOK {
		conditionStatus = metav1.ConditionTrue
	}
	meta.SetStatusCondition(&updated.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             conditionStatus,
		Reason:             string(state),
		Message:            reason,
		ObservedGeneration: cr.Generation,
		LastTransitionTime: metav1.Now(),
	})

	if apiequality.Semantic.DeepEqual(cr.Status, updated.Status) {
		return nil
	}
	patch := client.MergeFrom(cr.DeepCopy())
	return p.client.Status().Patch(ctx, updated, patch)
}
