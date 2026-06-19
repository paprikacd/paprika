package pipelines

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var _ = ginkgo.Describe("ApplicationSet Controller", func() {
	const (
		setName   = "test-applicationset"
		namespace = "default"
	)

	ctx := context.Background()
	key := types.NamespacedName{Name: setName, Namespace: namespace}

	ginkgo.BeforeEach(func() {
		set := &pipelinesv1alpha1.ApplicationSet{
			ObjectMeta: metav1.ObjectMeta{
				Name:      setName,
				Namespace: namespace,
			},
			Spec: pipelinesv1alpha1.ApplicationSetSpec{
				Generators: []pipelinesv1alpha1.ApplicationSetGenerator{
					{
						List: &pipelinesv1alpha1.ListGenerator{
							Items: []map[string]string{
								{"env": "dev", "path": "dev"},
								{"env": "prod", "path": "prod"},
							},
						},
					},
				},
				Template: pipelinesv1alpha1.ApplicationTemplateSpec{
					ApplicationSpec: pipelinesv1alpha1.ApplicationSpec{
						Source: pipelinesv1alpha1.ApplicationSource{
							Type: "helm",
							Chart: pipelinesv1alpha1.ChartRef{
								Path: "/charts/{{.env}}-app",
							},
						},
						Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
							{
								Name: "{{.env}}",
								Ring: 1,
							},
						},
						Strategy:   pipelinesv1alpha1.StrategyRolling,
						SyncPolicy: pipelinesv1alpha1.SyncAuto,
					},
				},
			},
		}

		err := k8sClient.Get(ctx, key, set)
		if err != nil && errors.IsNotFound(err) {
			gomega.Expect(k8sClient.Create(ctx, set)).To(gomega.Succeed())
		} else {
			gomega.Expect(err).NotTo(gomega.HaveOccurred())
		}
	})

	ginkgo.AfterEach(func() {
		var apps pipelinesv1alpha1.ApplicationList
		gomega.Expect(k8sClient.List(ctx, &apps,
			client.InNamespace(namespace),
			client.MatchingLabels{applicationSetLabelKey: setName},
		)).To(gomega.Succeed())
		for i := range apps.Items {
			_ = k8sClient.Delete(ctx, &apps.Items[i])
		}

		set := &pipelinesv1alpha1.ApplicationSet{}
		if err := k8sClient.Get(ctx, key, set); err == nil {
			gomega.Expect(k8sClient.Delete(ctx, set)).To(gomega.Succeed())
		}
	})

	ginkgo.It("should create Applications from a list generator", func() {
		rec := &ApplicationSetReconciler{
			client: k8sClient,
			Scheme: k8sClient.Scheme(),
		}

		_, err := rec.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var apps pipelinesv1alpha1.ApplicationList
		gomega.Eventually(func() int {
			gomega.Expect(k8sClient.List(ctx, &apps,
				client.InNamespace(namespace),
				client.MatchingLabels{applicationSetLabelKey: setName},
			)).To(gomega.Succeed())
			return len(apps.Items)
		}, 10*time.Second, 1*time.Second).Should(gomega.Equal(2))

		envs := map[string]bool{}
		for _, app := range apps.Items {
			gomega.Expect(app.Labels[applicationSetLabelKey]).To(gomega.Equal(setName))
			envs[app.Spec.Stages[0].Name] = true
		}
		gomega.Expect(envs).To(gomega.HaveKeyWithValue("dev", true))
		gomega.Expect(envs).To(gomega.HaveKeyWithValue("prod", true))
	})

	ginkgo.It("should prune stale Applications", func() {
		rec := &ApplicationSetReconciler{
			client: k8sClient,
			Scheme: k8sClient.Scheme(),
		}

		_, err := rec.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var apps pipelinesv1alpha1.ApplicationList
		gomega.Eventually(func() int {
			gomega.Expect(k8sClient.List(ctx, &apps,
				client.InNamespace(namespace),
				client.MatchingLabels{applicationSetLabelKey: setName},
			)).To(gomega.Succeed())
			return len(apps.Items)
		}, 10*time.Second, 1*time.Second).Should(gomega.Equal(2))

		ginkgo.By("Reducing the list generator to a single item")
		var set pipelinesv1alpha1.ApplicationSet
		gomega.Expect(k8sClient.Get(ctx, key, &set)).To(gomega.Succeed())
		set.Spec.Generators[0].List.Items = set.Spec.Generators[0].List.Items[:1]
		gomega.Expect(k8sClient.Update(ctx, &set)).To(gomega.Succeed())

		_, err = rec.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		gomega.Eventually(func() int {
			gomega.Expect(k8sClient.List(ctx, &apps,
				client.InNamespace(namespace),
				client.MatchingLabels{applicationSetLabelKey: setName},
			)).To(gomega.Succeed())
			return len(apps.Items)
		}, 10*time.Second, 1*time.Second).Should(gomega.Equal(1))
	})

	ginkgo.It("should discover directories with a gitDirectories generator", func() {
		tmpDir := ginkgo.GinkgoT().TempDir()

		gomega.Expect(os.Mkdir(filepath.Join(tmpDir, "a"), 0o750)).To(gomega.Succeed())
		gomega.Expect(os.Mkdir(filepath.Join(tmpDir, "b"), 0o750)).To(gomega.Succeed())

		gitSet := &pipelinesv1alpha1.ApplicationSet{
			ObjectMeta: metav1.ObjectMeta{
				Name:      setName + "-git",
				Namespace: namespace,
			},
			Spec: pipelinesv1alpha1.ApplicationSetSpec{
				Generators: []pipelinesv1alpha1.ApplicationSetGenerator{
					{
						GitDirectories: &pipelinesv1alpha1.GitDirectoriesGenerator{
							RepoURL: tmpDir,
						},
					},
				},
				Template: pipelinesv1alpha1.ApplicationTemplateSpec{
					ApplicationSpec: pipelinesv1alpha1.ApplicationSpec{
						Source: pipelinesv1alpha1.ApplicationSource{
							Type: "helm",
							Chart: pipelinesv1alpha1.ChartRef{
								Path: "/charts/{{.path}}",
							},
						},
						Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
							{Name: "dev", Ring: 1},
						},
						Strategy:   pipelinesv1alpha1.StrategyRolling,
						SyncPolicy: pipelinesv1alpha1.SyncAuto,
					},
				},
			},
		}
		gomega.Expect(k8sClient.Create(ctx, gitSet)).To(gomega.Succeed())
		defer func() {
			_ = k8sClient.Delete(ctx, gitSet)
		}()

		rec := &ApplicationSetReconciler{
			client: k8sClient,
			Scheme: k8sClient.Scheme(),
		}

		_, err := rec.Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Name: gitSet.Name, Namespace: namespace},
		})
		gomega.Expect(err).NotTo(gomega.HaveOccurred())

		var apps pipelinesv1alpha1.ApplicationList
		gomega.Eventually(func() int {
			gomega.Expect(k8sClient.List(ctx, &apps,
				client.InNamespace(namespace),
				client.MatchingLabels{applicationSetLabelKey: gitSet.Name},
			)).To(gomega.Succeed())
			return len(apps.Items)
		}, 10*time.Second, 1*time.Second).Should(gomega.Equal(2))
	})
})
