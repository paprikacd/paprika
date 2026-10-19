package v1alpha1

import (
	"testing"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

func TestSatelliteRegistrationValidation(t *testing.T) {
	cluster := validCluster()
	cluster.Spec.Mode = clusters.ClusterModeAgent
	cluster.Spec.Satellite = &clusters.SatelliteSpec{TokenSecretRef: clusters.SecretRef{Name: "satellite-token"}}
	if err := validateCluster(cluster); err != nil {
		t.Fatal(err)
	}
	cluster.Spec.Satellite.TokenSecretRef.Namespace = "another-tenant"
	if err := validateCluster(cluster); err == nil {
		t.Fatal("cross-namespace credential accepted")
	}
	cluster.Spec.Satellite.TokenSecretRef.Namespace = cluster.Namespace
	cluster.Spec.Satellite.TokenSecretRef.Name = ""
	if err := validateCluster(cluster); err == nil {
		t.Fatal("missing credential name accepted")
	}
	cluster.Spec.Satellite.TokenSecretRef.Name = "satellite-token"
	cluster.Spec.Mode = clusters.ClusterModeInCluster
	if err := validateCluster(cluster); err == nil {
		t.Fatal("satellite spec accepted on local cluster")
	}
}
