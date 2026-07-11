package fleet

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

// CacheStore adapts a controller-runtime cache Reader to the projection's
// typed, cache-only read contract.
type CacheStore struct {
	reader client.Reader
	scheme *runtime.Scheme
}

var (
	_ ProjectionStore     = (*CacheStore)(nil)
	_ OptionalSourceStore = (*CacheStore)(nil)
)

// NewCacheStore creates a cache-only projection adapter. The scheme is used to
// construct the list type corresponding to an optional source prototype.
func NewCacheStore(reader client.Reader, scheme *runtime.Scheme) *CacheStore {
	return &CacheStore{reader: reader, scheme: scheme}
}

func (s *CacheStore) ListApplications(ctx context.Context) ([]*pipelinesv1alpha1.Application, error) {
	var list pipelinesv1alpha1.ApplicationList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*pipelinesv1alpha1.Application, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetApplication(
	ctx context.Context,
	key types.NamespacedName,
) (*pipelinesv1alpha1.Application, bool, error) {
	return getTypedCacheObject(ctx, s, key, &pipelinesv1alpha1.Application{})
}

func (s *CacheStore) ListStages(ctx context.Context) ([]*pipelinesv1alpha1.Stage, error) {
	var list pipelinesv1alpha1.StageList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*pipelinesv1alpha1.Stage, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetStage(
	ctx context.Context,
	key types.NamespacedName,
) (*pipelinesv1alpha1.Stage, bool, error) {
	return getTypedCacheObject(ctx, s, key, &pipelinesv1alpha1.Stage{})
}

func (s *CacheStore) ListReleases(ctx context.Context) ([]*pipelinesv1alpha1.Release, error) {
	var list pipelinesv1alpha1.ReleaseList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*pipelinesv1alpha1.Release, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetRelease(
	ctx context.Context,
	key types.NamespacedName,
) (*pipelinesv1alpha1.Release, bool, error) {
	return getTypedCacheObject(ctx, s, key, &pipelinesv1alpha1.Release{})
}

func (s *CacheStore) ListRollouts(ctx context.Context) ([]*rolloutsv1alpha1.Rollout, error) {
	var list rolloutsv1alpha1.RolloutList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*rolloutsv1alpha1.Rollout, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetRollout(
	ctx context.Context,
	key types.NamespacedName,
) (*rolloutsv1alpha1.Rollout, bool, error) {
	return getTypedCacheObject(ctx, s, key, &rolloutsv1alpha1.Rollout{})
}

func (s *CacheStore) ListAppProjects(ctx context.Context) ([]*corev1alpha1.AppProject, error) {
	var list corev1alpha1.AppProjectList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*corev1alpha1.AppProject, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetAppProject(
	ctx context.Context,
	key types.NamespacedName,
) (*corev1alpha1.AppProject, bool, error) {
	return getTypedCacheObject(ctx, s, key, &corev1alpha1.AppProject{})
}

func (s *CacheStore) ListRepositories(ctx context.Context) ([]*corev1alpha1.Repository, error) {
	var list corev1alpha1.RepositoryList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*corev1alpha1.Repository, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetRepository(
	ctx context.Context,
	key types.NamespacedName,
) (*corev1alpha1.Repository, bool, error) {
	return getTypedCacheObject(ctx, s, key, &corev1alpha1.Repository{})
}

func (s *CacheStore) ListClusters(ctx context.Context) ([]*clustersv1alpha1.Cluster, error) {
	var list clustersv1alpha1.ClusterList
	if err := s.list(ctx, &list); err != nil {
		return nil, err
	}
	items := make([]*clustersv1alpha1.Cluster, len(list.Items))
	for i := range list.Items {
		items[i] = list.Items[i].DeepCopy()
	}
	return items, nil
}

func (s *CacheStore) GetCluster(
	ctx context.Context,
	key types.NamespacedName,
) (*clustersv1alpha1.Cluster, bool, error) {
	return getTypedCacheObject(ctx, s, key, &clustersv1alpha1.Cluster{})
}

func (s *CacheStore) ListOptionalSources(
	ctx context.Context,
	prototype client.Object,
) ([]client.Object, error) {
	list, listErr := s.optionalList(prototype)
	if listErr != nil {
		return nil, listErr
	}
	if err := s.list(ctx, list); err != nil {
		return nil, err
	}
	runtimeObjects, err := meta.ExtractList(list)
	if err != nil {
		return nil, fmt.Errorf("extract optional source list: %w", err)
	}
	items := make([]client.Object, 0, len(runtimeObjects))
	for _, runtimeObject := range runtimeObjects {
		object, ok := runtimeObject.DeepCopyObject().(client.Object)
		if !ok || object == nil {
			return nil, errors.New("optional source list contains a non-client object")
		}
		items = append(items, object)
	}
	return items, nil
}

func (s *CacheStore) GetOptionalSource(
	ctx context.Context,
	prototype client.Object,
	key types.NamespacedName,
) (client.Object, bool, error) {
	if prototype == nil {
		return nil, false, errors.New("optional source prototype is nil")
	}
	object, ok := prototype.DeepCopyObject().(client.Object)
	if !ok || object == nil {
		return nil, false, errors.New("optional source prototype is not a client object")
	}
	found, err := s.get(ctx, key, object)
	if err != nil || !found {
		return nil, found, err
	}
	return object, found, err
}

func getTypedCacheObject[T client.Object](
	ctx context.Context,
	store *CacheStore,
	key types.NamespacedName,
	object T,
) (result T, found bool, err error) {
	found, err = store.get(ctx, key, object)
	if err != nil || !found {
		return result, found, err
	}
	return object, true, nil
}

func (s *CacheStore) get(
	ctx context.Context,
	key types.NamespacedName,
	object client.Object,
) (bool, error) {
	if s == nil || s.reader == nil {
		return false, errors.New("fleet cache store is not configured")
	}
	if err := s.reader.Get(ctx, key, object); err != nil {
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("read fleet cache object: %w", err)
	}
	return true, nil
}

func (s *CacheStore) list(ctx context.Context, list client.ObjectList) error {
	if s == nil || s.reader == nil {
		return errors.New("fleet cache store is not configured")
	}
	if err := s.reader.List(ctx, list); err != nil {
		return fmt.Errorf("list fleet cache objects: %w", err)
	}
	return nil
}

func (s *CacheStore) optionalList(prototype client.Object) (client.ObjectList, error) {
	if s == nil || s.scheme == nil || prototype == nil {
		return nil, errors.New("optional source list is not configured")
	}
	gvk, err := apiutil.GVKForObject(prototype, s.scheme)
	if err != nil {
		return nil, fmt.Errorf("resolve optional source kind: %w", err)
	}
	gvk.Kind += "List"
	object, err := s.scheme.New(gvk)
	if err != nil {
		return nil, fmt.Errorf("create optional source list: %w", err)
	}
	list, ok := object.(client.ObjectList)
	if !ok || list == nil {
		return nil, errors.New("optional source list type is not a client object list")
	}
	return list, nil
}
