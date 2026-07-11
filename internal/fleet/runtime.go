package fleet

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

// InformerSource is the explicit controller-runtime cache surface used by the
// fleet runtime. Registration is deliberately separate from Start so every
// handler is attached before the shared cache begins delivering events.
type InformerSource interface {
	GetInformer(context.Context, client.Object, ...crcache.InformerGetOption) (crcache.Informer, error)
}

type runtimeRegistration struct {
	informer     crcache.Informer
	registration cache.ResourceEventHandlerRegistration
}

type runtimeInformerDescriptor struct {
	kind      ResourceKind
	name      string
	prototype client.Object
}

type runtimeQueueKey struct {
	kind      ResourceKind
	key       types.NamespacedName
	barrierID uint64
}

// Runtime owns informer registration and the fleet projection worker.
type Runtime struct {
	source    InformerSource
	store     ProjectionStore
	index     *Index
	rebuilder *Rebuilder

	mu             sync.Mutex
	registerCalled bool
	registered     bool
	startCalled    bool
	registrations  []runtimeRegistration
	ready          chan struct{}
	readyOnce      sync.Once
	readyErr       error

	queue     workqueue.TypedInterface[runtimeQueueKey]
	pendingMu sync.Mutex
	pending   map[runtimeQueueKey]ResourceDelta
	barrierID uint64
	barriers  map[uint64]chan struct{}
}

// NewRuntime constructs a dormant runtime. It performs no informer lookup or
// goroutine start; callers must invoke Register before the cache starts.
func NewRuntime(
	source InformerSource,
	store ProjectionStore,
	index *Index,
	projectors ...OptionalSourceProjector,
) (*Runtime, error) {
	if source == nil || store == nil || index == nil {
		return nil, errors.New("fleet runtime is not configured")
	}
	rebuilder := NewRebuilder(index, store, projectors...)
	if rebuilder.configurationErr != nil {
		return nil, rebuilder.configurationErr
	}
	return &Runtime{
		source: source, store: store, index: index, rebuilder: rebuilder,
		ready:    make(chan struct{}),
		queue:    workqueue.NewTyped[runtimeQueueKey](),
		pending:  make(map[runtimeQueueKey]ResourceDelta),
		barriers: make(map[uint64]chan struct{}),
	}, nil
}

// Reader returns the immutable query surface owned by this runtime.
func (r *Runtime) Reader() Reader {
	if r == nil {
		return nil
	}
	return r.index
}

// NeedLeaderElection is false because every API replica needs its own index.
func (*Runtime) NeedLeaderElection() bool { return false }

// Register synchronously attaches all required informer handlers.
func (r *Runtime) Register(ctx context.Context) error {
	if r == nil {
		return errors.New("fleet runtime is not configured")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.registerCalled {
		return errors.New("fleet runtime Register was already called")
	}
	if r.startCalled {
		return errors.New("fleet runtime cannot register after Start")
	}
	r.registerCalled = true

	descriptors := []runtimeInformerDescriptor{
		{ResourceApplication, "application", &pipelinesv1alpha1.Application{}},
		{ResourceStage, "stage", &pipelinesv1alpha1.Stage{}},
		{ResourceRelease, "release", &pipelinesv1alpha1.Release{}},
		{ResourceRollout, "rollout", &rolloutsv1alpha1.Rollout{}},
		{ResourceCluster, "cluster", &clustersv1alpha1.Cluster{}},
		{ResourceRepository, "repository", &corev1alpha1.Repository{}},
		{ResourceAppProject, "app project", &corev1alpha1.AppProject{}},
	}
	if optional := r.rebuilder.OptionalSourcePrototype(); optional != nil {
		descriptors = append(descriptors, runtimeInformerDescriptor{
			ResourceOptionalSource, "optional source", optional,
		})
	}

	for _, descriptor := range descriptors {
		informer, err := r.source.GetInformer(ctx, descriptor.prototype)
		if err != nil {
			cause := fmt.Errorf("get fleet %s informer: %w", descriptor.name, err)
			return joinRegistrationCleanupError(cause, descriptor.name, r.removeRegistrationsLocked())
		}
		registration, err := informer.AddEventHandler(r.eventHandler(descriptor.kind))
		if err != nil {
			cause := fmt.Errorf("register fleet %s informer handler: %w", descriptor.name, err)
			return joinRegistrationCleanupError(cause, descriptor.name, r.removeRegistrationsLocked())
		}
		r.registrations = append(r.registrations, runtimeRegistration{
			informer: informer, registration: registration,
		})
	}
	r.registered = true
	return nil
}

func joinRegistrationCleanupError(cause error, resource string, cleanupErr error) error {
	if cleanupErr == nil {
		return cause
	}
	return errors.Join(
		cause,
		fmt.Errorf("clean up fleet handlers after %s registration failure: %w", resource, cleanupErr),
	)
}

func (r *Runtime) removeRegistrationsLocked() error {
	var cleanupErr error
	for i := len(r.registrations) - 1; i >= 0; i-- {
		if err := r.registrations[i].informer.RemoveEventHandler(r.registrations[i].registration); err != nil {
			cleanupErr = errors.Join(cleanupErr, err)
		}
	}
	r.registrations = nil
	return cleanupErr
}

func (r *Runtime) eventHandler(kind ResourceKind) cache.ResourceEventHandler {
	return cache.ResourceEventHandlerDetailedFuncs{
		AddFunc: func(object any, initial bool) {
			if !initial {
				r.enqueueObject(kind, object, nil)
			}
		},
		UpdateFunc: func(oldObject, newObject any) {
			if sameRuntimeResourceVersion(oldObject, newObject) {
				return
			}
			affected := runtimeAffectedApplications(kind, oldObject, newObject)
			r.enqueueObject(kind, oldObject, affected)
			if oldKey, oldOK := runtimeObjectKey(oldObject); oldOK {
				if newKey, newOK := runtimeObjectKey(newObject); newOK && newKey == oldKey {
					return
				}
			}
			r.enqueueObject(kind, newObject, affected)
		},
		DeleteFunc: func(object any) {
			r.enqueueObject(kind, object, runtimeAffectedApplications(kind, object))
		},
	}
}

func (r *Runtime) enqueueObject(
	kind ResourceKind,
	object any,
	affected []types.NamespacedName,
) {
	key, ok := runtimeObjectKey(object)
	if !ok {
		return
	}
	queueKey := runtimeQueueKey{kind: kind, key: key}
	r.pendingMu.Lock()
	delta := r.pending[queueKey]
	delta.Kind = kind
	delta.Key = key
	delta.AffectedApplications = append(delta.AffectedApplications, affected...)
	r.pending[queueKey] = normalizeDelta(delta)
	r.queue.Add(queueKey)
	r.pendingMu.Unlock()
}

func (r *Runtime) enqueueBarrier() <-chan struct{} {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	r.barrierID++
	done := make(chan struct{})
	r.barriers[r.barrierID] = done
	r.queue.Add(runtimeQueueKey{barrierID: r.barrierID})
	return done
}

func (r *Runtime) completeBarriers(items []runtimeQueueKey) {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	for _, item := range items {
		if item.barrierID == 0 {
			continue
		}
		if done := r.barriers[item.barrierID]; done != nil {
			delete(r.barriers, item.barrierID)
			close(done)
		}
	}
}

func runtimeObjectKey(object any) (types.NamespacedName, bool) {
	key, err := cache.DeletionHandlingMetaNamespaceKeyFunc(object)
	if err != nil {
		return types.NamespacedName{}, false
	}
	namespace, name, err := cache.SplitMetaNamespaceKey(key)
	if err != nil || name == "" {
		return types.NamespacedName{}, false
	}
	return types.NamespacedName{Namespace: namespace, Name: name}, true
}

func sameRuntimeResourceVersion(oldObject, newObject any) bool {
	oldAccessor, oldErr := meta.Accessor(oldObject)
	newAccessor, newErr := meta.Accessor(newObject)
	if oldErr != nil || newErr != nil {
		return false
	}
	oldVersion := oldAccessor.GetResourceVersion()
	return oldVersion != "" && oldVersion == newAccessor.GetResourceVersion()
}

func runtimeAffectedApplications(kind ResourceKind, objects ...any) []types.NamespacedName {
	if kind != ResourceStage && kind != ResourceRelease {
		return nil
	}
	result := make([]types.NamespacedName, 0, len(objects))
	for _, object := range objects {
		if tombstone, ok := object.(cache.DeletedFinalStateUnknown); ok {
			object = tombstone.Obj
		}
		accessor, err := meta.Accessor(object)
		if err != nil {
			continue
		}
		if owner, ok := applicationOwnerKey(accessor); ok {
			result = append(result, owner)
		}
	}
	return normalizeKeys(result)
}

// Start waits for every registered handler to finish its initial delivery,
// installs the first complete snapshot, and then blocks until cancellation.
func (r *Runtime) Start(ctx context.Context) error {
	registrations, err := r.beginStart()
	if err != nil {
		if r != nil {
			r.signalReady(err)
		}
		return err
	}

	var workerDone chan error
	defer func() { r.stop(workerDone) }()

	if syncErr := waitForRuntimeSync(ctx, registrations); syncErr != nil {
		return r.failStartup(ctx, syncErr)
	}
	if _, rebuildErr := r.rebuilder.Rebuild(ctx); rebuildErr != nil {
		r.signalReady(rebuildErr)
		return rebuildErr
	}
	barrierDone := r.enqueueBarrier()
	workerDone = make(chan error, 1)
	go func() {
		workerDone <- r.runWorker(ctx)
		close(workerDone)
	}()
	if barrierErr := waitForRuntimeBarrier(ctx, barrierDone, workerDone); barrierErr != nil {
		return r.failStartup(ctx, barrierErr)
	}
	r.signalReady(nil)

	select {
	case <-ctx.Done():
		return nil
	case err := <-workerDone:
		return err
	}
}

func (r *Runtime) failStartup(ctx context.Context, err error) error {
	r.signalReady(err)
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func (r *Runtime) stop(workerDone <-chan error) {
	r.mu.Lock()
	cleanupErr := r.removeRegistrationsLocked()
	r.mu.Unlock()
	if cleanupErr != nil {
		r.index.health.Store(&HealthState{Degraded: true, Reason: "fleet informer cleanup failed"})
	}
	r.queue.ShutDownWithDrain()
	if workerDone != nil {
		<-workerDone
	}
}

func (r *Runtime) beginStart() ([]runtimeRegistration, error) {
	if r == nil {
		return nil, errors.New("fleet runtime is not configured")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.startCalled {
		return nil, errors.New("fleet runtime Start was already called")
	}
	r.startCalled = true
	if !r.registered {
		return nil, errors.New("fleet runtime must be registered before Start")
	}
	return append([]runtimeRegistration(nil), r.registrations...), nil
}

func waitForRuntimeSync(
	ctx context.Context,
	registrations []runtimeRegistration,
) error {
	for _, registration := range registrations {
		select {
		case <-registration.registration.HasSyncedChecker().Done():
		case <-ctx.Done():
			return fmt.Errorf("wait for fleet informer synchronization: %w", ctx.Err())
		}
	}
	return nil
}

func waitForRuntimeBarrier(
	ctx context.Context,
	barrierDone <-chan struct{},
	workerDone <-chan error,
) error {
	select {
	case <-barrierDone:
		return nil
	case err := <-workerDone:
		if err == nil {
			return errors.New("fleet projection worker stopped before warm-up completed")
		}
		return err
	case <-ctx.Done():
		return fmt.Errorf("wait for fleet warm-up barrier: %w", ctx.Err())
	}
}

// WaitReady blocks until the initial atomic snapshot has been installed or
// startup has failed.
func (r *Runtime) WaitReady(ctx context.Context) error {
	if r == nil {
		return errors.New("fleet runtime is not configured")
	}
	select {
	case <-r.ready:
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.readyErr
	case <-ctx.Done():
		return fmt.Errorf("wait for fleet readiness: %w", ctx.Err())
	}
}

func (r *Runtime) signalReady(err error) {
	r.readyOnce.Do(func() {
		r.mu.Lock()
		r.readyErr = err
		r.mu.Unlock()
		close(r.ready)
	})
}

func (r *Runtime) runWorker(ctx context.Context) error {
	for {
		first, shutdown := r.queue.Get()
		if shutdown {
			return nil
		}
		items := []runtimeQueueKey{first}
		for r.queue.Len() > 0 {
			item, itemShutdown := r.queue.Get()
			if itemShutdown {
				break
			}
			items = append(items, item)
		}
		deltas := r.takePending(items)
		_, err := r.rebuilder.ApplyDeltas(ctx, deltas)
		for _, item := range items {
			r.queue.Done(item)
		}
		if err != nil {
			if healthErr := r.index.SetHealth(HealthState{Degraded: true, Reason: "fleet delta projection failed"}); healthErr != nil {
				return errors.New("fleet delta projection failed and health could not be updated")
			}
			return err
		}
		r.completeBarriers(items)
	}
}

func (r *Runtime) takePending(items []runtimeQueueKey) []ResourceDelta {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	deltas := make([]ResourceDelta, 0, len(items))
	for _, item := range items {
		if delta, ok := r.pending[item]; ok {
			deltas = append(deltas, delta)
			delete(r.pending, item)
		}
	}
	return deltas
}

type unavailableReader struct {
	reason string
}

// NewUnavailableReader returns an explicit unavailable fleet surface for
// cache-disabled deployments. It never presents an empty fleet as valid data.
func NewUnavailableReader(reason string) Reader {
	if reason == "" {
		reason = "fleet informer cache is disabled"
	}
	return &unavailableReader{reason: reason}
}

func (r *unavailableReader) unavailable() error {
	return &ErrUnavailable{Reason: r.reason}
}

func (r *unavailableReader) ProjectKeys(context.Context, []string) ([]ProjectKey, error) {
	return nil, r.unavailable()
}

func (r *unavailableReader) QueryApplications(
	context.Context,
	QueryScope,
	ApplicationQuery,
	string,
) (ApplicationPage, error) {
	return ApplicationPage{}, r.unavailable()
}

func (r *unavailableReader) QueryMap(
	context.Context,
	QueryScope,
	FleetMapQuery,
) (FleetMap, error) {
	return FleetMap{}, r.unavailable()
}

func (r *unavailableReader) QueryMatrix(
	context.Context,
	QueryScope,
	FleetMatrixQuery,
) (FleetMatrix, error) {
	return FleetMatrix{}, r.unavailable()
}

func (r *unavailableReader) LoadSnapshot() (*Snapshot, error) {
	return nil, r.unavailable()
}

func (r *unavailableReader) CheckReady() error {
	return r.unavailable()
}
