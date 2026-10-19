package apiserver

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestSatelliteClusterInventoryMarksDisconnectedObservations(t *testing.T) {
	cluster := &clusters.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "paprika-system", Name: "east"}, Spec: clusters.ClusterSpec{Mode: clusters.ClusterModeAgent, Satellite: &clusters.SatelliteSpec{TokenSecretRef: clusters.SecretRef{Name: "east-satellite-token"}}}, Status: clusters.ClusterStatus{Phase: clusters.ClusterPhaseHealthy, Inventory: &clusters.ClusterInventory{NodeCount: 3}}}
	for _, connection := range []fleet.ConnectionState{fleet.ConnectionStateHealthy, fleet.ConnectionStateUnhealthy, fleet.ConnectionStateDisabled} {
		message := clusterMessage(cluster, fleet.ClusterSummary{Connection: connection}, clusterReferences{})
		if message.Inventory.NodeCount != 3 {
			t.Fatal("lost last observed inventory")
		}
		if connection == fleet.ConnectionStateHealthy {
			if message.Inventory.State != paprikav1.DataState_DATA_STATE_OK {
				t.Fatal("connected inventory not available")
			}
		} else if message.Inventory.State != paprikav1.DataState_DATA_STATE_NOT_AVAILABLE || message.Inventory.UnavailableReason == "" {
			t.Fatal("disconnected inventory presented as current")
		}
	}
}
