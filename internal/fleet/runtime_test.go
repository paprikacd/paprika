package fleet

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

func TestFleetIndexRuntimeRegistersRequiredInformersBeforeStart(t *testing.T) {
	t.Parallel()

	store, _, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, store, index)
	require.NoError(t, err)
	require.Empty(t, source.requestedTypes())
	require.Same(t, index, runtime.Reader())
	require.False(t, runtime.NeedLeaderElection())

	require.NoError(t, runtime.Register(context.Background()))
	require.Equal(t, []reflect.Type{
		reflect.TypeOf(&pipelinesv1alpha1.Application{}),
		reflect.TypeOf(&pipelinesv1alpha1.Stage{}),
		reflect.TypeOf(&pipelinesv1alpha1.Release{}),
		reflect.TypeOf(&rolloutsv1alpha1.Rollout{}),
		reflect.TypeOf(&clustersv1alpha1.Cluster{}),
		reflect.TypeOf(&corev1alpha1.Repository{}),
		reflect.TypeOf(&corev1alpha1.AppProject{}),
	}, source.requestedTypes())
	for _, informer := range source.informersSnapshot() {
		require.Equal(t, 1, informer.handlerCount())
	}
	require.ErrorContains(t, runtime.Register(context.Background()), "already")
}

func TestFleetIndexRuntimeWaitsForEveryHandlerSyncAndInitialInstall(t *testing.T) {
	t.Parallel()

	store, _, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, store, index)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Start(ctx) }()

	readyCtx, readyCancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer readyCancel()
	require.ErrorIs(t, runtime.WaitReady(readyCtx), context.DeadlineExceeded)
	require.Error(t, index.CheckReady())

	informers := source.informersInRequestOrder()
	for _, informer := range informers[:len(informers)-1] {
		informer.setSynced()
	}
	notReadyCtx, notReadyCancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer notReadyCancel()
	require.ErrorIs(t, runtime.WaitReady(notReadyCtx), context.DeadlineExceeded)

	informers[len(informers)-1].setSynced()
	installedCtx, installedCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer installedCancel()
	require.NoError(t, runtime.WaitReady(installedCtx))
	require.NoError(t, index.CheckReady())
	require.Equal(t, uint64(1), requireSnapshot(t, index).Generation)

	cancel()
	require.NoError(t, <-done)
	for _, informer := range informers {
		require.Zero(t, informer.handlerCount())
	}
}

func TestFleetIndexRuntimeReplaysWarmUpdateBeforeInitialInstall(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, store, index)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))
	for _, informer := range source.informersInRequestOrder() {
		informer.setSynced()
	}

	listStarted, allowList := store.blockNextApplicationList()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Start(ctx) }()
	<-listStarted

	before := store.application(appID)
	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "resolved-during-warmup"
	})
	after := store.application(appID)
	source.informerFor(&pipelinesv1alpha1.Application{}).update(before, after)
	close(allowList)

	readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readyCancel()
	require.NoError(t, runtime.WaitReady(readyCtx))
	require.Equal(t, "resolved-during-warmup", requireSnapshot(t, index).Applications[appID].SourceRevision)

	cancel()
	require.NoError(t, <-done)
}

func TestCacheStoreReadsTypedAndOptionalObjectsDefensively(t *testing.T) {
	t.Parallel()

	scheme := k8sruntime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	require.NoError(t, rolloutsv1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "checkout"},
	}
	optional := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "prometheus"},
	}
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, optional).Build()
	store := NewCacheStore(reader, scheme)

	applications, err := store.ListApplications(context.Background())
	require.NoError(t, err)
	require.Len(t, applications, 1)
	applications[0].Name = "mutated"
	foundApp, found, err := store.GetApplication(context.Background(), types.NamespacedName{
		Namespace: app.Namespace,
		Name:      app.Name,
	})
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "checkout", foundApp.Name)
	missingApp, found, err := store.GetApplication(context.Background(), types.NamespacedName{
		Namespace: "apps",
		Name:      "missing",
	})
	require.NoError(t, err)
	require.False(t, found)
	require.Nil(t, missingApp)

	optionalObjects, err := store.ListOptionalSources(context.Background(), &corev1.ConfigMap{})
	require.NoError(t, err)
	require.Len(t, optionalObjects, 1)
	require.IsType(t, &corev1.ConfigMap{}, optionalObjects[0])
	optionalObjects[0].SetName("mutated")
	foundOptional, found, err := store.GetOptionalSource(
		context.Background(),
		&corev1.ConfigMap{},
		types.NamespacedName{Namespace: optional.Namespace, Name: optional.Name},
	)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "prometheus", foundOptional.GetName())
}

func TestUnavailableReaderReturnsConfiguredReason(t *testing.T) {
	t.Parallel()

	const reason = "API informer cache disabled by --api-cache-enabled=false"
	reader := NewUnavailableReader(reason)
	require.ErrorContains(t, reader.CheckReady(), reason)
	_, err := reader.LoadSnapshot()
	require.ErrorContains(t, err, reason)
	var unavailable *ErrUnavailable
	require.ErrorAs(t, err, &unavailable)
	require.Equal(t, reason, unavailable.Reason)

	_, err = reader.ProjectKeys(context.Background(), nil)
	require.ErrorAs(t, err, &unavailable)
	_, err = reader.QueryApplications(context.Background(), QueryScope{}, ApplicationQuery{}, "")
	require.ErrorAs(t, err, &unavailable)
	_, err = reader.QueryMap(context.Background(), QueryScope{}, FleetMapQuery{})
	require.ErrorAs(t, err, &unavailable)
	_, err = reader.QueryMatrix(context.Background(), QueryScope{}, FleetMatrixQuery{})
	require.ErrorAs(t, err, &unavailable)
}

func TestFleetIndexRuntimeWorkerErrorReturnsWithoutShutdownDeadlock(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, store, index)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))
	for _, informer := range source.informersInRequestOrder() {
		informer.setSynced()
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runtime.Start(ctx) }()
	readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readyCancel()
	require.NoError(t, runtime.WaitReady(readyCtx))

	store.setGetError(ResourceApplication, errors.New("sensitive backend failure"))
	app := store.application(appID)
	source.informerFor(&pipelinesv1alpha1.Application{}).update(app, app.DeepCopy())

	select {
	case startErr := <-done:
		require.Error(t, startErr)
		require.NotContains(t, startErr.Error(), "sensitive backend failure")
		require.Error(t, index.CheckReady())
	case <-time.After(2 * time.Second):
		t.Fatal("runtime Start deadlocked after its worker returned an error")
	}
}

func TestFleetIndexRuntimeStartBeforeRegisterFailsReadinessAndLocksState(t *testing.T) {
	t.Parallel()

	store, _, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	runtime, err := NewRuntime(source, store, NewIndex())
	require.NoError(t, err)

	startErr := runtime.Start(context.Background())
	require.ErrorContains(t, startErr, "registered")
	readyCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	require.ErrorContains(t, runtime.WaitReady(readyCtx), "registered")
	require.ErrorContains(t, runtime.Register(context.Background()), "after Start")
}

func TestFleetIndexRuntimeRegistersOneDefensiveOptionalPrototype(t *testing.T) {
	t.Parallel()

	store := newOptionalProjectionStore()
	source := newFakeRuntimeInformerSource()
	source.mutateRequested = true
	projector := &stableRuntimeOptionalProjector{prototype: &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "projector-owned"},
	}}
	runtime, err := NewRuntime(source, store, NewIndex(), projector)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))

	types := source.requestedTypes()
	require.Len(t, types, 8)
	require.Equal(t, reflect.TypeOf(&corev1.ConfigMap{}), types[7])
	require.Equal(t, "projector-owned", projector.prototype.Name)
}

func TestFleetIndexRuntimeCleansPartialRegistrationFailure(t *testing.T) {
	t.Parallel()

	store, _, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	source.failGetAt = 4
	runtime, err := NewRuntime(source, store, NewIndex())
	require.NoError(t, err)
	require.Error(t, runtime.Register(context.Background()))
	for _, informer := range source.informersSnapshot() {
		require.Zero(t, informer.handlerCount())
	}
}

func TestFleetIndexRuntimeDeletesFromTombstoneKey(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, store, index)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))
	for _, informer := range source.informersInRequestOrder() {
		informer.setSynced()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Start(ctx) }()
	readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readyCancel()
	require.NoError(t, runtime.WaitReady(readyCtx))

	store.deleteApplication(appID)
	source.informerFor(&pipelinesv1alpha1.Application{}).remove(cache.DeletedFinalStateUnknown{
		Key: appID.String(),
	})
	require.Eventually(t, func() bool {
		_, exists := requireSnapshot(t, index).Applications[appID]
		return !exists
	}, 5*time.Second, 10*time.Millisecond)

	cancel()
	require.NoError(t, <-done)
}

func TestFleetIndexRuntimeCoalescesRepeatedWarmKeys(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, store, index)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))

	app := store.application(appID)
	for range 100 {
		source.informerFor(&pipelinesv1alpha1.Application{}).update(app, app.DeepCopy())
	}
	require.Equal(t, 1, runtime.queue.Len())
	for _, informer := range source.informersInRequestOrder() {
		informer.setSynced()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Start(ctx) }()
	readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readyCancel()
	require.NoError(t, runtime.WaitReady(readyCtx))

	cancel()
	require.NoError(t, <-done)
}

func TestFleetIndexRuntimeFencesRebuildEventsBeforeReadiness(t *testing.T) {
	store, appID, _ := populatedProjectionStore()
	stale := store.application(appID)
	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "fresh-from-delta"
	})
	fresh := store.application(appID)
	projectionStore := &staleApplicationListStore{
		fakeProjectionStore: store,
		stale:               []*pipelinesv1alpha1.Application{stale},
	}

	source := newFakeRuntimeInformerSource()
	index := NewIndex()
	runtime, err := NewRuntime(source, projectionStore, index)
	require.NoError(t, err)
	require.NoError(t, runtime.Register(context.Background()))
	blockedQueue := newBlockingRuntimeQueue(runtime.queue)
	runtime.queue = blockedQueue
	source.informerFor(&pipelinesv1alpha1.Application{}).update(stale, fresh)
	for _, informer := range source.informersInRequestOrder() {
		informer.setSynced()
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Start(ctx) }()
	<-blockedQueue.getStarted

	earlyCtx, earlyCancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	earlyErr := runtime.WaitReady(earlyCtx)
	earlyCancel()
	blockedQueue.releaseWorker()

	readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
	require.NoError(t, runtime.WaitReady(readyCtx))
	readyCancel()
	require.Equal(t, "fresh-from-delta", requireSnapshot(t, index).Applications[appID].SourceRevision)
	cancel()
	require.NoError(t, <-done)
	require.ErrorIs(t, earlyErr, context.DeadlineExceeded)
}

func TestFleetIndexRuntimeRegistrationErrorsPreserveKindAndCauses(t *testing.T) {
	t.Run("informer lookup and cleanup", func(t *testing.T) {
		store, _, _ := populatedProjectionStore()
		lookupErr := errors.New("lookup sentinel")
		cleanupErr := errors.New("cleanup sentinel")
		source := newFakeRuntimeInformerSource()
		source.failGetAt = 2
		source.getErr = lookupErr
		source.removeErr = cleanupErr
		runtime, err := NewRuntime(source, store, NewIndex())
		require.NoError(t, err)

		err = runtime.Register(context.Background())
		require.ErrorContains(t, err, "stage")
		require.ErrorIs(t, err, lookupErr)
		require.ErrorIs(t, err, cleanupErr)
	})

	t.Run("handler registration", func(t *testing.T) {
		store, _, _ := populatedProjectionStore()
		handlerErr := errors.New("handler sentinel")
		source := newFakeRuntimeInformerSource()
		source.failHandlerAt = 3
		source.handlerErr = handlerErr
		runtime, err := NewRuntime(source, store, NewIndex())
		require.NoError(t, err)

		err = runtime.Register(context.Background())
		require.ErrorContains(t, err, "release")
		require.ErrorIs(t, err, handlerErr)
	})
}

type fakeRuntimeInformerSource struct {
	mu              sync.Mutex
	requested       []reflect.Type
	informers       map[reflect.Type]*fakeRuntimeInformer
	failGetAt       int
	getErr          error
	failHandlerAt   int
	handlerErr      error
	removeErr       error
	mutateRequested bool
}

func newFakeRuntimeInformerSource() *fakeRuntimeInformerSource {
	return &fakeRuntimeInformerSource{informers: make(map[reflect.Type]*fakeRuntimeInformer)}
}

func (s *fakeRuntimeInformerSource) GetInformer(
	_ context.Context,
	object client.Object,
	_ ...crcache.InformerGetOption,
) (crcache.Informer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	typeOf := reflect.TypeOf(object)
	s.requested = append(s.requested, typeOf)
	if s.mutateRequested {
		object.SetName("source-mutated")
	}
	if s.failGetAt > 0 && len(s.requested) == s.failGetAt {
		if s.getErr != nil {
			return nil, s.getErr
		}
		return nil, errors.New("informer lookup failed")
	}
	informer := s.informers[typeOf]
	if informer == nil {
		informer = newFakeRuntimeInformer()
		informer.removeErr = s.removeErr
		if s.failHandlerAt > 0 && len(s.requested) == s.failHandlerAt {
			informer.addErr = s.handlerErr
		}
		s.informers[typeOf] = informer
	}
	return informer, nil
}

func (s *fakeRuntimeInformerSource) requestedTypes() []reflect.Type {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]reflect.Type(nil), s.requested...)
}

func (s *fakeRuntimeInformerSource) informersSnapshot() []*fakeRuntimeInformer {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]*fakeRuntimeInformer, 0, len(s.informers))
	for _, informer := range s.informers {
		result = append(result, informer)
	}
	return result
}

func (s *fakeRuntimeInformerSource) informersInRequestOrder() []*fakeRuntimeInformer {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]*fakeRuntimeInformer, 0, len(s.requested))
	for _, typeOf := range s.requested {
		result = append(result, s.informers[typeOf])
	}
	return result
}

func (s *fakeRuntimeInformerSource) informerFor(object client.Object) *fakeRuntimeInformer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.informers[reflect.TypeOf(object)]
}

type fakeRuntimeInformer struct {
	mu        sync.Mutex
	handlers  map[*fakeRuntimeRegistration]cache.ResourceEventHandler
	synced    bool
	syncDone  chan struct{}
	stopped   bool
	addErr    error
	removeErr error
}

func newFakeRuntimeInformer() *fakeRuntimeInformer {
	return &fakeRuntimeInformer{
		handlers: make(map[*fakeRuntimeRegistration]cache.ResourceEventHandler),
		syncDone: make(chan struct{}),
	}
}

func (i *fakeRuntimeInformer) AddEventHandler(
	handler cache.ResourceEventHandler,
) (cache.ResourceEventHandlerRegistration, error) {
	return i.addEventHandler(handler)
}

func (i *fakeRuntimeInformer) AddEventHandlerWithResyncPeriod(
	handler cache.ResourceEventHandler,
	_ time.Duration,
) (cache.ResourceEventHandlerRegistration, error) {
	return i.addEventHandler(handler)
}

func (i *fakeRuntimeInformer) AddEventHandlerWithOptions(
	handler cache.ResourceEventHandler,
	_ cache.HandlerOptions,
) (cache.ResourceEventHandlerRegistration, error) {
	return i.addEventHandler(handler)
}

func (i *fakeRuntimeInformer) addEventHandler(
	handler cache.ResourceEventHandler,
) (cache.ResourceEventHandlerRegistration, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.addErr != nil {
		return nil, i.addErr
	}
	registration := &fakeRuntimeRegistration{informer: i}
	i.handlers[registration] = handler
	return registration, nil
}

func (i *fakeRuntimeInformer) RemoveEventHandler(registration cache.ResourceEventHandlerRegistration) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	typed, ok := registration.(*fakeRuntimeRegistration)
	if ok {
		delete(i.handlers, typed)
	}
	return i.removeErr
}

func (*fakeRuntimeInformer) AddIndexers(cache.Indexers) error { return nil }

func (i *fakeRuntimeInformer) HasSynced() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.synced
}

func (i *fakeRuntimeInformer) HasSyncedChecker() cache.DoneChecker {
	return fakeRuntimeDoneChecker{name: "fake informer", done: i.syncDone}
}

func (i *fakeRuntimeInformer) IsStopped() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.stopped
}

func (i *fakeRuntimeInformer) handlerCount() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return len(i.handlers)
}

func (i *fakeRuntimeInformer) setSynced() {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.synced {
		return
	}
	i.synced = true
	close(i.syncDone)
}

func (i *fakeRuntimeInformer) update(oldObject, newObject client.Object) {
	i.mu.Lock()
	handlers := make([]cache.ResourceEventHandler, 0, len(i.handlers))
	for _, handler := range i.handlers {
		handlers = append(handlers, handler)
	}
	i.mu.Unlock()
	for _, handler := range handlers {
		handler.OnUpdate(oldObject, newObject)
	}
}

func (i *fakeRuntimeInformer) remove(object any) {
	i.mu.Lock()
	handlers := make([]cache.ResourceEventHandler, 0, len(i.handlers))
	for _, handler := range i.handlers {
		handlers = append(handlers, handler)
	}
	i.mu.Unlock()
	for _, handler := range handlers {
		handler.OnDelete(object)
	}
}

type fakeRuntimeRegistration struct {
	informer *fakeRuntimeInformer
}

func (r *fakeRuntimeRegistration) HasSynced() bool { return r.informer.HasSynced() }

func (r *fakeRuntimeRegistration) HasSyncedChecker() cache.DoneChecker {
	return fakeRuntimeDoneChecker{name: "fake handler", done: r.informer.syncDone}
}

type fakeRuntimeDoneChecker struct {
	name string
	done <-chan struct{}
}

func (c fakeRuntimeDoneChecker) Name() string          { return c.name }
func (c fakeRuntimeDoneChecker) Done() <-chan struct{} { return c.done }

type stableRuntimeOptionalProjector struct {
	prototype *corev1.ConfigMap
}

type staleApplicationListStore struct {
	*fakeProjectionStore
	stale []*pipelinesv1alpha1.Application
}

func (s *staleApplicationListStore) ListApplications(
	context.Context,
) ([]*pipelinesv1alpha1.Application, error) {
	items := make([]*pipelinesv1alpha1.Application, len(s.stale))
	for i := range s.stale {
		items[i] = s.stale[i].DeepCopy()
	}
	return items, nil
}

type blockingRuntimeQueue struct {
	workqueue.TypedInterface[runtimeQueueKey]
	getStarted  chan struct{}
	release     chan struct{}
	startOnce   sync.Once
	releaseOnce sync.Once
}

func newBlockingRuntimeQueue(
	inner workqueue.TypedInterface[runtimeQueueKey],
) *blockingRuntimeQueue {
	return &blockingRuntimeQueue{
		TypedInterface: inner,
		getStarted:     make(chan struct{}),
		release:        make(chan struct{}),
	}
}

func (q *blockingRuntimeQueue) Get() (runtimeQueueKey, bool) {
	q.startOnce.Do(func() { close(q.getStarted) })
	<-q.release
	return q.TypedInterface.Get()
}

func (q *blockingRuntimeQueue) releaseWorker() {
	q.releaseOnce.Do(func() { close(q.release) })
}

func (p *stableRuntimeOptionalProjector) Prototype() client.Object { return p.prototype }

func (*stableRuntimeOptionalProjector) Summarize(object client.Object) (SourceSummary, error) {
	return SourceSummary{Identity: clientKey(object)}, nil
}

func (*stableRuntimeOptionalProjector) Bindings(
	*pipelinesv1alpha1.Application,
	*corev1alpha1.AppProject,
	[]pipelinesv1alpha1.Stage,
) []types.NamespacedName {
	return nil
}
