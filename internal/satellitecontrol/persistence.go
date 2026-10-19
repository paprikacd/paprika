package satellitecontrol

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/satellite"
)

func (h *Handler) authorizedCluster(ctx context.Context, r *satellite.Report, token string) (*clusters.Cluster, error) {
	key := client.ObjectKey{Namespace: r.ClusterNamespace, Name: r.ClusterName}
	var cluster clusters.Cluster
	err := h.client.Get(ctx, key, &cluster)
	if apierrors.IsNotFound(err) {
		cluster = clusters.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: key.Name},
			Spec: clusters.ClusterSpec{Mode: clusters.ClusterModeAgent, DisplayName: r.DisplayName,
				Satellite: &clusters.SatelliteSpec{TokenSecretRef: clusters.SecretRef{Name: key.Name + "-satellite-token", Key: "token"}}}}
		if enrollErr := h.enrollCluster(ctx, &cluster, r, token); enrollErr != nil {
			return nil, enrollErr
		}
	} else if err != nil {
		return nil, fmt.Errorf("read satellite registration: %w", err)
	}
	if !acceptsReports(&cluster) {
		return nil, refuse(http.StatusForbidden, "cluster does not accept satellite reports")
	}
	if err := h.authorize(ctx, &cluster, token); err != nil {
		return nil, err
	}
	return &cluster, nil
}

func acceptsReports(cluster *clusters.Cluster) bool {
	return (cluster.Spec.Mode == clusters.ClusterModeAgent || cluster.Spec.Mode == clusters.ClusterModeDirect) &&
		cluster.Spec.Satellite != nil && !cluster.Spec.Disabled && cluster.DeletionTimestamp == nil
}

func (h *Handler) enrollCluster(ctx context.Context, cluster *clusters.Cluster, r *satellite.Report, token string) error {
	if err := h.authorize(ctx, cluster, token); err != nil {
		return err
	}
	if err := requireSnapshot(r); err != nil {
		return err
	}
	if err := h.client.Create(ctx, cluster); err != nil {
		return fmt.Errorf("create satellite registration: %w", err)
	}
	return nil
}

func buildBaseline(old *clusters.SatelliteStatus, r *satellite.Report, digest string) (*clusters.SatelliteStatus, error) {
	apps := make(map[string]clusters.SatelliteApplication)
	if old != nil && !r.Snapshot {
		for i := range old.Applications {
			a := &old.Applications[i]
			apps[a.Namespace+"/"+a.Name] = *a
		}
	}
	for i := range r.Applications {
		a := &r.Applications[i]
		apps[a.Key()] = statusApplication(a)
	}
	for _, key := range r.DeletedApplications {
		delete(apps, key)
	}
	if len(apps) > satellite.MaxApplications {
		return nil, refuse(http.StatusRequestEntityTooLarge, "application inventory exceeds limit")
	}
	now := metav1.Now()
	state := &clusters.SatelliteStatus{ClusterUID: r.ClusterUID, SessionID: r.SessionID,
		Sequence: reportSequence(r), ReportDigest: digest, RetiredSessions: retiredSessions(old, r),
		LastSeen: &now, Applications: sortedApplications(apps)}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("encode persisted satellite state: %w", err)
	}
	if len(stateJSON) > satellite.MaxReportBytes {
		return nil, refuse(http.StatusRequestEntityTooLarge, "application inventory exceeds byte limit")
	}
	return state, nil
}

func statusApplication(a *satellite.Application) clusters.SatelliteApplication {
	return clusters.SatelliteApplication{Namespace: a.Namespace, Name: a.Name, Identity: a.Identity,
		Project: a.Project, Health: a.Health, Phase: a.Phase, OutOfSync: a.OutOfSync, SyncKnown: a.SyncKnown,
		ResourceCount: a.ResourceCount, SourceRevision: a.SourceRevision}
}

func sortedApplications(apps map[string]clusters.SatelliteApplication) []clusters.SatelliteApplication {
	keys := make([]string, 0, len(apps))
	for key := range apps {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	values := make([]clusters.SatelliteApplication, 0, len(keys))
	for _, key := range keys {
		values = append(values, apps[key])
	}
	return values
}

func retiredSessions(old *clusters.SatelliteStatus, r *satellite.Report) []string {
	if old == nil {
		return nil
	}
	retired := append([]string(nil), old.RetiredSessions...)
	if old.SessionID != r.SessionID {
		retired = append(retired, old.SessionID)
		if len(retired) > 16 {
			retired = retired[len(retired)-16:]
		}
	}
	return retired
}

func applyReportStatus(cluster *clusters.Cluster, r *satellite.Report, state *clusters.SatelliteStatus) {
	now := *state.LastSeen
	cluster.Status.Satellite = state
	cluster.Status.Inventory = r.Inventory.DeepCopy()
	cluster.Status.Version = r.KubernetesVersion
	cluster.Status.AgentInfo = &clusters.AgentInfo{Version: r.Version, Connected: &now}
	cluster.Status.LastHealthCheckTime = &now
	cluster.Status.ObservedGeneration = cluster.Generation
	cluster.Status.Phase = clusters.ClusterPhaseHealthy
	for i := range cluster.Status.Conditions {
		if cluster.Status.Conditions[i].Type != string(clusters.ClusterPhaseHealthy) {
			cluster.Status.Conditions[i].Status = metav1.ConditionFalse
		}
	}
	meta.SetStatusCondition(&cluster.Status.Conditions, metav1.Condition{Type: string(clusters.ClusterPhaseHealthy),
		Status: metav1.ConditionTrue, Reason: "SatelliteConnected", Message: "satellite inventory is current",
		ObservedGeneration: cluster.Generation, LastTransitionTime: now})
}
