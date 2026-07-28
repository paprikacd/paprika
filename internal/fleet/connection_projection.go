package fleet

import (
	"strings"

	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func projectRepositorySummary(repository *corev1alpha1.Repository) RepositorySummary {
	if repository == nil {
		return RepositorySummary{}
	}
	summary := RepositorySummary{
		Identity: types.NamespacedName{Namespace: repository.Namespace, Name: repository.Name},
	}
	if repository.Status.ConnectionState == nil {
		return summary
	}
	switch repository.Status.ConnectionState.Status {
	case corev1alpha1.ConnectionStatusSuccessful:
		summary.Connection = ConnectionStateHealthy
	case corev1alpha1.ConnectionStatusFailed:
		summary.Connection = ConnectionStateUnhealthy
	case corev1alpha1.ConnectionStatusUnknown:
	default:
	}
	return summary
}

func projectClusterSummary(cluster *clustersv1alpha1.Cluster) ClusterSummary {
	if cluster == nil {
		return ClusterSummary{}
	}
	summary := ClusterSummary{
		Identity:    types.NamespacedName{Namespace: cluster.Namespace, Name: cluster.Name},
		DisplayName: strings.TrimSpace(cluster.Spec.DisplayName),
	}
	if summary.DisplayName == "" {
		summary.DisplayName = cluster.Name
	}
	if cluster.Spec.Disabled || cluster.Status.Phase == clustersv1alpha1.ClusterPhaseDisabled {
		summary.Connection = ConnectionStateDisabled
		return summary
	}
	switch cluster.Status.Phase {
	case clustersv1alpha1.ClusterPhaseHealthy:
		summary.Connection = ConnectionStateHealthy
	case clustersv1alpha1.ClusterPhaseUnhealthy:
		summary.Connection = ConnectionStateUnhealthy
	case clustersv1alpha1.ClusterPhasePending, clustersv1alpha1.ClusterPhaseDisabled:
	default:
	}
	return summary
}

func projectRepositoryConnection(
	application *pipelinesv1alpha1.Application,
	repositories map[RepositoryKey]RepositorySummary,
) (RepositoryKey, ConnectionState) {
	if application == nil || strings.TrimSpace(application.Spec.Source.RepoRef) == "" {
		return RepositoryKey{}, ConnectionStateNotConfigured
	}
	key := RepositoryKey{Namespace: application.Namespace, Name: application.Spec.Source.RepoRef}
	if repository, ok := repositories[key]; ok {
		return key, repository.Connection
	}
	return key, ConnectionStateUnhealthy
}

func projectStageConnection(
	stage *pipelinesv1alpha1.Stage,
	application *pipelinesv1alpha1.Application,
	clusters map[ClusterKey]ClusterSummary,
) (StageTargetSummary, bool) {
	target := StageTargetSummary{
		StableID: stageStableID(stage),
		Stage:    stage.Spec.Name,
		Ring:     clampInt32(stage.Spec.Ring),
		Health:   stageHealth(application.Status.Stages, stage.Spec.Name),
	}
	ref := stage.Spec.Cluster
	if ref.Name == "" {
		target.ClusterLabel = inlineClusterLabel
		target.ClusterConnection = ConnectionStateNotConfigured
		target.UnmanagedInlineCluster = hasInlineClusterConfiguration(&ref)
		return target, false
	}

	namespace := ref.Namespace
	if namespace == "" {
		namespace = stage.Namespace
	}
	target.Cluster = ClusterKey{Namespace: namespace, Name: ref.Name}
	target.ClusterLabel = ref.Name
	if hasInlineClusterConfiguration(&ref) {
		// A named reference is strict. Inline connection fields are invalid and
		// must never be used as a fallback or combined with a Cluster CR.
		target.ClusterConnection = ConnectionStateUnhealthy
		return target, true
	}
	cluster, ok := clusters[target.Cluster]
	if !ok {
		target.ClusterConnection = ConnectionStateUnhealthy
		return target, false
	}
	target.ClusterLabel = cluster.DisplayName
	if target.ClusterLabel == "" {
		target.ClusterLabel = ref.Name
	}
	target.ClusterConnection = cluster.Connection
	return target, false
}

func hasInlineClusterConfiguration(ref *pipelinesv1alpha1.ClusterRef) bool {
	return ref.Mode != "" || ref.Server != "" || ref.AgentAddress != "" ||
		ref.KubeconfigSecret != "" || ref.ServiceAccount != ""
}
