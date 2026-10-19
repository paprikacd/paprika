package satellite

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	mathrand "math/rand/v2"
	"reflect"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"sigs.k8s.io/controller-runtime/pkg/log"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/version"
)

var applicationResource = schema.GroupVersionResource{Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "applications"}

// Collector watches the local Kubernetes API once, retaining compact state and
// coalescing updates into bounded application delta reports. Core informers use
// Kubernetes watch reconnection/relist semantics; outbound failures never cause
// additional Kubernetes polling or an unbounded queue.
type Collector struct {
	core                          kubernetes.Interface
	dynamic                       dynamic.Interface
	config                        Config
	client                        Sender
	state                         *observationState
	factory                       informers.SharedInformerFactory
	coreSynced                    []cache.InformerSynced
	clusterUID, kubernetesVersion string
	ready                         atomic.Bool
	applicationProbeInterval      time.Duration
	coreWatchErrors               chan error
}

// NewCollector prepares a satellite without making Kubernetes API requests.
//
//nolint:gocritic // The collector owns a configuration value; caller mutations must not change a running satellite.
func NewCollector(core kubernetes.Interface, dyn dynamic.Interface, config Config) (*Collector, error) {
	if core == nil {
		return nil, errors.New("satellite Kubernetes client is required")
	}
	if err := normalizeCollectorConfig(&config); err != nil {
		return nil, err
	}
	client, err := newSender(&config)
	if err != nil {
		return nil, err
	}
	c := &Collector{core: core, dynamic: dyn, config: config, client: client, state: newObservationState(), applicationProbeInterval: 30 * time.Second, coreWatchErrors: make(chan error, 1)}
	c.factory = informers.NewSharedInformerFactory(&observedKubernetes{Interface: core, fail: func(err error) { c.coreWatchError(nil, err) }}, 0)
	if err := c.configureCoreInformers(); err != nil {
		client.Close()
		return nil, err
	}
	return c, nil
}

func normalizeCollectorConfig(config *Config) error {
	if err := validateRegistration(config); err != nil {
		return err
	}
	if config.HeartbeatInterval == 0 {
		config.HeartbeatInterval = 30 * time.Second
	}
	if config.BatchInterval == 0 {
		config.BatchInterval = 2 * time.Second
	}
	if config.HeartbeatInterval < 100*time.Millisecond || config.BatchInterval < 100*time.Millisecond {
		return errors.New("satellite heartbeat and batch intervals must be at least 100ms")
	}
	return nil
}

func validateRegistration(config *Config) error {
	if config.ClusterName == "" || config.ClusterNamespace == "" {
		return errors.New("satellite cluster name and registration namespace are required")
	}
	if len(validation.IsDNS1123Subdomain(config.ClusterName)) != 0 || len(config.ClusterName) > 63 || len(validation.IsDNS1123Label(config.ClusterNamespace)) != 0 {
		return errors.New("satellite cluster name and registration namespace must be valid Kubernetes names")
	}
	if len(config.DisplayName) > 256 {
		return errors.New("satellite display name must not exceed 256 bytes")
	}
	return nil
}

func (c *Collector) configureCoreInformers() error {
	watched := []cache.SharedIndexInformer{
		c.factory.Core().V1().Nodes().Informer(),
		c.factory.Core().V1().Pods().Informer(),
		c.factory.Core().V1().Namespaces().Informer(),
		c.factory.Apps().V1().Deployments().Informer(),
		c.factory.Apps().V1().StatefulSets().Informer(),
		c.factory.Apps().V1().DaemonSets().Informer(),
	}
	for _, informer := range watched {
		synced, attachErr := c.attach(informer)
		if attachErr != nil {
			return attachErr
		}
		c.coreSynced = append(c.coreSynced, synced)
		if err := informer.SetWatchErrorHandler(c.coreWatchError); err != nil {
			return fmt.Errorf("configure satellite core watch errors: %w", err)
		}
	}
	return nil
}

func (c *Collector) attach(informer cache.SharedIndexInformer) (cache.InformerSynced, error) {
	if err := informer.SetTransform(compactObject); err != nil {
		return nil, fmt.Errorf("configure satellite cache transform: %w", err)
	}
	registration, err := informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    c.state.upsert,
		UpdateFunc: func(_, current any) { c.state.upsert(current) },
		DeleteFunc: c.state.delete,
	})
	if err != nil {
		return nil, fmt.Errorf("configure satellite watch handler: %w", err)
	}
	// Handler synchronization, rather than only informer synchronization,
	// guarantees all initial events are projected before the first snapshot.
	return registration.HasSynced, nil
}

// Run serves until the context is cancelled. Initial cache synchronization is
// mandatory for core inventory and workloads. An absent Paprika CRD is optional
// and is probed periodically so installing it later requires no agent restart.
func (c *Collector) Run(ctx context.Context) error {
	defer c.ready.Store(false)
	defer c.client.Close()
	if err := c.identify(ctx); err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	watchFailure := c.monitorCoreFailures(runCtx, cancel)
	c.factory.Start(runCtx.Done())
	optionalReady := make(chan struct{})
	optionalDone := make(chan struct{})
	go func() { defer close(optionalDone); c.runOptionalApplications(runCtx, optionalReady) }()
	metricsDone := make(chan struct{})
	go func() { defer close(metricsDone); c.runOptionalNodeMetrics(runCtx) }()
	defer func() { cancel(); c.factory.Shutdown(); <-optionalDone; <-metricsDone }()
	if !cache.WaitForCacheSync(runCtx.Done(), c.coreSynced...) {
		if ctx.Err() != nil {
			return nil
		}
		return watchResult(errors.New("satellite core inventory caches did not synchronize"), watchFailure)
	}
	select {
	case <-optionalReady:
	case <-runCtx.Done():
		return watchResult(nil, watchFailure)
	}
	if runCtx.Err() != nil {
		return watchResult(nil, watchFailure)
	}
	c.ready.Store(true)
	return watchResult(c.publish(runCtx), watchFailure)
}

func (c *Collector) identify(ctx context.Context) error {
	identity, err := c.core.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("read stable satellite cluster identity: %w", err)
	}
	if identity.UID == "" {
		return errors.New("kube-system namespace has no stable UID")
	}
	c.clusterUID = string(identity.UID)
	if serverVersion, versionErr := c.core.Discovery().ServerVersion(); versionErr == nil && serverVersion != nil {
		c.kubernetesVersion = serverVersion.GitVersion
	}
	return nil
}

func (c *Collector) monitorCoreFailures(ctx context.Context, cancel context.CancelFunc) <-chan error {
	failures := make(chan error, 1)
	go func() {
		select {
		case err := <-c.coreWatchErrors:
			failures <- err
			c.ready.Store(false)
			cancel()
		case <-ctx.Done():
		}
	}()
	return failures
}

func watchResult(err error, failures <-chan error) error {
	select {
	case failure := <-failures:
		return failure
	default:
		return err
	}
}

func (c *Collector) coreWatchError(_ *cache.Reflector, err error) {
	// Watch timeouts and expired resource versions are routine Kubernetes
	// relist signals. Other failures can make previously synced caches stale;
	// stop reporting until a fresh process establishes complete baselines.
	if routineWatchError(err) {
		return
	}
	c.ready.Store(false)
	select {
	case c.coreWatchErrors <- errors.New("satellite local Kubernetes watch failed; a fresh snapshot is required"):
	default:
	}
}

func routineWatchError(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) || apierrors.IsResourceExpired(err) || apierrors.IsGone(err)
}

// Ready reports that local watch caches have synchronized. Central connectivity
// does not change readiness because the agent continues collecting while the
// control plane is unavailable.
func (c *Collector) Ready() bool { return c.ready.Load() }

func (c *Collector) runOptionalApplications(ctx context.Context, ready chan<- struct{}) {
	var once sync.Once
	markReady := func() { once.Do(func() { close(ready) }) }
	defer markReady()
	if c.dynamic == nil {
		return
	}
	for ctx.Err() == nil {
		if !c.discoverApplications(ctx) {
			markReady()
			if !waitContext(ctx, c.applicationProbeInterval) {
				return
			}
			continue
		}
		if !c.watchOptionalApplications(ctx, markReady) {
			return
		}
		if !waitContext(ctx, c.applicationProbeInterval) {
			return
		}
	}
}

func (c *Collector) discoverApplications(ctx context.Context) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.dynamic.Resource(applicationResource).Namespace(metav1.NamespaceAll).List(probeCtx, metav1.ListOptions{Limit: 1})
	if err != nil && !optionalUnavailable(err) {
		log.FromContext(ctx).Info("Satellite application discovery will retry")
	}
	return err == nil
}

func (c *Collector) watchOptionalApplications(ctx context.Context, markReady func()) bool {
	watchCtx, stop := context.WithCancel(ctx)
	defer stop()
	unavailable := make(chan struct{}, 1)
	failed := func(watchErr error) {
		if routineWatchError(watchErr) {
			return
		}
		select {
		case unavailable <- struct{}{}:
		default:
		}
		stop()
	}
	informer := c.optionalInformer(failed)
	synced, err := c.attach(informer)
	if err != nil {
		markReady()
		return false
	}
	if err := informer.SetWatchErrorHandler(func(_ *cache.Reflector, watchErr error) { failed(watchErr) }); err != nil {
		markReady()
		return false
	}
	done := make(chan struct{})
	go func() { defer close(done); informer.Run(watchCtx.Done()) }()
	defer func() { stop(); <-done }()
	cache.WaitForCacheSync(watchCtx.Done(), synced)
	markReady()
	select {
	case <-ctx.Done():
		return false
	case <-unavailable:
		stop()
		<-done
		c.state.clearApplications()
		return true
	}
}

func (c *Collector) optionalInformer(failed func(error)) cache.SharedIndexInformer {
	resource := c.dynamic.Resource(applicationResource).Namespace(metav1.NamespaceAll)
	return cache.NewSharedIndexInformer(cache.ToListWatcherWithWatchListSemantics(&cache.ListWatch{
		ListWithContextFunc: func(ctx context.Context, options metav1.ListOptions) (runtime.Object, error) {
			result, err := resource.List(ctx, options)
			observeError(ctx, err, failed)
			if err != nil {
				return result, fmt.Errorf("list satellite applications: %w", err)
			}
			return result, nil
		},
		WatchFuncWithContext: func(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
			result, err := resource.Watch(ctx, options)
			return observeWatch(ctx, result, err, failed)
		},
	}, c.dynamic), &unstructured.Unstructured{}, 0, cache.Indexers{})
}

func optionalUnavailable(err error) bool {
	return apierrors.IsNotFound(err) || apierrors.IsForbidden(err) || apierrors.IsMethodNotSupported(err)
}

// runOptionalNodeMetrics watches metrics.k8s.io when the cluster has it. Usage
// is the one capacity dimension Kubernetes core does not expose, so a cluster
// without the aggregated API simply reports requests and allocatable and says
// usage is unknown — it is never a reason to stop reporting.
func (c *Collector) runOptionalNodeMetrics(ctx context.Context) {
	if c.dynamic == nil {
		return
	}
	for ctx.Err() == nil {
		if !c.discoverNodeMetrics(ctx) {
			c.state.clearKind(nodeMetricsKind)
			if !waitContext(ctx, c.applicationProbeInterval) {
				return
			}
			continue
		}
		if !c.watchNodeMetrics(ctx) {
			return
		}
		c.state.clearKind(nodeMetricsKind)
		if !waitContext(ctx, c.applicationProbeInterval) {
			return
		}
	}
}

func (c *Collector) discoverNodeMetrics(ctx context.Context) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.dynamic.Resource(NodeMetricsResource).List(probeCtx, metav1.ListOptions{Limit: 1})
	if err != nil && !optionalUnavailable(err) {
		log.FromContext(ctx).Info("Satellite node-metrics discovery will retry")
	}
	return err == nil
}

// watchNodeMetrics runs one metrics informer until the watch fails or the
// context ends. A failed or removed metrics API returns true so the caller
// re-probes later; a cancelled context returns false so the collector stops.
func (c *Collector) watchNodeMetrics(ctx context.Context) bool {
	watchCtx, stop := context.WithCancel(ctx)
	defer stop()
	unavailable := make(chan struct{}, 1)
	failed := func(watchErr error) {
		if routineWatchError(watchErr) {
			return
		}
		select {
		case unavailable <- struct{}{}:
		default:
		}
		stop()
	}
	resource := c.dynamic.Resource(NodeMetricsResource)
	informer := cache.NewSharedIndexInformer(cache.ToListWatcherWithWatchListSemantics(&cache.ListWatch{
		ListWithContextFunc: func(ctx context.Context, options metav1.ListOptions) (runtime.Object, error) {
			result, err := resource.List(ctx, options)
			observeError(ctx, err, failed)
			if err != nil {
				return result, fmt.Errorf("list node metrics: %w", err)
			}
			return result, nil
		},
		WatchFuncWithContext: func(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
			result, err := resource.Watch(ctx, options)
			return observeWatch(ctx, result, err, failed)
		},
	}, c.dynamic), &unstructured.Unstructured{}, 0, cache.Indexers{})
	synced, err := c.attach(informer)
	if err != nil {
		return true
	}
	if err := informer.SetWatchErrorHandler(func(_ *cache.Reflector, watchErr error) { failed(watchErr) }); err != nil {
		return true
	}
	done := make(chan struct{})
	go func() { defer close(done); informer.Run(watchCtx.Done()) }()
	defer func() { stop(); <-done }()
	cache.WaitForCacheSync(watchCtx.Done(), synced)
	select {
	case <-ctx.Done():
		return false
	case <-unavailable:
		return true
	}
}

type publicationState struct {
	previous   map[string]Application
	inventory  clustersv1alpha1.ClusterInventory
	capacity   clustersv1alpha1.SatelliteCapacity
	nodePools  []clustersv1alpha1.ClusterNodePool
	provider   string
	session    string
	sequence   uint64
	lastSent   time.Time
	retryDelay time.Duration
}

type publication struct {
	report  Report
	current map[string]Application
}

func (c *Collector) publish(ctx context.Context) error {
	ticker := time.NewTicker(min(c.config.BatchInterval, c.config.HeartbeatInterval))
	defer ticker.Stop()
	state := &publicationState{retryDelay: time.Second}
	waitForTick := false
	for ctx.Err() == nil {
		if waitForTick && !waitTick(ctx, ticker.C) {
			return nil
		}
		pending, err := c.buildPublication(state)
		if err != nil {
			return err
		}
		if pending == nil {
			waitForTick = true
			continue
		}
		body, err := EncodeReport(&pending.report)
		if err != nil {
			return err
		}
		resync, err := c.sendWithRetries(ctx, body, &state.retryDelay)
		if err != nil {
			if !state.retry(ctx, resync) {
				return nil
			}
			waitForTick = false
			continue
		}
		state.acknowledge(pending)
		waitForTick = true
	}
	return nil
}

func (c *Collector) buildPublication(state *publicationState) (*publication, error) {
	inventory, current := c.state.snapshot()
	capacity, nodePools, providerType := c.state.capacitySnapshot()
	if len(current) > MaxApplications {
		return nil, fmt.Errorf("satellite observes more than %d applications", MaxApplications)
	}
	if state.previous == nil {
		session, err := newSessionID()
		if err != nil {
			return nil, err
		}
		state.session, state.sequence = session, 1
	}
	changed, deleted := applicationDelta(state.previous, current)
	pending := reportPending{
		inventory: inventory, capacity: capacity, nodePools: nodePools, provider: providerType,
		changed: len(changed), deleted: len(deleted),
	}
	if !state.needsReport(&pending, c.config.HeartbeatInterval) {
		return nil, nil
	}
	report := Report{
		ProtocolVersion:     ProtocolVersion,
		ClusterNamespace:    c.config.ClusterNamespace,
		ClusterName:         c.config.ClusterName,
		ClusterUID:          c.clusterUID,
		DisplayName:         c.config.DisplayName,
		SessionID:           state.session,
		Sequence:            state.sequence,
		Snapshot:            state.previous == nil,
		ObservedAt:          time.Now().UTC(),
		Version:             version.Version,
		KubernetesVersion:   c.kubernetesVersion,
		Inventory:           inventory,
		Capacity:            capacity,
		ProviderType:        providerType,
		NodePools:           nodePools,
		Policies:            c.config.ManagementPolicies,
		Autonomy:            c.config.Autonomy,
		Applications:        changed,
		DeletedApplications: deleted,
	}
	return &publication{current: current, report: report}, nil
}

// reportPending is the aggregate state a report carries. It exists so
// needsReport compares the same values it will acknowledge, rather than reading
// them a second time from a state that may have moved on.
type reportPending struct {
	inventory clustersv1alpha1.ClusterInventory
	capacity  clustersv1alpha1.SatelliteCapacity
	nodePools []clustersv1alpha1.ClusterNodePool
	provider  string
	changed   int
	deleted   int
}

func (s *publicationState) needsReport(pending *reportPending, heartbeat time.Duration) bool {
	return s.previous == nil || pending.changed > 0 || pending.deleted > 0 ||
		!reflect.DeepEqual(s.inventory, pending.inventory) ||
		!reflect.DeepEqual(s.capacity, pending.capacity) ||
		!reflect.DeepEqual(s.nodePools, pending.nodePools) ||
		s.provider != pending.provider ||
		time.Since(s.lastSent) >= heartbeat
}

func (s *publicationState) acknowledge(pending *publication) {
	s.previous = pending.current
	s.capacity = pending.report.Capacity
	s.nodePools = pending.report.NodePools
	s.provider = pending.report.ProviderType
	s.inventory = pending.report.Inventory
	s.sequence++
	s.lastSent = time.Now()
	s.retryDelay = time.Second
}

func (s *publicationState) retry(ctx context.Context, resync bool) bool {
	// After repeated failures, rebuild from the latest watch state. This
	// repairs a lost receiver baseline and coalesces offline churn.
	s.previous = nil
	if ctx.Err() != nil {
		return false
	}
	return !resync || waitContext(ctx, s.retryDelay)
}

func (c *Collector) sendWithRetries(ctx context.Context, body []byte, delay *time.Duration) (resync bool, err error) {
	for attempt := 0; attempt < 3; attempt++ {
		err = c.client.SendEncoded(ctx, body)
		if err == nil {
			return false, nil
		}
		if ctx.Err() != nil {
			return false, fmt.Errorf("satellite delivery cancelled: %w", ctx.Err())
		}
		if errors.Is(err, ErrResync) {
			return true, fmt.Errorf("satellite receiver asked for a resync: %w", err)
		}
		log.FromContext(ctx).Info("Satellite report delivery will retry", "reason", err.Error())
		if !waitContext(ctx, *delay+retryJitter(*delay)) {
			return false, fmt.Errorf("satellite delivery cancelled: %w", ctx.Err())
		}
		*delay = min(*delay*2, 30*time.Second)
	}
	return false, fmt.Errorf("satellite report delivery failed: %w", err)
}

func retryJitter(delay time.Duration) time.Duration {
	return time.Duration(mathrand.Int64N(int64(delay / 4))) //nolint:gosec // Retry scheduling jitter is not a security token; session IDs use crypto/rand.
}

func waitTick(ctx context.Context, tick <-chan time.Time) bool {
	select {
	case <-tick:
		return true
	case <-ctx.Done():
		return false
	}
}

func newSessionID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", fmt.Errorf("create satellite session: %w", err)
	}
	return hex.EncodeToString(id[:]), nil
}

func applicationDelta(previous, current map[string]Application) (changed []Application, deleted []string) {
	changed = make([]Application, 0)
	deleted = make([]string, 0)
	for key := range current {
		app := current[key]
		if prior, exists := previous[key]; !exists || prior != app {
			changed = append(changed, app)
		}
	}
	for key := range previous {
		if _, exists := current[key]; !exists {
			deleted = append(deleted, key)
		}
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].Key() < changed[j].Key() })
	sort.Strings(deleted)
	return changed, deleted
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
