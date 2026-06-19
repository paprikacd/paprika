package pipelines

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/governance"
)

var _ = Describe("Release Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		release := &pipelinesv1alpha1.Release{}
		stageName := "test-stage"

		BeforeEach(func() {
			By("creating the custom resource for the Kind Release")
			err := k8sClient.Get(ctx, typeNamespacedName, release)
			if err != nil && errors.IsNotFound(err) {
				By("creating the Stage resource needed by the Release")
				Expect(k8sClient.Create(ctx, &pipelinesv1alpha1.Stage{
					ObjectMeta: metav1.ObjectMeta{
						Name:      stageName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.StageSpec{
						Name:      stageName,
						Ring:      1,
						Templates: []string{},
					},
				})).To(Succeed())

				resource := &pipelinesv1alpha1.Release{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: pipelinesv1alpha1.ReleaseSpec{
						Pipeline: "test-pipeline",
						Target:   stageName,
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &pipelinesv1alpha1.Release{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			if err != nil && errors.IsNotFound(err) {
				return
			}
			Expect(err).NotTo(HaveOccurred())
			By("Cleanup the specific resource instance Release")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())

			By("Cleanup the Stage resource")
			stage := &pipelinesv1alpha1.Stage{}
			if err := k8sClient.Get(ctx, types.NamespacedName{Name: stageName, Namespace: "default"}, stage); err == nil {
				Expect(k8sClient.Delete(ctx, stage)).To(Succeed())
			}
		})
		It("should add finalizer on creation and handle cleanup on deletion", func() {
			By("Reconciling the created resource")
			controllerReconciler := &ReleaseReconciler{
				client:    k8sClient,
				Scheme:    k8sClient.Scheme(),
				Namespace: "default",
				Clock:     clock.NewFake(time.Now()),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())
			updated := &pipelinesv1alpha1.Release{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, updated)).To(Succeed())
			Expect(updated.Finalizers).To(ContainElement("paprika.io/release-cleanup"))
		})
	})

	Context("when rolling back a failed release to a previous snapshot", func() {
		const (
			appName             = "rollback-test-app"
			stageName           = "rollback-test-stage"
			prevReleaseName     = "rollback-test-prev"
			currentReleaseName  = "rollback-test-current"
			prevSnapshotName    = "rollback-test-prev-snapshot"
			currentSnapshotName = "rollback-test-current-snapshot"
			deploymentName      = "rollback-target-deploy"
		)

		ctx := context.Background()

		appKey := types.NamespacedName{Name: appName, Namespace: "default"}
		stageKey := types.NamespacedName{Name: stageName, Namespace: "default"}
		prevReleaseKey := types.NamespacedName{Name: prevReleaseName, Namespace: "default"}
		currentReleaseKey := types.NamespacedName{Name: currentReleaseName, Namespace: "default"}

		priorManifests := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: rollback-target-deploy
  labels:
    app: rollback-target
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rollback-target
  template:
    metadata:
      labels:
        app: rollback-target
    spec:
      containers:
      - name: app
        image: nginx:stable
`

		currentManifests := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: rollback-target-deploy
  labels:
    app: rollback-target
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rollback-target
  template:
    metadata:
      labels:
        app: rollback-target
    spec:
      containers:
      - name: app
        image: nginx:latest
`

		BeforeEach(func() {
			By("creating the Application")
			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:      appName,
					Namespace: "default",
				},
				Spec: pipelinesv1alpha1.ApplicationSpec{
					Source: pipelinesv1alpha1.ApplicationSource{
						Type: "inline",
					},
					Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
						{
							Name: stageName,
							Ring: 1,
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, app)).To(Succeed())

			By("creating the Stage")
			stage := &pipelinesv1alpha1.Stage{
				ObjectMeta: metav1.ObjectMeta{
					Name:      stageName,
					Namespace: "default",
				},
				Spec: pipelinesv1alpha1.StageSpec{
					Name:      stageName,
					Ring:      1,
					Templates: []string{},
				},
			}
			Expect(k8sClient.Create(ctx, stage)).To(Succeed())

			By("creating the previous release snapshot ConfigMap")
			prevSnapshot := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      prevSnapshotName,
					Namespace: "default",
				},
				Data: map[string]string{
					"manifests.yaml": priorManifests,
				},
			}
			Expect(k8sClient.Create(ctx, prevSnapshot)).To(Succeed())

			By("creating the current release snapshot ConfigMap")
			currentSnapshot := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      currentSnapshotName,
					Namespace: "default",
				},
				Data: map[string]string{
					"manifests.yaml": currentManifests,
				},
			}
			Expect(k8sClient.Create(ctx, currentSnapshot)).To(Succeed())

			By("creating the previous Complete release")
			prevRelease := &pipelinesv1alpha1.Release{
				ObjectMeta: metav1.ObjectMeta{
					Name:      prevReleaseName,
					Namespace: "default",
					Labels: map[string]string{
						engine.ApplicationNameLabelKey: appName,
					},
				},
				Spec: pipelinesv1alpha1.ReleaseSpec{
					Pipeline: "test-pipeline",
					Target:   stageName,
				},
			}
			Expect(k8sClient.Create(ctx, prevRelease)).To(Succeed())
			prevRelease.Status = pipelinesv1alpha1.ReleaseStatus{
				Phase:                    pipelinesv1alpha1.ReleaseComplete,
				RenderedManifestSnapshot: prevSnapshotName,
			}
			Expect(k8sClient.Status().Update(ctx, prevRelease)).To(Succeed())

			By("creating the failed current release with rollback configured")
			currentRelease := &pipelinesv1alpha1.Release{
				ObjectMeta: metav1.ObjectMeta{
					Name:       currentReleaseName,
					Namespace:  "default",
					Finalizers: []string{releaseFinalizer},
					Labels: map[string]string{
						engine.ApplicationNameLabelKey: appName,
					},
					Annotations: map[string]string{
						rollbackAnnotation: "true",
					},
				},
				Spec: pipelinesv1alpha1.ReleaseSpec{
					Pipeline: "test-pipeline",
					Target:   stageName,
					OnFailure: &pipelinesv1alpha1.FailureAction{
						Action: "rollback",
					},
					ManifestSource: &pipelinesv1alpha1.ManifestSource{
						ConfigMapRef: currentSnapshotName,
					},
				},
			}
			Expect(k8sClient.Create(ctx, currentRelease)).To(Succeed())
			currentRelease.Status = pipelinesv1alpha1.ReleaseStatus{
				Phase: pipelinesv1alpha1.ReleaseFailed,
			}
			Expect(k8sClient.Status().Update(ctx, currentRelease)).To(Succeed())
		})

		AfterEach(func() {
			By("cleaning up the current release")
			currentRelease := &pipelinesv1alpha1.Release{}
			if err := k8sClient.Get(ctx, currentReleaseKey, currentRelease); err == nil {
				currentRelease.Finalizers = nil
				Expect(k8sClient.Update(ctx, currentRelease)).To(Succeed())
				Expect(k8sClient.Delete(ctx, currentRelease)).To(Succeed())
			}

			By("cleaning up the previous release")
			prevRelease := &pipelinesv1alpha1.Release{}
			if err := k8sClient.Get(ctx, prevReleaseKey, prevRelease); err == nil {
				Expect(k8sClient.Delete(ctx, prevRelease)).To(Succeed())
			}

			By("cleaning up the Stage")
			stage := &pipelinesv1alpha1.Stage{}
			if err := k8sClient.Get(ctx, stageKey, stage); err == nil {
				Expect(k8sClient.Delete(ctx, stage)).To(Succeed())
			}

			By("cleaning up the Application")
			app := &pipelinesv1alpha1.Application{}
			if err := k8sClient.Get(ctx, appKey, app); err == nil {
				Expect(k8sClient.Delete(ctx, app)).To(Succeed())
			}

			By("cleaning up the snapshot ConfigMaps")
			for _, name := range []string{prevSnapshotName, currentSnapshotName} {
				cm := &corev1.ConfigMap{}
				if err := k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: "default"}, cm); err == nil {
					Expect(k8sClient.Delete(ctx, cm)).To(Succeed())
				}
			}

			By("cleaning up the deployed Deployment")
			dynClient, err := dynamic.NewForConfig(cfg)
			Expect(err).NotTo(HaveOccurred())
			deployGVR := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
			_ = dynClient.Resource(deployGVR).Namespace("default").Delete(ctx, deploymentName, metav1.DeleteOptions{})
		})

		It("should roll back to the previous release snapshot and apply the target manifests", func() {
			By("creating a dynamic client for manifest verification")
			dynClient, err := dynamic.NewForConfig(cfg)
			Expect(err).NotTo(HaveOccurred())

			By("reconciling the failed release")
			controllerReconciler := &ReleaseReconciler{
				client:        k8sClient,
				Scheme:        k8sClient.Scheme(),
				RestConfig:    cfg,
				DynamicClient: dynClient,
				Clock:         clock.NewFake(time.Now()),
			}

			_, err = controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: currentReleaseKey,
			})
			Expect(err).NotTo(HaveOccurred())

			By("verifying the release is marked RolledBack and points to the previous release")
			var currentRelease pipelinesv1alpha1.Release
			Eventually(func() pipelinesv1alpha1.ReleasePhase {
				Expect(k8sClient.Get(ctx, currentReleaseKey, &currentRelease)).To(Succeed())
				return currentRelease.Status.Phase
			}).Should(Equal(pipelinesv1alpha1.ReleaseRolledBack))
			Expect(currentRelease.Status.RolledBackTo).To(Equal(prevReleaseName))

			By("verifying the rollback target Deployment was applied")
			deployGVR := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
			var deployment *unstructured.Unstructured
			Eventually(func() bool {
				deploy, getErr := dynClient.Resource(deployGVR).Namespace("default").Get(ctx, deploymentName, metav1.GetOptions{})
				if getErr != nil {
					return false
				}
				deployment = deploy
				return true
			}).Should(BeTrue())

			containers, found, err := unstructured.NestedSlice(deployment.Object, "spec", "template", "spec", "containers")
			Expect(err).NotTo(HaveOccurred())
			Expect(found).To(BeTrue())
			Expect(containers).To(HaveLen(1))

			containerMap, ok := containers[0].(map[string]interface{})
			Expect(ok).To(BeTrue())

			image, found, err := unstructured.NestedString(containerMap, "image")
			Expect(err).NotTo(HaveOccurred())
			Expect(found).To(BeTrue())
			Expect(image).To(Equal("nginx:stable"))

			By("verifying the Application releaseRef was updated to the previous release")
			var app pipelinesv1alpha1.Application
			Expect(k8sClient.Get(ctx, appKey, &app)).To(Succeed())
			Expect(app.Status.ReleaseRef).To(Equal(prevReleaseName))
		})
	})

	Context("when a Release manifest violates its AppProject boundaries", func() {
		const (
			appName      = "governance-block-release-app"
			stageName    = "governance-block-release-stage"
			releaseName  = "governance-block-release"
			snapshotName = "governance-block-release-snapshot"
			projectName  = "restricted-release-project"
		)

		ctx := context.Background()

		appKey := types.NamespacedName{Name: appName, Namespace: "default"}
		stageKey := types.NamespacedName{Name: stageName, Namespace: "default"}
		releaseKey := types.NamespacedName{Name: releaseName, Namespace: "default"}
		projectKey := types.NamespacedName{Name: projectName, Namespace: "default"}

		manifests := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: blocked-deploy
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: blocked
  template:
    metadata:
      labels:
        app: blocked
    spec:
      containers:
      - name: app
        image: nginx:latest
`

		BeforeEach(func() {
			project := &corev1alpha1.AppProject{
				ObjectMeta: metav1.ObjectMeta{
					Name:      projectName,
					Namespace: "default",
				},
				Spec: corev1alpha1.AppProjectSpec{
					Description: "Restricts deployments to allowed namespaces",
					Destinations: []corev1alpha1.AppProjectDestination{
						{Server: "*", Namespace: "allowed-ns"},
					},
				},
			}
			Expect(k8sClient.Create(ctx, project)).To(Succeed())

			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:      appName,
					Namespace: "default",
				},
				Spec: pipelinesv1alpha1.ApplicationSpec{
					Project: projectName,
					Source: pipelinesv1alpha1.ApplicationSource{
						Type: "inline",
					},
					Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
						{
							Name: stageName,
							Ring: 1,
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, app)).To(Succeed())

			stage := &pipelinesv1alpha1.Stage{
				ObjectMeta: metav1.ObjectMeta{
					Name:      stageName,
					Namespace: "default",
				},
				Spec: pipelinesv1alpha1.StageSpec{
					Name:      stageName,
					Ring:      1,
					Templates: []string{},
				},
			}
			Expect(k8sClient.Create(ctx, stage)).To(Succeed())

			snapshot := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      snapshotName,
					Namespace: "default",
				},
				Data: map[string]string{
					"manifests.yaml": manifests,
				},
			}
			Expect(k8sClient.Create(ctx, snapshot)).To(Succeed())

			release := &pipelinesv1alpha1.Release{
				ObjectMeta: metav1.ObjectMeta{
					Name:       releaseName,
					Namespace:  "default",
					Finalizers: []string{releaseFinalizer},
					Labels: map[string]string{
						"app.paprika.io/project": projectName,
					},
					OwnerReferences: []metav1.OwnerReference{{
						APIVersion: pipelinesv1alpha1.GroupVersion.String(),
						Kind:       "Application",
						Name:       appName,
						UID:        app.UID,
						Controller: ptr(true),
					}},
				},
				Spec: pipelinesv1alpha1.ReleaseSpec{
					Pipeline: "test-pipeline",
					Target:   stageName,
					ManifestSource: &pipelinesv1alpha1.ManifestSource{
						ConfigMapRef: snapshotName,
					},
				},
				Status: pipelinesv1alpha1.ReleaseStatus{
					Phase: pipelinesv1alpha1.ReleasePromoting,
				},
			}
			Expect(k8sClient.Create(ctx, release)).To(Succeed())
			release.Status = pipelinesv1alpha1.ReleaseStatus{
				Phase: pipelinesv1alpha1.ReleasePromoting,
			}
			Expect(k8sClient.Status().Update(ctx, release)).To(Succeed())
		})

		AfterEach(func() {
			release := &pipelinesv1alpha1.Release{}
			if err := k8sClient.Get(ctx, releaseKey, release); err == nil {
				release.Finalizers = nil
				Expect(k8sClient.Update(ctx, release)).To(Succeed())
				Expect(k8sClient.Delete(ctx, release)).To(Succeed())
			}

			stage := &pipelinesv1alpha1.Stage{}
			if err := k8sClient.Get(ctx, stageKey, stage); err == nil {
				Expect(k8sClient.Delete(ctx, stage)).To(Succeed())
			}

			app := &pipelinesv1alpha1.Application{}
			if err := k8sClient.Get(ctx, appKey, app); err == nil {
				Expect(k8sClient.Delete(ctx, app)).To(Succeed())
			}

			project := &corev1alpha1.AppProject{}
			if err := k8sClient.Get(ctx, projectKey, project); err == nil {
				Expect(k8sClient.Delete(ctx, project)).To(Succeed())
			}

			snapshot := &corev1.ConfigMap{}
			if err := k8sClient.Get(ctx, types.NamespacedName{Name: snapshotName, Namespace: "default"}, snapshot); err == nil {
				Expect(k8sClient.Delete(ctx, snapshot)).To(Succeed())
			}
		})

		It("should set GovernanceChecked=False and fail the release", func() {
			controllerReconciler := &ReleaseReconciler{
				client:    k8sClient,
				Scheme:    k8sClient.Scheme(),
				Namespace: "default",
				ProjectValidator: governance.NewProjectValidator(
					governance.NewProjectResolver(k8sClient),
					governance.NewClusterResolver(k8sClient),
					nil,
				),
				PolicyEvaluator: governance.NewPolicyEvaluator(k8sClient),
				EventRecorder:   record.NewFakeRecorder(10),
				Clock:           clock.NewFake(time.Now()),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: releaseKey,
			})
			Expect(err).NotTo(HaveOccurred())

			var release pipelinesv1alpha1.Release
			Expect(k8sClient.Get(ctx, releaseKey, &release)).To(Succeed())
			Expect(release.Status.Phase).To(Equal(pipelinesv1alpha1.ReleaseFailed))

			cond := meta.FindStatusCondition(release.Status.Conditions, governanceCheckedCondition)
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal(projectViolationReason))
		})
	})
})
