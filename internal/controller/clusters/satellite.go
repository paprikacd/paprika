package clusters

import (
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clusterprovider"
)

// Re-read on every conflict and change only phase/conditions. The report
// receiver owns the inventory and sequence fence; stale health reconciles must
// never overwrite a concurrently accepted satellite delta.
func (r *ClusterReconciler) reconcileSatellite(ctx context.Context, key types.NamespacedName) (ctrl.Result, error) {
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var cluster clustersv1alpha1.Cluster
		if err := r.client.Get(ctx, key, &cluster); err != nil {
			return fmt.Errorf("read satellite cluster: %w", err)
		}
		phase, reason, message := clustersv1alpha1.ClusterPhasePending, "AwaitingSatellite", "waiting for the satellite's initial inventory"
		if cluster.Spec.Disabled {
			phase, reason, message = clustersv1alpha1.ClusterPhaseDisabled, "Disabled", "cluster is disabled"
		} else if cluster.Status.Satellite != nil && cluster.Status.Satellite.LastSeen != nil {
			phase, reason, message = clustersv1alpha1.ClusterPhaseUnhealthy, "SatelliteDisconnected", "satellite inventory is stale"
			if time.Since(cluster.Status.Satellite.LastSeen.Time) <= clustersv1alpha1.SatelliteTimeout(&cluster) {
				phase, reason, message = clustersv1alpha1.ClusterPhaseHealthy, "SatelliteConnected", "satellite inventory is current"
			}
		}
		cluster.Status.Phase = phase
		cluster.Status.ObservedGeneration = cluster.Generation
		applySatelliteStatus(&cluster)
		for i := range cluster.Status.Conditions {
			if cluster.Status.Conditions[i].Type != string(phase) {
				cluster.Status.Conditions[i].Status = metav1.ConditionFalse
			}
		}
		meta.SetStatusCondition(&cluster.Status.Conditions, metav1.Condition{Type: string(phase), Status: metav1.ConditionTrue, Reason: reason, Message: message, ObservedGeneration: cluster.Generation, LastTransitionTime: metav1.Now()})
		return r.client.Status().Update(ctx, &cluster)
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("update satellite cluster health: %w", err)
	}
	return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
}

// applySatelliteStatus folds declaration and observation into the status fields
// a satellite registration owns.
//
// It runs on every health reconcile rather than only on report acceptance, so a
// spec edit (a narrowed policy ceiling, a cluster set to disabled) is reflected
// without waiting for the next heartbeat — and so a cluster whose satellite has
// gone silent still reports the last accepted claim under the current ceiling.
func applySatelliteStatus(cluster *clustersv1alpha1.Cluster) {
	state := cluster.Status.Satellite
	if state == nil {
		return
	}
	// A registration created before this field was introduced has no known
	// claim until its next report. Do not infer satellite permissions from the
	// cluster ceiling alone.
	state.EffectivePolicies = nil
	if state.ReportedPolicies != nil {
		state.EffectivePolicies = paprikav1.IntersectManagementPolicies(
			cluster.Spec.ManagementPolicies, *state.ReportedPolicies)
	}
	if cluster.Spec.Disabled {
		state.OperatingState = clustersv1alpha1.SatelliteOperatingDisabled
	}
	cluster.Status.Provider = satelliteProviderStatus(state)
}

// satelliteProviderStatus projects provider facts the satellite observed into
// the same status shape a directly-read cluster fills.
//
// The provider *type* and the node-pool breakdown come from the satellite, so a
// cluster the control plane cannot dial still shows its pools. The state is
// NotConfigured even when a type was detected, because the provider API has not
// answered here: reporting OK would claim autoscaler bounds and plan sizes this
// control plane never asked for.
func satelliteProviderStatus(state *clustersv1alpha1.SatelliteStatus) *clustersv1alpha1.ClusterProviderStatus {
	if state == nil || (state.ProviderType == "" && len(state.NodePools) == 0) {
		return nil
	}
	status := &clustersv1alpha1.ClusterProviderStatus{
		Type:      state.ProviderType,
		NodePools: append([]clustersv1alpha1.ClusterNodePool(nil), state.NodePools...),
	}
	if state.LastSeen != nil {
		observed := state.LastSeen.DeepCopy()
		status.ObservedAt = observed
	}
	if state.ProviderType != "" {
		status.State = clusterprovider.StateNotConfigured
		status.Reason = "provider detected from satellite inventory; set spec.provider.clusterId and credentials to enrich it from the provider API"
	}
	return status
}
