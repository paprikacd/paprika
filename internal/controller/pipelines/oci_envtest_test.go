package controller

import (
	"context"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/source"
)

type stubOCIRenderer struct{}

func (stubOCIRenderer) Render(_ context.Context, _ *pipelinesv1alpha1.Template, _ map[string]string) ([]byte, error) {
	return nil, nil
}

func (stubOCIRenderer) RenderAll(_ context.Context, _ []pipelinesv1alpha1.Template, _ map[string]string) ([]byte, error) {
	return nil, nil
}

func (stubOCIRenderer) ResolveSource(_ context.Context, _ *pipelinesv1alpha1.Template) (*source.ResolveResult, error) {
	return &source.ResolveResult{LocalPath: "/tmp/oci-stub", Hash: "stub-hash", Revision: "1.2.3"}, nil
}

func (stubOCIRenderer) RenderHelmChart(_ context.Context, _, _, _ string, _ map[string]string) ([]byte, error) {
	return nil, nil
}

var _ engine.TemplateRenderer = stubOCIRenderer{}

var _ = ginkgo.Describe("Application Controller OCI Source", func() {
	ctx := context.Background()
	const appName = "oci-source-app"

	ginkgo.It("should create a Template from an OCI source", func() {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{
					Type: pipelinesv1alpha1.SourceTypeOCI,
					OCI: &pipelinesv1alpha1.OCISourceSpec{
						URL: "oci://registry.example.com/charts/mychart",
						Tag: "1.2.3",
					},
				},
				Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

		rec := &ApplicationReconciler{
			Client:           k8sClient,
			Scheme:           k8sClient.Scheme(),
			WorkDir:          "/tmp/paprika-oci-envtest",
			TemplateRenderer: stubOCIRenderer{},
		}
		_, err := rec.Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Name: appName, Namespace: "default"},
		})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var tmpl pipelinesv1alpha1.Template
		gomega.Eventually(func() error {
			return k8sClient.Get(ctx, types.NamespacedName{Name: appName + "-template", Namespace: "default"}, &tmpl)
		}, 10*time.Second, 1*time.Second).Should(gomega.Succeed())

		gomega.Expect(tmpl.Spec.Type).To(gomega.Equal(pipelinesv1alpha1.SourceTypeOCI))
		gomega.Expect(tmpl.Spec.OCI).NotTo(gomega.BeNil())
		gomega.Expect(tmpl.Spec.OCI.URL).To(gomega.Equal("oci://registry.example.com/charts/mychart"))
		gomega.Expect(tmpl.Spec.OCI.Tag).To(gomega.Equal("1.2.3"))

		var updated pipelinesv1alpha1.Application
		gomega.Expect(k8sClient.Get(ctx, types.NamespacedName{Name: appName, Namespace: "default"}, &updated)).To(gomega.Succeed())
		gomega.Expect(updated.Status.TemplateRef).To(gomega.Equal(appName + "-template"))
	})
})
