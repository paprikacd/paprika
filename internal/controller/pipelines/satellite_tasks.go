package pipelines

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1proto "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/satellitecontrol"
)

// SatelliteTaskDispatcher is the control plane's route to work that runs inside
// a satellite's cluster. It is an interface here rather than a concrete hub so
// the release controller depends on the two calls it makes, and so split mode
// can leave it nil.
type SatelliteTaskDispatcher interface {
	Connected(key types.NamespacedName) bool
	Dispatch(
		ctx context.Context,
		key types.NamespacedName,
		task *paprikav1proto.SatelliteTask,
	) (*paprikav1proto.SatelliteTaskResult, error)
}

// applyViaSatelliteLink tries to apply through a live link.
//
// The bool reports whether the link handled the request at all: false means no
// link is attached for this cluster, and the caller falls back to the inbound
// agent endpoint. That distinction matters because a *failed* apply over a live
// link must not be retried through a second transport — the cluster may have
// half the bundle applied, and a retry would race the satellite's own attempt.
func (r *ReleaseReconciler) applyViaSatelliteLink(
	ctx context.Context,
	cluster *paprikav1.ClusterRef,
	namespace, appName string,
	manifests []byte,
) (bool, error) {
	if r.SatelliteTasks == nil || cluster.Name == "" {
		return false, nil
	}
	key := types.NamespacedName{
		Namespace: clusterCredentialNamespace(cluster, namespace),
		Name:      cluster.Name,
	}
	if !r.SatelliteTasks.Connected(key) {
		return false, nil
	}

	dispatchCtx, cancel := context.WithTimeout(ctx, satellitecontrol.DefaultTaskTimeout)
	defer cancel()

	result, err := r.SatelliteTasks.Dispatch(dispatchCtx, key, &paprikav1proto.SatelliteTask{
		Task: &paprikav1proto.SatelliteTask_Apply{Apply: &paprikav1proto.SatelliteApplyTask{
			Namespace: namespace,
			AppName:   appName,
			Manifests: manifests,
		}},
	})
	if err != nil {
		return true, fmt.Errorf("dispatch apply to satellite %s: %w", key, err)
	}
	if !result.GetOk() {
		// The satellite's own error text is what an operator needs; it is the
		// cluster's API server answer, not credential material.
		return true, fmt.Errorf("satellite apply on %s failed: %s %v",
			key, result.GetError(), result.GetErrors())
	}
	return true, nil
}
