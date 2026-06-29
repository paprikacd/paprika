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

package controller

import (
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
)

// NOTE: This file is `package controller` (the same package as
// rollout_controller.go). It refers to RolloutReconciler directly — no import
// of the package itself.

var _ = Describe("RolloutReconciler canary", func() {
	var (
		ro    *rolloutsv1alpha1.Rollout
		clk   *clock.Fake
		recon *RolloutReconciler
	)

	BeforeEach(func() {
		clk = newFakeClock()
		recon = &RolloutReconciler{
			Scheme: mgr.GetScheme(),
			Clock:  clk,
			Client: k8sClient,
		}

		ro = &rolloutsv1alpha1.Rollout{
			ObjectMeta: metav1.ObjectMeta{
				Name:       "canary-adv",
				Namespace:  "default",
				Finalizers: []string{rolloutFinalizer},
			},
			Spec: rolloutsv1alpha1.RolloutSpec{
				Replicas: int32Ptr(4),
				Strategy: rolloutsv1alpha1.RolloutStrategy{
					Type: "Canary",
					Canary: &rolloutsv1alpha1.CanaryStrategy{
						StableService: "canary-adv-stable",
						CanaryService: "canary-adv-canary",
						Steps: []rolloutsv1alpha1.CanaryStep{
							{SetWeight: 25, Duration: &metav1.Duration{Duration: time.Minute}},
							{SetWeight: 50, Duration: &metav1.Duration{Duration: time.Minute}},
							{SetWeight: 100},
						},
					},
				},
				Template: podTemplate("v1"),
			},
		}
		Expect(k8sClient.Create(ctx, ro)).To(Succeed())

		// Tests invoke Reconcile by hand; there is no background controller to
		// finalize deletion. Strip the finalizer and delete the Rollout plus
		// any RSes/Services it created (envtest GC is not guaranteed to run).
		//nolint:dupl // envtest cleanup mirrored across the canary/abort Describes (no GC controller).
		DeferCleanup(func() {
			labelOpt := client.MatchingLabels{"rollouts.paprika.io/rollout": ro.Name}
			nsOpt := client.InNamespace(ro.Namespace)

			if err := k8sClient.Get(ctx, objKey(ro), ro); err == nil {
				ro.Finalizers = nil
				_ = k8sClient.Update(ctx, ro)
				_ = client.IgnoreNotFound(k8sClient.Delete(ctx, ro))
			}
			var rsList appsv1.ReplicaSetList
			_ = k8sClient.List(ctx, &rsList, nsOpt, labelOpt)
			for i := range rsList.Items {
				_ = client.IgnoreNotFound(k8sClient.Delete(ctx, &rsList.Items[i]))
			}
			var svcList corev1.ServiceList
			_ = k8sClient.List(ctx, &svcList, nsOpt, labelOpt)
			for i := range svcList.Items {
				_ = client.IgnoreNotFound(k8sClient.Delete(ctx, &svcList.Items[i]))
			}
		})
	})

	It("creates the stable ReplicaSet on the first reconcile", func() {
		_, err := recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.StableRS).NotTo(BeEmpty())
	})

	It("advances through steps as their durations elapse", func() {
		var err error
		// Reconcile 0: creates the stable RS at template v1.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())

		// Update template to trigger canary.
		ro.Spec.Template = podTemplate("v2")
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())

		// Reconcile 1: stable exists, canary RS is created. The strategy's
		// advancement switch is NOT entered this reconcile (the canary-creation
		// block returns first), so CurrentStepStartedAt is still nil.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CanaryRS).NotTo(BeEmpty(), "canary RS should be created")
		Expect(ro.Status.CurrentStepIndex).To(Equal(int32(0)))
		Expect(ro.Status.CurrentStepStartedAt).To(BeNil(), "step 0 not yet entered on canary-creation reconcile")

		// Reconcile 2: strategy enters step 0 (Duration=60s) and stamps
		// CurrentStepStartedAt. Does NOT advance yet.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CurrentStepStartedAt).NotTo(BeNil(), "step 0 start should be stamped")

		// Advance clock 61s — step 0 (60s duration) should advance to step 1.
		// Reconcile 3: elapsed >= Duration, advances index to 1 and CLEARS CurrentStepStartedAt.
		clk.Add(61 * time.Second)
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CurrentStepIndex).To(Equal(int32(1)), "step 0 should have advanced after duration")
		Expect(ro.Status.CurrentStepStartedAt).To(BeNil(), "CurrentStepStartedAt cleared on advance")

		// Step 1 (Duration=60s) needs a stamp reconcile + an advance reconcile.
		// Reconcile 4: enters step 1, stamps.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CurrentStepStartedAt).NotTo(BeNil(), "step 1 start should be stamped")

		clk.Add(61 * time.Second)
		// Reconcile 5: advances step 1 → 2.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CurrentStepIndex).To(Equal(int32(2)))

		// Step 2 has no Duration — on the next reconcile the strategy advances
		// index to 3 and returns ActionPromote (Phase=Progressing) because
		// stableHash != hash yet.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CurrentStepIndex).To(Equal(int32(3)))
		Expect(ro.Status.Phase).To(Equal(rolloutsv1alpha1.RolloutPhaseProgressing))

		// One more reconcile: the controller applied the new stable RS, so
		// status.StableRS now points at template v2. stableHash == hash and
		// the strategy returns ActionComplete / Phase=Healthy.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.Phase).To(Equal(rolloutsv1alpha1.RolloutPhaseHealthy))
	})
})

var _ = Describe("RolloutReconciler abort", func() {
	var (
		ro    *rolloutsv1alpha1.Rollout
		clk   *clock.Fake
		recon *RolloutReconciler
	)

	BeforeEach(func() {
		clk = newFakeClock()
		recon = &RolloutReconciler{
			Scheme: mgr.GetScheme(),
			Clock:  clk,
			Client: k8sClient,
		}
		ro = &rolloutsv1alpha1.Rollout{
			ObjectMeta: metav1.ObjectMeta{
				Name:       "abort-test",
				Namespace:  "default",
				Finalizers: []string{rolloutFinalizer}, // pre-set to skip finalizer-add reconcile
			},
			Spec: rolloutsv1alpha1.RolloutSpec{
				Replicas: int32Ptr(2),
				Strategy: rolloutsv1alpha1.RolloutStrategy{
					Type: "Canary",
					Canary: &rolloutsv1alpha1.CanaryStrategy{
						Steps:         []rolloutsv1alpha1.CanaryStep{{SetWeight: 25, Duration: &metav1.Duration{Duration: time.Minute}}},
						StableService: "abort-test-stable",
						CanaryService: "abort-test-canary",
					},
				},
				Template: podTemplate("v1"),
			},
		}
		Expect(k8sClient.Create(ctx, ro)).To(Succeed())
		// Bring the rollout to a canary-in-progress state.
		var err error
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		ro.Spec.Template = podTemplate("v2")
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())

		// Strip the finalizer so the Rollout can be deleted; envtest doesn't
		// run a background controller to finalize. Also clean up RSes/Services
		// (ownerRef GC doesn't fire without kube-controller-manager).
		//nolint:dupl // envtest cleanup mirrored across the canary/abort Describes (no GC controller).
		DeferCleanup(func() {
			labelOpt := client.MatchingLabels{"rollouts.paprika.io/rollout": ro.Name}
			nsOpt := client.InNamespace(ro.Namespace)

			if err := k8sClient.Get(ctx, objKey(ro), ro); err == nil {
				ro.Finalizers = nil
				_ = k8sClient.Update(ctx, ro)
				_ = client.IgnoreNotFound(k8sClient.Delete(ctx, ro))
			}
			var rsList appsv1.ReplicaSetList
			_ = k8sClient.List(ctx, &rsList, nsOpt, labelOpt)
			for i := range rsList.Items {
				_ = client.IgnoreNotFound(k8sClient.Delete(ctx, &rsList.Items[i]))
			}
			var svcList corev1.ServiceList
			_ = k8sClient.List(ctx, &svcList, nsOpt, labelOpt)
			for i := range svcList.Items {
				_ = client.IgnoreNotFound(k8sClient.Delete(ctx, &svcList.Items[i]))
			}
		})
	})

	It("sets status.Abort when the annotation is added", func() {
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		ro.Annotations = map[string]string{"paprika.io/abort": ""}
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())
		_, err := recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.Abort).To(BeTrue(), "status.Abort should be set when annotation is present")
		Expect(ro.Status.Phase).To(Equal(rolloutsv1alpha1.RolloutPhaseAborted))
	})

	It("clears status.Abort when annotation is removed AND pod template changes", func() {
		// First abort.
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		ro.Annotations = map[string]string{"paprika.io/abort": ""}
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())
		var err error
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())

		// Then remove annotation but keep template — should still be aborted
		// (status.Abort durable until template changes).
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		ro.Annotations = map[string]string{}
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.Abort).To(BeTrue(), "abort should persist after annotation removal without template change")

		// Now bump the template — abort should clear and rollout restart.
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		ro.Spec.Template = podTemplate("v3")
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.Abort).To(BeFalse())
	})
})

var _ = Describe("RolloutReconciler rolling", func() {
	var (
		ro    *rolloutsv1alpha1.Rollout
		clk   *clock.Fake
		recon *RolloutReconciler
	)

	BeforeEach(func() {
		clk = newFakeClock()
		recon = &RolloutReconciler{
			Scheme: mgr.GetScheme(),
			Clock:  clk,
			Client: k8sClient,
		}
		surge := intstr.FromInt32(1)
		unavail := intstr.FromInt32(0)
		ro = &rolloutsv1alpha1.Rollout{
			ObjectMeta: metav1.ObjectMeta{
				Name:       "rolling-ramp",
				Namespace:  "default",
				Finalizers: []string{rolloutFinalizer},
			},
			Spec: rolloutsv1alpha1.RolloutSpec{
				Replicas: int32Ptr(3),
				Strategy: rolloutsv1alpha1.RolloutStrategy{
					Type: "Rolling",
					Rolling: &rolloutsv1alpha1.RollingStrategy{
						MaxSurge:       &surge,
						MaxUnavailable: &unavail,
					},
				},
				Template: podTemplate("v1"),
			},
		}
		Expect(k8sClient.Create(ctx, ro)).To(Succeed())

		DeferCleanup(func() {
			Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
			ro.Finalizers = nil
			Expect(k8sClient.Update(ctx, ro)).To(Succeed())
			Expect(k8sClient.Delete(ctx, ro)).To(Succeed())
			Expect(k8sClient.DeleteAllOf(ctx, &appsv1.ReplicaSet{}, client.InNamespace(ro.Namespace), client.MatchingLabels{"rollouts.paprika.io/rollout": ro.Name})).To(Succeed())
			Expect(k8sClient.DeleteAllOf(ctx, &corev1.Service{}, client.InNamespace(ro.Namespace), client.MatchingLabels{"rollouts.paprika.io/rollout": ro.Name})).To(Succeed())
		})
	})

	It("observes ReplicaSet readiness and populates SyncInputs for the strategy", func() {
		// Reconcile 0: create stable RS at v1.
		var err error
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		stableName := ro.Status.StableRS
		Expect(stableName).NotTo(BeEmpty())

		// Mark stable RS fully ready (3 replicas).
		setRSReady(stableName, 3)

		// Bump template to trigger rolling update.
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		ro.Spec.Template = podTemplate("v2")
		Expect(k8sClient.Update(ctx, ro)).To(Succeed())

		// Reconcile 1: surge new RS to 1, hold old at 3.
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())
		Expect(ro.Status.CanaryRS).NotTo(BeEmpty(), "canary RS should be created")

		// Mark the new (canary) RS as having 1 ready pod.
		setRSReady(ro.Status.CanaryRS, 1)

		// Reconcile 2: the controller must observe both readiness counts and
		// feed them into SyncInputs. With surge=1, unavail=0, desired=3,
		// oldReady=3, newReady=1, the strategy should compute:
		//   phase 1: available=4 > floor=3, scaleDownBy=1 → oldTarget=2
		//   phase 2: newTarget = 3+1-2 = 2
		_, err = recon.Reconcile(ctx, reqFor(ro))
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, objKey(ro), ro)).To(Succeed())

		// Verify the old RS was scaled down to 2 (proves readiness observation worked).
		var oldRS appsv1.ReplicaSet
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: stableName, Namespace: "default"}, &oldRS)).To(Succeed())
		Expect(*oldRS.Spec.Replicas).To(Equal(int32(2)), "old RS should be scaled to 2 when new RS has 1 ready pod")
	})
})

func reqFor(ro *rolloutsv1alpha1.Rollout) ctrl.Request {
	return ctrl.Request{NamespacedName: types.NamespacedName{Name: ro.Name, Namespace: ro.Namespace}}
}

func objKey(ro *rolloutsv1alpha1.Rollout) types.NamespacedName {
	return types.NamespacedName{Name: ro.Name, Namespace: ro.Namespace}
}

func int32Ptr(i int32) *int32 { return &i }

// setRSReady is a shared envtest helper. It updates a ReplicaSet's
// ReadyReplicas/Replicas status subresource.
func setRSReady(rsName string, ready int32) {
	if rsName == "" {
		return
	}
	var rs appsv1.ReplicaSet
	Expect(k8sClient.Get(ctx, types.NamespacedName{Name: rsName, Namespace: "default"}, &rs)).To(Succeed())
	rs.Status.ReadyReplicas = ready
	rs.Status.Replicas = ready
	Expect(k8sClient.Status().Update(ctx, &rs)).To(Succeed())
}

func podTemplate(version string) corev1.PodTemplateSpec {
	return corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "test", "version": version}},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app", Image: "nginx:" + version}},
		},
	}
}
