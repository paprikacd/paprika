package satellite

import (
	"context"
	"errors"
	"sync"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// Bundle is the last manifest set a satellite applied for one application.
//
// It is what makes autonomy possible: the control plane sends a bundle, the
// satellite applies it, and the same bundle is what the satellite keeps
// enforcing when it cannot reach the control plane. Anything richer — release
// history, rollback, promotion — stays on the control plane, because a
// satellite reconciling a half-understood release history is worse than one
// holding the last known-good state.
type Bundle struct {
	Namespace   string
	Application string
	Manifests   []byte
	AppliedAt   time.Time
}

// BundleStore persists bundles across restarts. A satellite that reboots during
// an outage must still know what it was enforcing.
type BundleStore interface {
	Put(ctx context.Context, bundle *Bundle) error
	List(ctx context.Context) ([]Bundle, error)
}

// Defaults for local reconciliation.
const (
	// DefaultFailoverTimeout is how long a Failover satellite waits without
	// control-plane contact before reconciling on its own. It is long enough to
	// ride out a rolling restart of the control plane and short enough that a
	// partition does not freeze a cluster for long.
	DefaultFailoverTimeout = 2 * time.Minute
	// DefaultAutonomyInterval bounds how often the satellite re-checks
	// connectivity and re-applies remembered bundles.
	DefaultAutonomyInterval = 30 * time.Second
	// overrideHoldWindow is how long a reconnect keeps reporting OverrideHeld
	// after local work. The control plane needs to see that the cluster changed
	// underneath it before the satellite claims to be a quiet follower again.
	overrideHoldWindow = 2 * time.Minute
)

// AutonomyConfig configures the satellite's own reconcile loop.
type AutonomyConfig struct {
	// Mode is the operator's autonomy selection.
	Mode clustersv1alpha1.AutonomyMode
	// FailoverTimeout is how long Failover waits before taking over.
	FailoverTimeout time.Duration
	// Interval is the reconcile and connectivity poll period.
	Interval time.Duration
	// Store holds the bundles to re-apply.
	Store BundleStore
	// Executor applies a bundle on this cluster.
	Executor TaskExecutor
	// Connected reports whether the control plane is reachable right now.
	Connected func() bool
	// Now overrides the clock in tests.
	Now func() time.Time
}

// Autonomy keeps a satellite's cluster convergent without the control plane.
//
// It is deliberately a poller rather than a controller-runtime manager: the
// satellite has no Application or Release objects to watch, only bundles it was
// told to apply, and a periodic re-apply is exactly the reconciliation those
// bundles describe. Watch-based drift detection would need the same manifests
// diffed against live state, which is work the control plane already does
// whenever it can be reached.
type Autonomy struct {
	cfg AutonomyConfig

	mu           sync.Mutex
	lastContact  time.Time
	state        clustersv1alpha1.SatelliteOperatingState
	overrideHeld bool
	heldUntil    time.Time
}

// NewAutonomy validates a configuration and returns the loop.
func NewAutonomy(cfg *AutonomyConfig) (*Autonomy, error) {
	if cfg.Store == nil && cfg.Mode.ReconcilesLocally() {
		return nil, errors.New("satellite autonomy requires a bundle store")
	}
	if cfg.Executor == nil && cfg.Mode.ReconcilesLocally() {
		return nil, errors.New("satellite autonomy requires an apply executor")
	}
	if cfg.Connected == nil {
		return nil, errors.New("satellite autonomy requires a connectivity check")
	}
	if cfg.FailoverTimeout <= 0 {
		cfg.FailoverTimeout = DefaultFailoverTimeout
	}
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultAutonomyInterval
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Autonomy{
		cfg: *cfg,
		// The grace window starts at process start. A zero lastContact would read
		// as "no contact for decades", so a Failover satellite would take over on
		// its first tick — reconciling and reporting an override on every boot —
		// before it had a chance to deliver a single report.
		lastContact: cfg.Now(),
		state:       clustersv1alpha1.SatelliteOperatingConnecting,
	}, nil
}

// State is what the satellite reports to the control plane.
//
// Transitions happen in the loop, so a report built between ticks carries the
// last decision rather than a value invented at report time.
func (a *Autonomy) State() clustersv1alpha1.SatelliteOperatingState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state
}

// Run reconciles until the context ends.
func (a *Autonomy) Run(ctx context.Context) error {
	ticker := time.NewTicker(a.cfg.Interval)
	defer ticker.Stop()
	for {
		a.Tick(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// Tick advances the state machine and, when the satellite owns reconciliation,
// re-applies every remembered bundle. It is exported for tests and for a
// caller that wants to drive the loop itself.
func (a *Autonomy) Tick(ctx context.Context) {
	now := a.cfg.Now()
	connected := a.cfg.Connected()
	logger := log.FromContext(ctx).WithValues("mode", a.cfg.Mode)

	autonomous := a.advance(now, connected)
	if !autonomous {
		return
	}

	bundles, err := a.cfg.Store.List(ctx)
	if err != nil {
		logger.Error(err, "Could not read remembered bundles")
		return
	}
	for i := range bundles {
		bundle := &bundles[i]
		if _, errs, applyErr := a.cfg.Executor.Apply(ctx, bundle.Namespace, bundle.Application, bundle.Manifests); applyErr != nil || len(errs) > 0 {
			logger.Error(applyErr, "Could not re-apply a remembered bundle",
				"namespace", bundle.Namespace, "application", bundle.Application, "errors", errs)
			continue
		}
		logger.V(1).Info("Re-applied a remembered bundle",
			"namespace", bundle.Namespace, "application", bundle.Application)
		a.recordLocalAction()
	}
}

// advance moves the state machine and reports whether this satellite is the one
// reconciling right now.
func (a *Autonomy) advance(now time.Time, connected bool) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	if connected {
		a.lastContact = now
		if a.overrideHeld {
			// Local work happened during the outage. Say so for a bounded window
			// rather than claiming a clean handover immediately: the control plane
			// has to notice before the next push overwrites it.
			a.state = clustersv1alpha1.SatelliteOperatingOverrideHeld
			if a.heldUntil.IsZero() {
				a.heldUntil = now.Add(overrideHoldWindow)
			}
			a.overrideHeld = false
			return a.cfg.Mode == clustersv1alpha1.AutonomyDelegated
		}
		if now.Before(a.heldUntil) {
			a.state = clustersv1alpha1.SatelliteOperatingOverrideHeld
			return a.cfg.Mode == clustersv1alpha1.AutonomyDelegated
		}
		a.state = clustersv1alpha1.SatelliteOperatingConnected
		return a.cfg.Mode == clustersv1alpha1.AutonomyDelegated
	}

	switch clustersv1alpha1.NormalizeAutonomyMode(a.cfg.Mode) {
	case clustersv1alpha1.AutonomyDelegated:
		// Delegated is not a fallback: the satellite reconciles either way, and a
		// link failure changes nothing locally.
		a.state = clustersv1alpha1.SatelliteOperatingAutonomous
		return true
	case clustersv1alpha1.AutonomyFailover:
		if now.Sub(a.lastContact) < a.cfg.FailoverTimeout {
			// Still inside the grace window: the control plane may just be
			// restarting, and two reconcilers must not run at once.
			a.state = clustersv1alpha1.SatelliteOperatingConnected
			return false
		}
		a.state = clustersv1alpha1.SatelliteOperatingAutonomous
		return true
	case clustersv1alpha1.AutonomyObserveOnly:
		// Never reconciles. Reporting Connecting while disconnected is the honest
		// answer: the operator asked this satellite to be a reporter only.
		a.state = clustersv1alpha1.SatelliteOperatingConnecting
		return false
	default:
		a.state = clustersv1alpha1.SatelliteOperatingConnecting
		return false
	}
}

func (a *Autonomy) recordLocalAction() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if clustersv1alpha1.NormalizeAutonomyMode(a.cfg.Mode) == clustersv1alpha1.AutonomyFailover {
		// Only Failover is "the control plane is away and I stepped in". A
		// Delegated satellite acting is not an override; it is the arrangement.
		a.overrideHeld = true
	}
}
