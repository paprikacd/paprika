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

package pipelines

import (
	"context"
	"testing"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/oci"
)

var _ = ginkgo.Describe("Artifact Controller", func() {
	ginkgo.Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		artifact := &pipelinesv1alpha1.Artifact{}

		ginkgo.BeforeEach(func() {
			ginkgo.By("creating the custom resource for the Kind Artifact")
			err := k8sClient.Get(ctx, typeNamespacedName, artifact)
			if err != nil && errors.IsNotFound(err) {
				resource := &pipelinesv1alpha1.Artifact{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.ArtifactSpec{
						Type:      "oci",
						Reference: "test:v1",
					},
				}
				gomega.Expect(k8sClient.Create(ctx, resource)).To(gomega.Succeed())
			}
		})

		ginkgo.AfterEach(func() {
			resource := &pipelinesv1alpha1.Artifact{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			ginkgo.By("Cleanup the specific resource instance Artifact")
			gomega.Expect(k8sClient.Delete(ctx, resource)).To(gomega.Succeed())
		})

		ginkgo.It("should successfully reconcile the resource", func() {
			ginkgo.By("Reconciling the created resource")
			controllerReconciler := &ArtifactReconciler{
				client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Verifier: oci.NopVerifier{},
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			ginkgo.By("Checking the artifact status is verified")
			updated := &pipelinesv1alpha1.Artifact{}
			gomega.Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(gomega.Succeed())
			gomega.Expect(updated.Status.Verified).To(gomega.BeTrue())
			gomega.Expect(updated.Status.ObservedGeneration).To(gomega.Equal(updated.Generation))
			gomega.Expect(updated.Status.Conditions).To(gomega.HaveLen(1))
			gomega.Expect(updated.Status.Conditions[0].Type).To(gomega.Equal("Ready"))
			gomega.Expect(updated.Status.Conditions[0].Status).To(gomega.Equal(metav1.ConditionTrue))
		})

		ginkgo.It("should detect digest mismatch", func() {
			ginkgo.By("Updating artifact with expected digest")
			existing := &pipelinesv1alpha1.Artifact{}
			gomega.Expect(k8sClient.Get(ctx, typeNamespacedName, existing)).To(gomega.Succeed())
			existing.Spec.Digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
			gomega.Expect(k8sClient.Update(ctx, existing)).To(gomega.Succeed())

			ginkgo.By("Reconciling with a mismatched verifier")
			controllerReconciler := &ArtifactReconciler{
				client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Verifier: oci.NopVerifier{},
			}
			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			gomega.Expect(err).NotTo(gomega.HaveOccurred())

			ginkgo.By("Checking the artifact status reports digest mismatch")
			updated := &pipelinesv1alpha1.Artifact{}
			gomega.Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(gomega.Succeed())
			gomega.Expect(updated.Status.Verified).To(gomega.BeFalse())
			gomega.Expect(updated.Status.Conditions).To(gomega.HaveLen(1))
			gomega.Expect(updated.Status.Conditions[0].Status).To(gomega.Equal(metav1.ConditionFalse))
			gomega.Expect(updated.Status.Conditions[0].Reason).To(gomega.Equal("DigestMismatch"))
		})
	})
})

func TestArtifactReconciler_ConfigMapReady(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "cm-artifact", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "configmap",
			Reference: "my-cm/my-key",
		},
	}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "my-cm", Namespace: "default"},
		Data:       map[string]string{"my-key": "my-value"},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact, cm).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "cm-artifact", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "cm-artifact", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	if !got.Status.Verified {
		t.Fatalf("expected artifact verified")
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected Ready condition true, got %+v", cond)
	}
	if cond.Reason != "Verified" {
		t.Fatalf("expected reason Verified, got %s", cond.Reason)
	}
}

func TestArtifactReconciler_ConfigMapNotFound(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "cm-not-found", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "configmap",
			Reference: "missing-cm/key",
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "cm-not-found", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "cm-not-found", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	if got.Status.Verified {
		t.Fatalf("expected artifact not verified")
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != "ConfigMapNotFound" {
		t.Fatalf("expected Ready=False ConfigMapNotFound, got %+v", cond)
	}
}

func TestArtifactReconciler_ConfigMapKeyNotFound(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "cm-key-not-found", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "configmap",
			Reference: "my-cm/wrong-key",
		},
	}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "my-cm", Namespace: "default"},
		Data:       map[string]string{"existing-key": "value"},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact, cm).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "cm-key-not-found", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "cm-key-not-found", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != "KeyNotFound" {
		t.Fatalf("expected Ready=False KeyNotFound, got %+v", cond)
	}
}

func TestArtifactReconciler_ConfigMapAmbiguousKeys(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "cm-ambiguous", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "configmap",
			Reference: "my-cm",
		},
	}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "my-cm", Namespace: "default"},
		Data: map[string]string{
			"key-a": "value-a",
			"key-b": "value-b",
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact, cm).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "cm-ambiguous", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "cm-ambiguous", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != "AmbiguousKeys" {
		t.Fatalf("expected Ready=False AmbiguousKeys, got %+v", cond)
	}
}

type fakeVerifier struct {
	digest string
	err    error
}

func (f *fakeVerifier) Verify(_ context.Context, _ string) (string, error) {
	return f.digest, f.err
}

func TestArtifactReconciler_OCIReady(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "oci-artifact", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "oci",
			Reference: "registry.io/repo:tag",
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c, Verifier: &fakeVerifier{digest: "sha256:abc123"}}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "oci-artifact", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "oci-artifact", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	if !got.Status.Verified {
		t.Fatalf("expected artifact verified")
	}
	if got.Status.ResolvedDigest != "sha256:abc123" {
		t.Fatalf("expected resolved digest sha256:abc123, got %s", got.Status.ResolvedDigest)
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "Verified" {
		t.Fatalf("expected Ready=True Verified, got %+v", cond)
	}
}

func TestArtifactReconciler_OCIDigestMismatch(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "oci-digest-mismatch", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "oci",
			Reference: "registry.io/repo:tag",
			Digest:    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c, Verifier: &fakeVerifier{digest: "sha256:abc123"}}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "oci-digest-mismatch", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "oci-digest-mismatch", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	if got.Status.Verified {
		t.Fatalf("expected artifact not verified")
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != "DigestMismatch" {
		t.Fatalf("expected Ready=False DigestMismatch, got %+v", cond)
	}
}

func TestArtifactReconciler_OCIInvalidReference(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)

	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{Name: "oci-invalid", Namespace: "default"},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "oci",
			Reference: "registry.io/repo:tag",
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact).WithStatusSubresource(&pipelinesv1alpha1.Artifact{}).Build()
	r := &ArtifactReconciler{client: c, Verifier: &fakeVerifier{err: context.DeadlineExceeded}}

	_, err := r.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "oci-invalid", Namespace: "default"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var got pipelinesv1alpha1.Artifact
	if err := c.Get(context.Background(), types.NamespacedName{Name: "oci-invalid", Namespace: "default"}, &got); err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != "VerificationFailed" {
		t.Fatalf("expected Ready=False VerificationFailed, got %+v", cond)
	}
}
