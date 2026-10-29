package clusters

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// The CRD must retain an explicit empty claim through an API-server status
// write; a fake client cannot detect schema pruning or wire-format mistakes.
var _ = Describe("Satellite policy status", func() {
	It("preserves reported policies across real API-server reconciliation", func() {
		ctx := context.Background()
		key := types.NamespacedName{Namespace: "default", Name: "satellite-policy-status"}
		cluster := &clustersv1alpha1.Cluster{
			ObjectMeta: metav1.ObjectMeta{Name: key.Name, Namespace: key.Namespace},
			Spec: clustersv1alpha1.ClusterSpec{
				Mode:               clustersv1alpha1.ClusterModeDirect,
				Satellite:          &clustersv1alpha1.SatelliteSpec{TokenSecretRef: clustersv1alpha1.SecretRef{Name: "satellite-token"}},
				ManagementPolicies: []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve, clustersv1alpha1.ManagementPolicyApply},
			},
		}
		Expect(k8sClient.Create(ctx, cluster)).To(Succeed())
		DeferCleanup(func() { Expect(k8sClient.Delete(ctx, cluster)).To(Succeed()) })
		claim := []clustersv1alpha1.ManagementPolicy{clustersv1alpha1.ManagementPolicyObserve}
		now := metav1.Now()
		cluster.Status.Satellite = &clustersv1alpha1.SatelliteStatus{ClusterUID: "target", SessionID: "session", Sequence: 1, LastSeen: &now, ReportedPolicies: &claim}
		Expect(k8sClient.Status().Update(ctx, cluster)).To(Succeed())
		r := &ClusterReconciler{client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.reconcileSatellite(ctx, key)
		Expect(err).NotTo(HaveOccurred())
		var observed clustersv1alpha1.Cluster
		Expect(k8sClient.Get(ctx, key, &observed)).To(Succeed())
		Expect(observed.Status.Satellite.ReportedPolicies).NotTo(BeNil())
		Expect(*observed.Status.Satellite.ReportedPolicies).To(Equal(claim))
		Expect(observed.Status.Satellite.EffectivePolicies).To(Equal(claim))

		empty := []clustersv1alpha1.ManagementPolicy{}
		observed.Status.Satellite.ReportedPolicies = &empty
		Expect(k8sClient.Status().Update(ctx, &observed)).To(Succeed())
		_, err = r.reconcileSatellite(ctx, key)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, key, &observed)).To(Succeed())
		Expect(observed.Status.Satellite.ReportedPolicies).NotTo(BeNil())
		Expect(*observed.Status.Satellite.ReportedPolicies).To(BeEmpty())
		Expect(observed.Status.Satellite.EffectivePolicies).To(BeEmpty())
	})
})
