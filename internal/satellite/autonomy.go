package satellite

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
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
		cfg:   *cfg,
		state: clustersv1alpha1.SatelliteOperatingConnecting,
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

// RecordingExecutor remembers every bundle a satellite applies, including the
// ones the control plane pushed over the link.
type RecordingExecutor struct {
	Inner TaskExecutor
	Store BundleStore
	Now   func() time.Time
}

// Apply runs the bundle and remembers it when the apply succeeded.
func (e *RecordingExecutor) Apply(ctx context.Context, namespace, appName string, manifests []byte) (applied int, errs []string, err error) {
	if e.Inner == nil {
		return 0, nil, errors.New("satellite has no apply executor")
	}
	applied, errs, err = e.Inner.Apply(ctx, namespace, appName, manifests)
	if err != nil {
		return applied, errs, fmt.Errorf("apply bundle: %w", err)
	}
	if len(errs) > 0 {
		return applied, errs, nil
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	if storeErr := e.Store.Put(ctx, &Bundle{
		Namespace: namespace, Application: appName, Manifests: manifests, AppliedAt: now(),
	}); storeErr != nil {
		// The apply already happened; losing the record only costs autonomy for
		// this application, so report it without failing the task.
		log.FromContext(ctx).Error(storeErr, "Could not remember an applied bundle",
			"namespace", namespace, "application", appName)
	}
	return applied, errs, nil
}

// ConfigMapBundleStore keeps bundles in a ConfigMap in the satellite's own
// namespace. A ConfigMap is enough: one value per application, written on every
// successful apply, and readable after a restart without mounting a volume.
type ConfigMapBundleStore struct {
	client    kubernetes.Interface
	namespace string
	name      string
}

// NewConfigMapBundleStore returns a store backed by one ConfigMap.
func NewConfigMapBundleStore(client kubernetes.Interface, namespace, name string) *ConfigMapBundleStore {
	return &ConfigMapBundleStore{client: client, namespace: namespace, name: name}
}

// bundleKey is a ConfigMap-safe key for one application.
func bundleKey(bundle *Bundle) string {
	return bundle.Namespace + "." + bundle.Application
}

// Put records the bundle for one application.
func (s *ConfigMapBundleStore) Put(ctx context.Context, bundle *Bundle) error {
	key := bundleKey(bundle)
	configMaps := s.client.CoreV1().ConfigMaps(s.namespace)
	existing, err := configMaps.Get(ctx, s.name, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("read satellite bundle store: %w", err)
		}
		_, createErr := configMaps.Create(ctx, bundleConfigMap(s.namespace, s.name, key, bundle.Manifests), metav1.CreateOptions{})
		if createErr == nil {
			return nil
		}
		if !apierrors.IsAlreadyExists(createErr) {
			return fmt.Errorf("create satellite bundle store: %w", createErr)
		}
		// Another writer created it first; fall through to the update path.
		existing, err = configMaps.Get(ctx, s.name, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("re-read satellite bundle store: %w", err)
		}
	}
	if existing.Data == nil {
		existing.Data = map[string]string{}
	}
	existing.Data[key] = string(bundle.Manifests)
	if _, err := configMaps.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update satellite bundle store: %w", err)
	}
	return nil
}

// List returns every remembered bundle.
func (s *ConfigMapBundleStore) List(ctx context.Context) ([]Bundle, error) {
	configMap, err := s.client.CoreV1().ConfigMaps(s.namespace).Get(ctx, s.name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read satellite bundle store: %w", err)
	}
	bundles := make([]Bundle, 0, len(configMap.Data))
	for key, manifests := range configMap.Data {
		namespace, application, ok := splitBundleKey(key)
		if !ok {
			continue
		}
		bundles = append(bundles, Bundle{Namespace: namespace, Application: application, Manifests: []byte(manifests)})
	}
	return bundles, nil
}

// bundleConfigMap is the store's object shape. One ConfigMap key per
// application keeps updates independent: an apply for one application does not
// rewrite another's bundle.
func bundleConfigMap(namespace, name, key string, manifests []byte) *corev1.ConfigMap {
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "paprika-satellite",
			},
		},
		Data: map[string]string{key: string(manifests)},
	}
}

// splitBundleKey parses "<namespace>.<application>". Namespaces and names are
// both DNS labels and never contain a dot, so the first dot is the separator.
func splitBundleKey(key string) (namespace, application string, ok bool) {
	for i := 0; i < len(key); i++ {
		if key[i] == '.' {
			return key[:i], key[i+1:], true
		}
	}
	return "", "", false
}
