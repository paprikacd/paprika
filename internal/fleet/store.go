package fleet

import (
	"context"
	"sort"

	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

// ProjectionStore is the cache-only read contract used by fleet projection.
// A false, nil Get result means the object is absent from the cache. Callers
// must never retain returned Kubernetes objects as authoritative delta state.
type ProjectionStore interface {
	ListApplications(context.Context) ([]*pipelinesv1alpha1.Application, error)
	GetApplication(context.Context, types.NamespacedName) (*pipelinesv1alpha1.Application, bool, error)
	ListStages(context.Context) ([]*pipelinesv1alpha1.Stage, error)
	GetStage(context.Context, types.NamespacedName) (*pipelinesv1alpha1.Stage, bool, error)
	ListReleases(context.Context) ([]*pipelinesv1alpha1.Release, error)
	GetRelease(context.Context, types.NamespacedName) (*pipelinesv1alpha1.Release, bool, error)
	ListRollouts(context.Context) ([]*rolloutsv1alpha1.Rollout, error)
	GetRollout(context.Context, types.NamespacedName) (*rolloutsv1alpha1.Rollout, bool, error)
	ListAppProjects(context.Context) ([]*corev1alpha1.AppProject, error)
	GetAppProject(context.Context, types.NamespacedName) (*corev1alpha1.AppProject, bool, error)
	ListRepositories(context.Context) ([]*corev1alpha1.Repository, error)
	GetRepository(context.Context, types.NamespacedName) (*corev1alpha1.Repository, bool, error)
	ListClusters(context.Context) ([]*clustersv1alpha1.Cluster, error)
	GetCluster(context.Context, types.NamespacedName) (*clustersv1alpha1.Cluster, bool, error)
}

// ResourceKind identifies one of the seven CRD caches that feed the fleet
// projection.
type ResourceKind uint8

const (
	ResourceApplication ResourceKind = iota + 1
	ResourceStage
	ResourceRelease
	ResourceRollout
	ResourceAppProject
	ResourceRepository
	ResourceCluster
)

// ResourceDelta is key-only replay metadata. AffectedApplications can contain
// both sides of an association move, but it is only a set of keys to re-read;
// it is never accepted as evidence of ownership.
type ResourceDelta struct {
	Kind                 ResourceKind
	Key                  types.NamespacedName
	AffectedApplications []types.NamespacedName
}

func normalizeDelta(delta ResourceDelta) ResourceDelta {
	seen := make(map[types.NamespacedName]struct{}, len(delta.AffectedApplications))
	for _, key := range delta.AffectedApplications {
		if key.Name != "" {
			seen[key] = struct{}{}
		}
	}
	delta.AffectedApplications = make([]types.NamespacedName, 0, len(seen))
	for key := range seen {
		delta.AffectedApplications = append(delta.AffectedApplications, key)
	}
	sort.Slice(delta.AffectedApplications, func(i, j int) bool {
		if delta.AffectedApplications[i].Namespace != delta.AffectedApplications[j].Namespace {
			return delta.AffectedApplications[i].Namespace < delta.AffectedApplications[j].Namespace
		}
		return delta.AffectedApplications[i].Name < delta.AffectedApplications[j].Name
	})
	return delta
}

func validResourceKind(kind ResourceKind) bool {
	return kind >= ResourceApplication && kind <= ResourceCluster
}
