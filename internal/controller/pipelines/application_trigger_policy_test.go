package pipelines

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/source"
	"github.com/benebsworth/paprika/internal/syncwindow"
)

func triggerPolicyApp(mode paprikav1.ApplicationTriggerType) *paprikav1.Application {
	return &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "checkout", Namespace: "staging", UID: "checkout-uid", Generation: 1},
		Spec: paprikav1.ApplicationSpec{
			Trigger: &paprikav1.ApplicationTrigger{Type: mode},
			Source: paprikav1.ApplicationSource{
				Type: paprikav1.SourceTypeGit, RepoURL: "https://example.com/checkout.git", Revision: "main", Path: "charts/staging",
			},
			Stages:     []paprikav1.ApplicationPromotionStage{{Name: "stg", Cluster: paprikav1.ClusterRef{Name: "staging-cluster"}}},
			SyncPolicy: paprikav1.SyncAuto,
		},
	}
}

func triggerPolicyReconciler(t *testing.T, app *paprikav1.Application, objects ...client.Object) *ApplicationReconciler {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	objects = append(objects, app)
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&paprikav1.Application{}, &paprikav1.Release{}, &paprikav1.Pipeline{}).WithObjects(objects...).Build()
	return &ApplicationReconciler{client: c, Scheme: scheme}
}

func TestTriggerPolicyNoIndependentPromotionDeployment(t *testing.T) {
	for _, annotation := range []string{"", syncAnnotation, legacyWebhookTriggerAnnotation, manualSyncAnnotation} {
		t.Run(annotation, func(t *testing.T) {
			app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
			app.Spec.Trigger.From = &paprikav1.ApplicationReference{Name: "checkout", Namespace: "dev"}
			if annotation != "" {
				app.Annotations = map[string]string{annotation: "requested", syncAnnotation: "requested"}
			}
			r := triggerPolicyReconciler(t, app)
			_, err := r.reconcileApp(context.Background(), app)
			require.NoError(t, err)
			var releases paprikav1.ReleaseList
			require.NoError(t, r.client.List(context.Background(), &releases))
			require.Empty(t, releases.Items)
			require.Empty(t, app.Status.SourceRevision)
		})
	}
}

func TestTriggerPolicyFirstGitOpsReleasePinsSource(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerGitOps)
	r := triggerPolicyReconciler(t, app)
	sha := strings.Repeat("a", 40)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: sha + ":staging-tree", Revision: sha}}
	_, err := r.reconcileApp(context.Background(), app)
	require.NoError(t, err)
	var releases paprikav1.ReleaseList
	require.NoError(t, r.client.List(context.Background(), &releases))
	require.Len(t, releases.Items, 1)
	require.Equal(t, sha, releases.Items[0].Annotations[sourceRevisionAnnotation])
	require.Equal(t, "checkout-stg", releases.Items[0].Spec.Target)
	var stage paprikav1.Stage
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Name: "checkout-stg", Namespace: app.Namespace}, &stage))
	require.Equal(t, "staging-cluster", stage.Spec.Cluster.Name)
}

func TestTriggerPolicyManualInitialDeployment(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerManual)
	r := triggerPolicyReconciler(t, app)
	sha := strings.Repeat("b", 40)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: sha + ":tree", Revision: sha}}
	ctx := context.Background()
	_, err := r.reconcileApp(ctx, app)
	require.NoError(t, err)
	var releases paprikav1.ReleaseList
	require.NoError(t, r.client.List(ctx, &releases))
	require.Empty(t, releases.Items)
	require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(app), app))
	app.Annotations = map[string]string{syncAnnotation: "1", manualSyncAnnotation: "1"}
	require.NoError(t, r.client.Update(ctx, app))
	for i := 0; i < 3; i++ {
		require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(app), app))
		_, err = r.reconcileApp(ctx, app)
		require.NoError(t, err)
	}
	require.NoError(t, r.client.List(ctx, &releases))
	require.Len(t, releases.Items, 1)
	require.Equal(t, sha, releases.Items[0].Annotations[sourceRevisionAnnotation])
}

func TestTriggerPolicyPinnedTemplatePreservesEnvironment(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
	app.Status.SourceRevision = strings.Repeat("c", 40)
	app.Spec.Source.TargetNamespace = "workload-staging"
	app.Spec.Source.ValuesFile = "values-staging.yaml"
	r := triggerPolicyReconciler(t, app)
	spec := r.buildTemplateSpec(context.Background(), app)
	require.Equal(t, app.Status.SourceRevision, spec.Git.Revision)
	require.Equal(t, "main", app.Spec.Source.Revision)
	require.Equal(t, "charts/staging", spec.Git.Path)
	require.Equal(t, "values-staging.yaml", spec.ValuesFile)
	require.Equal(t, "workload-staging", spec.Namespace)

	input := buildTemplateSpec(app)
	pinned := pinTriggeredTemplate(app, &input)
	require.Equal(t, "main", input.Git.Revision, "pinning must not mutate the input TemplateSpec")
	require.Equal(t, app.Status.SourceRevision, pinned.Git.Revision)
	require.NotSame(t, input.Git, pinned.Git)
}

func TestTriggerPolicyWebhookAndParametersCannotBypassPromotion(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
	sha := strings.Repeat("d", 40)
	app.Status = paprikav1.ApplicationStatus{
		Phase: paprikav1.ApplicationHealthy, SourceRevision: sha, SourceHash: sha + ":tree", ReleaseRef: "accepted-release",
		Promotion: &paprikav1.ApplicationPromotionStatus{Phase: "Complete", Revision: sha},
	}
	app.Annotations = map[string]string{syncAnnotation: "new-webhook"}
	app.Spec.Parameters = map[string]string{"replicas": "5"}
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "accepted-release", Namespace: app.Namespace, Annotations: map[string]string{sourceRevisionAnnotation: sha}}, Status: paprikav1.ReleaseStatus{Phase: paprikav1.ReleaseComplete}}
	r := triggerPolicyReconciler(t, app, release)
	renderer := &captureSourceRenderer{result: &source.ResolveResult{Hash: "new-tree", Revision: strings.Repeat("e", 40)}}
	r.TemplateRenderer = renderer
	_, err := r.handleSyncTrigger(context.Background(), app)
	require.NoError(t, err)
	_, err = r.handleHealthyPhase(context.Background(), app)
	require.NoError(t, err)
	require.Nil(t, renderer.captured, "source discovery must not consult branch HEAD")
	require.Equal(t, sha, app.Status.SourceRevision)
	require.Equal(t, "accepted-release", app.Status.ReleaseRef)
	require.Equal(t, paprikav1.ReleaseComplete, r.getCurrentReleasePhase(context.Background(), app))
}

func TestTriggerPolicyRejectsUnexpectedResolvedRevision(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
	app.Status.SourceRevision = strings.Repeat("f", 40)
	app.Status.Promotion = &paprikav1.ApplicationPromotionStatus{Phase: "Ready", Revision: app.Status.SourceRevision}
	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "checkout-template", Namespace: app.Namespace}, Spec: buildTemplateSpec(app)}
	r := triggerPolicyReconciler(t, app, tmpl)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: "wrong-tree", Revision: strings.Repeat("a", 40)}}
	_, err := r.prepareTriggeredSource(context.Background(), app)
	require.ErrorContains(t, err, "instead of accepted revision")
	require.Empty(t, app.Status.SourceHash)
	var releases paprikav1.ReleaseList
	require.NoError(t, r.client.List(context.Background(), &releases))
	require.Empty(t, releases.Items)
}

func TestTriggerPolicyAcceptedDeploymentKeepsTemplateStageAndRepairParameters(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
	app.Spec.Source.TargetNamespace = "accepted-workloads"
	app.Spec.Source.ValuesFile = "values-accepted.yaml"
	app.Spec.Parameters = map[string]string{"replicas": "2"}
	sha := strings.Repeat("a", 40)
	app.Status = paprikav1.ApplicationStatus{
		Phase: paprikav1.ApplicationHealthy, SourceRevision: sha, SourceHash: sha + ":old-tree", ReleaseRef: "accepted-release",
		AcceptedDeployment: app.Spec.DeepCopy(),
		Promotion:          &paprikav1.ApplicationPromotionStatus{Phase: "Complete", Revision: sha},
	}
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "accepted-release", Namespace: app.Namespace, Annotations: map[string]string{sourceRevisionAnnotation: sha}}, Spec: paprikav1.ReleaseSpec{Parameters: map[string]string{"replicas": "2", "release-name": "checkout-release"}}}
	r := triggerPolicyReconciler(t, app, release)
	app.Spec.Source.Path = "charts/new-path"
	app.Spec.Source.ValuesFile = "values-new.yaml"
	app.Spec.Source.TargetNamespace = "new-workloads"
	app.Spec.Parameters = map[string]string{"replicas": "8", "newFlag": "true"}
	app.Spec.Stages[0].Cluster.Name = "new-cluster"
	require.NoError(t, r.reconcileTemplate(context.Background(), app))
	require.NoError(t, r.reconcileStages(context.Background(), app))
	var tmpl paprikav1.Template
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Name: "checkout-template", Namespace: app.Namespace}, &tmpl))
	require.Equal(t, "charts/staging", tmpl.Spec.Git.Path)
	require.Equal(t, "values-accepted.yaml", tmpl.Spec.ValuesFile)
	require.Equal(t, "accepted-workloads", tmpl.Spec.Namespace)
	require.Equal(t, sha, tmpl.Spec.Git.Revision)
	var stage paprikav1.Stage
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Name: "checkout-stg", Namespace: app.Namespace}, &stage))
	require.Equal(t, "staging-cluster", stage.Spec.Cluster.Name)
	params := r.desiredManifestRenderContext(context.Background(), app).params
	require.Equal(t, "2", params["replicas"])
	require.NotContains(t, params, "newFlag", "repair must not include unpromoted parameters")
}

func TestTriggerPolicyBlockedPromotionKeepsAcceptedSettings(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
	app.Spec.SyncWindows = []paprikav1.SyncWindow{{Kind: paprikav1.SyncWindowBlock, Schedule: "* * * * *", Duration: "2m"}}
	accepted := app.Spec.DeepCopy()
	oldSHA, newSHA := strings.Repeat("a", 40), strings.Repeat("b", 40)
	app.Status = paprikav1.ApplicationStatus{
		Phase: paprikav1.ApplicationHealthy, SourceRevision: oldSHA, SourceHash: oldSHA + ":tree", ReleaseRef: "accepted-release",
		AcceptedDeployment: accepted,
		Promotion:          &paprikav1.ApplicationPromotionStatus{Phase: "Ready", Revision: newSHA},
	}
	app.Spec.Stages[0].Cluster.Name = "incoming-cluster"
	configurationHash, err := promotionVerificationConfigHash(app)
	require.NoError(t, err)
	app.Status.Promotion.VerificationConfigHash = configurationHash
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "accepted-release", Namespace: app.Namespace, UID: "accepted-uid", Annotations: map[string]string{sourceRevisionAnnotation: oldSHA}}, Status: paprikav1.ReleaseStatus{Phase: paprikav1.ReleaseComplete}}
	r := triggerPolicyReconciler(t, app, release)
	r.SyncWindowEvaluator = syncwindow.NewEvaluator()
	result, err := r.beginVerifiedPromotion(context.Background(), app)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, oldSHA, app.Status.SourceRevision)
	require.Equal(t, "staging-cluster", app.Status.AcceptedDeployment.Stages[0].Cluster.Name)
	require.Equal(t, "accepted-release", app.Status.ReleaseRef)
	require.Equal(t, paprikav1.ReleaseComplete, r.getCurrentReleasePhase(context.Background(), app))
}

func TestTriggerPolicyNewUpstreamUIDCreatesNewAuditedRelease(t *testing.T) {
	app := triggerPolicyApp(paprikav1.ApplicationTriggerPromotion)
	app.Status.SourceRevision = strings.Repeat("c", 40)
	app.Status.SourceHash = app.Status.SourceRevision + ":tree"
	app.Status.Promotion = &paprikav1.ApplicationPromotionStatus{Phase: "Ready", SourceApplication: paprikav1.ApplicationReference{Name: "dev", Namespace: "dev"}, SourceApplicationUID: "dev-uid", SourceRelease: "dev-release", SourceReleaseUID: "dev-release-uid-1", Revision: app.Status.SourceRevision}
	r := triggerPolicyReconciler(t, app)
	first := r.buildRelease(app, &app.Spec.Stages[0])
	require.Equal(t, "dev-release-uid-1", first.Annotations[promotionReleaseUIDAnnotation])
	app.Status.Promotion.SourceReleaseUID = "dev-release-uid-2"
	second := r.buildRelease(app, &app.Spec.Stages[0])
	require.NotEqual(t, first.Name, second.Name, "a new upstream candidate must get an auditable target release even at the same SHA")
	require.Equal(t, first.Annotations[sourceRevisionAnnotation], second.Annotations[sourceRevisionAnnotation])
}

func TestTriggerPolicyDevStagingProductionChain(t *testing.T) {
	staging, dev, devRelease := promotionFixture()
	staging.Spec.Stages = []paprikav1.ApplicationPromotionStage{{Name: "stg", Cluster: paprikav1.ClusterRef{Name: "staging-cluster"}}}
	staging.Spec.Parameters = map[string]string{"replicas": "2"}
	production := staging.DeepCopy()
	production.Name, production.Namespace, production.UID = "api-prod", "prod", "prod-uid"
	production.Spec.Source.Path = "env/prod"
	production.Spec.Trigger.From = &paprikav1.ApplicationReference{Name: staging.Name, Namespace: staging.Namespace}
	production.Spec.Stages = []paprikav1.ApplicationPromotionStage{{Name: "prod", Cluster: paprikav1.ClusterRef{Name: "production-cluster"}}}
	production.Spec.Parameters = map[string]string{"replicas": "5"}
	production.Spec.SyncPolicy = paprikav1.SyncManual
	r := newPromotionTestReconciler(t, staging, dev, devRelease, production)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: promotionTestRevision + ":tree", Revision: promotionTestRevision}}
	ctx := context.Background()
	_, err := r.reconcileApp(ctx, staging)
	require.NoError(t, err)
	staging = getPromotionTestApp(t, r, client.ObjectKeyFromObject(staging))
	require.Equal(t, "Promoting", staging.Status.Promotion.Phase)
	var stagingRelease paprikav1.Release
	require.NoError(t, r.client.Get(ctx, types.NamespacedName{Name: staging.Status.ReleaseRef, Namespace: staging.Namespace}, &stagingRelease))
	require.Equal(t, promotionTestRevision, stagingRelease.Annotations[sourceRevisionAnnotation])
	require.Equal(t, string(devRelease.UID), stagingRelease.Annotations[promotionReleaseUIDAnnotation])
	require.Equal(t, "2", stagingRelease.Spec.Parameters["replicas"])
	_, err = r.reconcileApp(ctx, production)
	require.NoError(t, err)
	require.Empty(t, production.Status.ReleaseRef, "production must wait for staging to finish")
	// Simulate the Release controller completing staging and the live diff
	// observing its healthy resources. The promotion reconciler owns neither.
	stagingRelease.UID = "staging-release-uid"
	require.NoError(t, r.client.Update(ctx, &stagingRelease))
	stagingRelease.Status.Phase = paprikav1.ReleaseComplete
	stagingRelease.Status.ObservedGeneration = stagingRelease.Generation
	require.NoError(t, r.client.Status().Update(ctx, &stagingRelease))
	_, err = r.reconcileApp(ctx, staging)
	require.NoError(t, err)
	staging = getPromotionTestApp(t, r, client.ObjectKeyFromObject(staging))
	staging.Status.Resources = []paprikav1.ResourceSync{{Kind: "Deployment", Name: "api", Namespace: "stg", Status: "Synced"}}
	staging.Status.ResourceHealth = []paprikav1.ResourceHealth{{Kind: "Deployment", Name: "api", Namespace: "stg", Health: "Healthy"}}
	r.recordDeploymentObservation(ctx, staging, &engine.DiffResult{})
	require.NoError(t, r.client.Status().Update(ctx, staging))
	production = getPromotionTestApp(t, r, client.ObjectKeyFromObject(production))
	_, err = r.reconcileApp(ctx, production)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", production.Status.Promotion.Phase)
	require.Empty(t, production.Status.ReleaseRef)
	production = getPromotionTestApp(t, r, client.ObjectKeyFromObject(production))
	production.Annotations = map[string]string{promotionApprovalAnnotation: string(stagingRelease.UID)}
	require.NoError(t, r.client.Update(ctx, production))
	_, err = r.reconcileApp(ctx, production)
	require.NoError(t, err)
	production = getPromotionTestApp(t, r, client.ObjectKeyFromObject(production))
	require.NotEmpty(t, production.Status.ReleaseRef)
	var productionRelease paprikav1.Release
	require.NoError(t, r.client.Get(ctx, types.NamespacedName{Name: production.Status.ReleaseRef, Namespace: production.Namespace}, &productionRelease))
	require.Equal(t, promotionTestRevision, productionRelease.Annotations[sourceRevisionAnnotation])
	require.Equal(t, string(stagingRelease.UID), productionRelease.Annotations[promotionReleaseUIDAnnotation])
	require.Equal(t, "5", productionRelease.Spec.Parameters["replicas"])
	require.Empty(t, production.Annotations[promotionApprovalAnnotation])
	for _, app := range []*paprikav1.Application{staging, production} {
		var stage paprikav1.Stage
		require.NoError(t, r.client.Get(ctx, types.NamespacedName{Name: app.Name + "-" + app.Spec.Stages[0].Name, Namespace: app.Namespace}, &stage))
		require.Equal(t, app.Spec.Stages[0].Cluster.Name, stage.Spec.Cluster.Name)
	}
}
