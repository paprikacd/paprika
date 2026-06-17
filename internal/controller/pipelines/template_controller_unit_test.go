package controller

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func newTemplateTestClient(objs ...client.Object) client.Client {
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

func TestTemplateReconciler_propagateSyncTrigger(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name       string
		annotation string
	}{
		{"sync annotation", "paprika.io/sync"},
		{"legacy webhook trigger annotation", "paprika.io/webhook-trigger"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{Name: "owner-app", Namespace: "default"},
			}

			tmpl := &pipelinesv1alpha1.Template{
				ObjectMeta: metav1.ObjectMeta{
					Name:        "owner-app-template",
					Namespace:   "default",
					Annotations: map[string]string{tc.annotation: "123"},
				},
				Spec: pipelinesv1alpha1.TemplateSpec{Type: "helm"},
			}
			tmpl.OwnerReferences = []metav1.OwnerReference{
				{
					APIVersion: pipelinesv1alpha1.GroupVersion.Identifier(),
					Kind:       "Application",
					Name:       "owner-app",
					UID:        "owner-uid",
				},
			}

			c := newTemplateTestClient(app, tmpl)
			r := &TemplateReconciler{Client: c}

			if err := r.propagateSyncTrigger(ctx, tmpl); err != nil {
				t.Fatalf("propagateSyncTrigger failed: %v", err)
			}

			var updatedApp pipelinesv1alpha1.Application
			if err := c.Get(ctx, types.NamespacedName{Name: "owner-app", Namespace: "default"}, &updatedApp); err != nil {
				t.Fatalf("get owner application: %v", err)
			}
			if updatedApp.Annotations["paprika.io/sync"] == "" {
				t.Fatalf("expected owner application to be annotated with paprika.io/sync")
			}

			var updatedTmpl pipelinesv1alpha1.Template
			if err := c.Get(ctx, types.NamespacedName{Name: "owner-app-template", Namespace: "default"}, &updatedTmpl); err != nil {
				t.Fatalf("get template: %v", err)
			}
			if len(updatedTmpl.Annotations) > 0 {
				t.Fatalf("expected template annotations to be cleared, got %v", updatedTmpl.Annotations)
			}
		})
	}

	t.Run("no annotation leaves resources unchanged", func(t *testing.T) {
		tmpl := &pipelinesv1alpha1.Template{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "plain-template",
				Namespace: "default",
			},
			Spec: pipelinesv1alpha1.TemplateSpec{Type: "helm"},
		}
		c := newTemplateTestClient(tmpl)
		r := &TemplateReconciler{Client: c}

		if err := r.propagateSyncTrigger(ctx, tmpl); err != nil {
			t.Fatalf("propagateSyncTrigger failed: %v", err)
		}

		var updated pipelinesv1alpha1.Template
		if err := c.Get(ctx, types.NamespacedName{Name: "plain-template", Namespace: "default"}, &updated); err != nil {
			t.Fatalf("get template: %v", err)
		}
		if updated.Annotations != nil {
			t.Fatalf("expected no annotations, got %v", updated.Annotations)
		}
	})
}
