package pipelines

import (
	"context"
	"strings"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var _ = ginkgo.Describe("Inline artifact API admission", func() {
	ginkgo.It("requires an exact lowercase payload hash when artifact provenance is declared", func() {
		admissionContext := context.Background()
		application := &api.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "inline-hash-admission", Namespace: "default"},
			Spec: api.ApplicationSpec{
				Source: api.ApplicationSource{Type: api.SourceTypeInline, Inline: &api.InlineSourceSpec{ConfigMapRef: "bundle", Artifact: artifactTestSpec()}},
				Stages: []api.ApplicationPromotionStage{{Name: "development"}}, Strategy: api.StrategyRolling, SyncPolicy: api.SyncAuto,
			},
		}
		for _, hash := range []string{"", "main", strings.Repeat("a", 63), strings.Repeat("A", 64)} {
			application.Spec.Source.Inline.ManifestHash = hash
			err := k8sClient.Create(admissionContext, application)
			gomega.Expect(apierrors.IsInvalid(err)).To(gomega.BeTrue(), "expected schema rejection for %q, got %v", hash, err)
		}
		application.Spec.Source.Inline.ManifestHash = strings.Repeat("a", 64)
		gomega.Expect(k8sClient.Create(admissionContext, application)).To(gomega.Succeed())
		gomega.Expect(k8sClient.Delete(admissionContext, application)).To(gomega.Succeed())
		// Unversioned external inline publishers retain their existing schema.
		application.Name, application.ResourceVersion, application.UID = "legacy-inline-hash-admission", "", ""
		application.Spec.Source.Inline.Artifact = nil
		application.Spec.Source.Inline.ManifestHash = ""
		gomega.Expect(k8sClient.Create(admissionContext, application)).To(gomega.Succeed())
		gomega.Expect(k8sClient.Delete(admissionContext, application)).To(gomega.Succeed())
	})
})
