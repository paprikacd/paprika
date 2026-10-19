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
