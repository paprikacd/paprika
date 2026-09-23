/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

func validCluster() *clustersv1alpha1.Cluster {
	return &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "c", Namespace: "ns"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeInCluster},
	}
}

func TestValidateClusterProvider(t *testing.T) {
	t.Parallel()

	t.Run("auto provider is valid", func(t *testing.T) {
		t.Parallel()
		cluster := validCluster()
		cluster.Spec.Provider = &clustersv1alpha1.ClusterProviderSpec{Type: "auto"}
		require.NoError(t, validateCluster(cluster))
	})

	t.Run("vultr needs no identity fields", func(t *testing.T) {
		t.Parallel()
		cluster := validCluster()
		cluster.Spec.Provider = &clustersv1alpha1.ClusterProviderSpec{
			Type: "vultr",
			CredentialsSecretRef: &clustersv1alpha1.SecretRef{
				Name: "vultr-key", Key: "credentials",
			},
		}
		require.NoError(t, validateCluster(cluster))
	})

	t.Run("credentials ref without name rejected", func(t *testing.T) {
		t.Parallel()
		cluster := validCluster()
		cluster.Spec.Provider = &clustersv1alpha1.ClusterProviderSpec{
			Type:                 "vultr",
			CredentialsSecretRef: &clustersv1alpha1.SecretRef{Key: "credentials"},
		}
		require.Error(t, validateCluster(cluster))
	})

	t.Run("aks requires full identity", func(t *testing.T) {
		t.Parallel()
		cluster := validCluster()
		cluster.Spec.Provider = &clustersv1alpha1.ClusterProviderSpec{Type: "aks", ClusterID: "c"}
		require.Error(t, validateCluster(cluster))

		cluster.Spec.Provider.SubscriptionID = "sub"
		cluster.Spec.Provider.Project = "rg"
		require.NoError(t, validateCluster(cluster))
	})

	t.Run("gke requires cluster name", func(t *testing.T) {
		t.Parallel()
		cluster := validCluster()
		cluster.Spec.Provider = &clustersv1alpha1.ClusterProviderSpec{Type: "gke", Project: "p"}
		require.Error(t, validateCluster(cluster))

		cluster.Spec.Provider.ClusterID = "prod-gke"
		require.NoError(t, validateCluster(cluster))
	})

	t.Run("gke requires project or credential", func(t *testing.T) {
		t.Parallel()
		cluster := validCluster()
		cluster.Spec.Provider = &clustersv1alpha1.ClusterProviderSpec{Type: "gke", ClusterID: "c"}
		require.Error(t, validateCluster(cluster))

		cluster.Spec.Provider.CredentialsSecretRef = &clustersv1alpha1.SecretRef{Name: "gcp-creds"}
		require.NoError(t, validateCluster(cluster))
	})
}
