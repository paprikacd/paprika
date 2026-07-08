package pipelines

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/source"
)

const pruneTestAppName = "prune-test-app"

var pruneTestApp = &pipelinesv1alpha1.Application{
	ObjectMeta: metav1.ObjectMeta{
		Name:      pruneTestAppName,
		Namespace: "default",
	},
	Status: pipelinesv1alpha1.ApplicationStatus{
		ReleaseRef: "release-10",
	},
}

func newPruneTestClient(objs ...client.Object) client.Client {
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

type staticSourceRenderer struct {
	result *source.ResolveResult
}

func (r *staticSourceRenderer) ResolveSource(context.Context, *pipelinesv1alpha1.Template) (*source.ResolveResult, error) {
	return r.result, nil
}

func (r *staticSourceRenderer) Render(context.Context, *pipelinesv1alpha1.Template, map[string]string) ([]byte, error) {
	return []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered\n"), nil
}

func releaseWithPhase(name string, ts time.Time, phase pipelinesv1alpha1.ReleasePhase) *pipelinesv1alpha1.Release {
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         "default",
			CreationTimestamp: metav1.Time{Time: ts},
			Labels: map[string]string{
				engine.ApplicationNameLabelKey: pruneTestAppName,
			},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase: phase,
		},
	}
}

func buildReleases(base time.Time, phases []pipelinesv1alpha1.ReleasePhase) []client.Object {
	objs := make([]client.Object, 0, len(phases))
	for i, phase := range phases {
		objs = append(objs, releaseWithPhase(fmt.Sprintf("release-%02d", i), base.Add(time.Duration(i)*time.Hour), phase))
	}
	return objs
}

func countReleases(ctx context.Context, t *testing.T, r *ApplicationReconciler) int {
	t.Helper()
	var list pipelinesv1alpha1.ReleaseList
	if err := r.client.List(ctx, &list, client.InNamespace("default"), client.MatchingLabels{engine.ApplicationNameLabelKey: pruneTestAppName}); err != nil {
		t.Fatalf("list releases: %v", err)
	}
	return len(list.Items)
}

func releaseNames(list *pipelinesv1alpha1.ReleaseList) map[string]bool {
	names := make(map[string]bool, len(list.Items))
	for i := range list.Items {
		names[list.Items[i].Name] = true
	}
	return names
}

func TestApplicationReconciler_pruneOldReleases_noPruningWhenBelowLimit(t *testing.T) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := make([]pipelinesv1alpha1.ReleasePhase, 5)
	for i := range phases {
		phases[i] = pipelinesv1alpha1.ReleaseSuperseded
	}
	recorder := record.NewFakeRecorder(10)
	r := &ApplicationReconciler{client: newPruneTestClient(buildReleases(base, phases)...), EventRecorder: recorder}

	if err := r.pruneOldReleases(ctx, pruneTestApp); err != nil {
		t.Fatalf("pruneOldReleases failed: %v", err)
	}

	if got := countReleases(ctx, t, r); got != 5 {
		t.Fatalf("expected 5 releases, got %d", got)
	}

	select {
	case ev := <-recorder.Events:
		t.Fatalf("unexpected event: %s", ev)
	default:
	}
}

func TestApplicationReconciler_pruneOldReleases_prunesOldAndProtectsActiveAndLatest(t *testing.T) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := []pipelinesv1alpha1.ReleasePhase{
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded,
		pipelinesv1alpha1.ReleaseSuperseded, // release-10 is active (still protected as active)
		pipelinesv1alpha1.ReleaseComplete,   // release-11 is latest non-superseded
	}
	recorder := record.NewFakeRecorder(10)
	r := &ApplicationReconciler{client: newPruneTestClient(buildReleases(base, phases)...), EventRecorder: recorder}

	if err := r.pruneOldReleases(ctx, pruneTestApp); err != nil {
		t.Fatalf("pruneOldReleases failed: %v", err)
	}

	if got := countReleases(ctx, t, r); got != maxReleaseHistory {
		t.Fatalf("expected %d releases, got %d", maxReleaseHistory, got)
	}

	var list pipelinesv1alpha1.ReleaseList
	if err := r.client.List(ctx, &list, client.InNamespace("default"), client.MatchingLabels{engine.ApplicationNameLabelKey: pruneTestAppName}); err != nil {
		t.Fatalf("list releases: %v", err)
	}
	kept := releaseNames(&list)

	if !kept["release-10"] {
		t.Fatalf("active release release-10 was pruned")
	}
	if !kept["release-11"] {
		t.Fatalf("latest non-superseded release release-11 was pruned")
	}
	if kept["release-0"] || kept["release-1"] {
		t.Fatalf("oldest releases should have been pruned: got release-0=%v release-1=%v", kept["release-0"], kept["release-1"])
	}

	select {
	case ev := <-recorder.Events:
		want := "Normal PrunedReleases Pruned 2 old releases"
		if diff := cmp.Diff(want, ev); diff != "" {
			t.Fatalf("unexpected event (-want +got):\n%s", diff)
		}
	default:
		t.Fatalf("expected PrunedReleases event")
	}
}

func TestApplicationReconciler_pruneOldReleases_missingActiveStillPrunesSafely(t *testing.T) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := make([]pipelinesv1alpha1.ReleasePhase, 12)
	for i := range phases {
		phases[i] = pipelinesv1alpha1.ReleaseSuperseded
	}
	app := pruneTestApp.DeepCopy()
	app.Status.ReleaseRef = "does-not-exist"
	recorder := record.NewFakeRecorder(10)
	r := &ApplicationReconciler{client: newPruneTestClient(buildReleases(base, phases)...), EventRecorder: recorder}

	if err := r.pruneOldReleases(ctx, app); err != nil {
		t.Fatalf("pruneOldReleases failed: %v", err)
	}

	if got := countReleases(ctx, t, r); got != maxReleaseHistory {
		t.Fatalf("expected %d releases, got %d", maxReleaseHistory, got)
	}
}

func TestApplicationReconciler_recordEvent(t *testing.T) {
	t.Run("records event when recorder is present", func(t *testing.T) {
		recorder := record.NewFakeRecorder(1)
		r := &ApplicationReconciler{EventRecorder: recorder}
		app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"}}

		r.recordEvent(app, corev1.EventTypeNormal, "TestReason", "test message")

		select {
		case ev := <-recorder.Events:
			if ev == "" {
				t.Fatalf("expected non-empty event")
			}
		default:
			t.Fatalf("expected event to be recorded")
		}
	})

	t.Run("no panic when recorder is nil", func(t *testing.T) {
		r := &ApplicationReconciler{}
		app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"}}
		r.recordEvent(app, corev1.EventTypeNormal, "TestReason", "test message")
	})
}

func TestApplicationReconciler_handleSyncTrigger(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name             string
		annotation       string
		manual           bool
		wantManual       bool
		wantPhase        pipelinesv1alpha1.ApplicationPhase
		wantSourceStatus bool
	}{
		{"sync annotation refresh", "paprika.io/sync", false, false, pipelinesv1alpha1.ApplicationHealthy, true},
		{"legacy resync annotation refresh", "paprika.io/resync", false, false, pipelinesv1alpha1.ApplicationHealthy, true},
		{"legacy webhook trigger annotation refresh", "paprika.io/webhook-trigger", false, false, pipelinesv1alpha1.ApplicationHealthy, true},
		{"api manual sync", "paprika.io/sync", true, true, pipelinesv1alpha1.ApplicationPending, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			annotations := map[string]string{tc.annotation: "123"}
			if tc.manual {
				annotations[manualSyncAnnotation] = "123"
			}
			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:        "sync-app",
					Namespace:   "default",
					Annotations: annotations,
				},
				Status: pipelinesv1alpha1.ApplicationStatus{
					Phase: pipelinesv1alpha1.ApplicationHealthy,
				},
			}

			scheme := runtime.NewScheme()
			_ = pipelinesv1alpha1.AddToScheme(scheme)
			c := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(app).
				WithStatusSubresource(&pipelinesv1alpha1.Application{}).
				Build()

			r := &ApplicationReconciler{client: c}
			_, err := r.handleSyncTrigger(ctx, app)
			if err != nil {
				t.Fatalf("handleSyncTrigger failed: %v", err)
			}

			var updated pipelinesv1alpha1.Application
			if err := c.Get(ctx, client.ObjectKey{Name: "sync-app", Namespace: "default"}, &updated); err != nil {
				t.Fatalf("get application: %v", err)
			}
			if _, ok := updated.Annotations[tc.annotation]; ok {
				t.Fatalf("expected sync trigger annotation to be cleared, got %v", updated.Annotations)
			}
			_, hasManual := updated.Annotations[manualSyncAnnotation]
			if hasManual != tc.wantManual {
				t.Fatalf("manual-sync annotation present = %v, want %v; annotations=%v", hasManual, tc.wantManual, updated.Annotations)
			}
			if updated.Status.Phase != tc.wantPhase {
				t.Fatalf("phase = %s, want %s", updated.Status.Phase, tc.wantPhase)
			}
			if tc.wantSourceStatus && updated.Status.SourceHash == "" {
				t.Fatalf("expected refresh to record a source hash")
			}
		})
	}
}

func TestApplicationReconciler_handleSyncTrigger_changedSourceStartsNewReleaseFlow(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "git-app",
			Namespace:   "default",
			Annotations: map[string]string{syncAnnotation: "123"},
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Source: pipelinesv1alpha1.ApplicationSource{
				Type:     pipelinesv1alpha1.SourceTypeGit,
				RepoURL:  "https://github.com/org/repo.git",
				Revision: "main",
				Path:     "charts/app",
			},
			Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
			SyncPolicy: pipelinesv1alpha1.SyncAuto,
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase:      pipelinesv1alpha1.ApplicationHealthy,
			SourceHash: "old-hash",
			ReleaseRef: "git-app-release",
		},
	}
	template := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "git-app-template", Namespace: "default"},
		Spec: pipelinesv1alpha1.TemplateSpec{
			Type: pipelinesv1alpha1.SourceTypeGit,
			Git: &pipelinesv1alpha1.GitSourceSpec{
				RepoURL:  "https://github.com/org/repo.git",
				Revision: "main",
				Path:     "charts/app",
			},
		},
	}
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "git-app-release", Namespace: "default"},
		Status:     pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseComplete},
	}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app, template, release).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).
		Build()

	r := &ApplicationReconciler{
		client: c,
		TemplateRenderer: &staticSourceRenderer{result: &source.ResolveResult{
			Hash:     "new-hash",
			Revision: "new-revision",
		}},
	}
	if _, err := r.handleSyncTrigger(ctx, app); err != nil {
		t.Fatalf("handleSyncTrigger failed: %v", err)
	}

	var updated pipelinesv1alpha1.Application
	if err := c.Get(ctx, client.ObjectKey{Name: "git-app", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get application: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ApplicationPending {
		t.Fatalf("phase = %s, want Pending", updated.Status.Phase)
	}
	if updated.Status.ReleaseRef != "" {
		t.Fatalf("releaseRef = %q, want empty so a new Release can be created", updated.Status.ReleaseRef)
	}
	if updated.Status.SourceHash != "new-hash" || updated.Status.SourceRevision != "new-revision" {
		t.Fatalf("source status = (%q, %q), want (new-hash, new-revision)", updated.Status.SourceHash, updated.Status.SourceRevision)
	}
	if _, ok := updated.Annotations[syncAnnotation]; ok {
		t.Fatalf("sync annotation was not cleared: %v", updated.Annotations)
	}
	if _, ok := updated.Annotations[manualSyncAnnotation]; ok {
		t.Fatalf("webhook-style sync should not create manual override annotation: %v", updated.Annotations)
	}

	var updatedRelease pipelinesv1alpha1.Release
	if err := c.Get(ctx, client.ObjectKey{Name: "git-app-release", Namespace: "default"}, &updatedRelease); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updatedRelease.Status.Phase != pipelinesv1alpha1.ReleaseSuperseded {
		t.Fatalf("release phase = %s, want Superseded", updatedRelease.Status.Phase)
	}
}

func TestApplicationReconciler_hasSyncTrigger(t *testing.T) {
	cases := []struct {
		name string
		ann  map[string]string
		want bool
	}{
		{"sync annotation", map[string]string{"paprika.io/sync": "1"}, true},
		{"legacy resync annotation", map[string]string{"paprika.io/resync": "1"}, true},
		{"legacy webhook trigger annotation", map[string]string{"paprika.io/webhook-trigger": "1"}, true},
		{"no annotations", nil, false},
		{"unrelated annotation", map[string]string{"other": "1"}, false},
		{"manual sync annotation", map[string]string{manualSyncAnnotation: "1"}, false},
	}

	r := &ApplicationReconciler{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := &pipelinesv1alpha1.Application{
				ObjectMeta: metav1.ObjectMeta{
					Name:        "app",
					Namespace:   "default",
					Annotations: tc.ann,
				},
			}
			if got := r.hasSyncTrigger(app); got != tc.want {
				t.Fatalf("hasSyncTrigger = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestApplicationReconciler_reconcileSingleStage_usesAppLevelCanaryStrategy(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)

	app := &pipelinesv1alpha1.Application{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "pipelines.paprika.io/v1alpha1",
			Kind:       "Application",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "demo-app",
			Namespace: "default",
			UID:       types.UID("demo-app-uid"),
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Strategy: pipelinesv1alpha1.StrategyCanary,
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
				{
					Name: "dev",
					Ring: 1,
					Canary: &pipelinesv1alpha1.CanaryConfig{
						Steps:           []int{50, 100},
						IntervalSeconds: 10,
					},
				},
			},
		},
	}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		Build()
	r := &ApplicationReconciler{client: c, Scheme: scheme}

	if err := r.reconcileSingleStage(ctx, app, &app.Spec.Stages[0], "demo-template", "demo-app-dev"); err != nil {
		t.Fatalf("reconcileSingleStage failed: %v", err)
	}

	var stage pipelinesv1alpha1.Stage
	if err := c.Get(ctx, client.ObjectKey{Name: "demo-app-dev", Namespace: "default"}, &stage); err != nil {
		t.Fatalf("get stage: %v", err)
	}
	if stage.Spec.Canary == nil {
		t.Fatalf("expected app-level canary strategy to populate stage canary")
	}
	if diff := cmp.Diff(app.Spec.Stages[0].Canary, stage.Spec.Canary); diff != "" {
		t.Fatalf("unexpected canary config (-want +got):\n%s", diff)
	}
}

func TestApplicationReconciler_handleHealthyPhase_changedSourceStartsNewReleaseFlow(t *testing.T) {
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "healthy-git-app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Source: pipelinesv1alpha1.ApplicationSource{
				Type:     pipelinesv1alpha1.SourceTypeGit,
				RepoURL:  "https://github.com/org/repo.git",
				Revision: "main",
				Path:     "charts/app",
			},
			Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
			SyncPolicy: pipelinesv1alpha1.SyncAuto,
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase:      pipelinesv1alpha1.ApplicationHealthy,
			SourceHash: "old-hash",
			ReleaseRef: "healthy-git-app-release",
		},
	}
	template := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "healthy-git-app-template", Namespace: "default"},
		Spec: pipelinesv1alpha1.TemplateSpec{
			Type: pipelinesv1alpha1.SourceTypeGit,
			Git:  &pipelinesv1alpha1.GitSourceSpec{RepoURL: "https://github.com/org/repo.git", Revision: "main", Path: "charts/app"},
		},
	}
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "healthy-git-app-release", Namespace: "default"},
		Status:     pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseComplete},
	}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app, template, release).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).
		Build()

	r := &ApplicationReconciler{
		client: c,
		TemplateRenderer: &staticSourceRenderer{result: &source.ResolveResult{
			Hash:     "new-hash",
			Revision: "new-revision",
		}},
	}
	if _, err := r.handleHealthyPhase(ctx, app); err != nil {
		t.Fatalf("handleHealthyPhase failed: %v", err)
	}

	var updated pipelinesv1alpha1.Application
	if err := c.Get(ctx, client.ObjectKey{Name: "healthy-git-app", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get application: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ApplicationPending {
		t.Fatalf("phase = %s, want Pending", updated.Status.Phase)
	}
	if updated.Status.ReleaseRef != "" {
		t.Fatalf("releaseRef = %q, want empty so a new Release can be created", updated.Status.ReleaseRef)
	}

	var updatedRelease pipelinesv1alpha1.Release
	if err := c.Get(ctx, client.ObjectKey{Name: "healthy-git-app-release", Namespace: "default"}, &updatedRelease); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updatedRelease.Status.Phase != pipelinesv1alpha1.ReleaseSuperseded {
		t.Fatalf("release phase = %s, want Superseded", updatedRelease.Status.Phase)
	}
}

func TestApplicationReconciler_buildRelease_usesSourceHashForReleaseCRAndStableHelmName(t *testing.T) {
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "git-app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Parameters: map[string]string{"image.tag": "v1"},
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			SourceHash:     "abcdef1234567890:0123456789abcdef",
			SourceRevision: "0123456789abcdef0123456789abcdef01234567",
		},
	}
	stage := &pipelinesv1alpha1.ApplicationPromotionStage{Name: "dev", Ring: 1}

	release := (&ApplicationReconciler{}).buildRelease(app, stage)

	if release.Name == "git-app-release" {
		t.Fatalf("release CR name should include source identity, got %q", release.Name)
	}
	if !strings.HasPrefix(release.Name, "git-app-release-") {
		t.Fatalf("release CR name = %q, want git-app-release-*", release.Name)
	}
	if strings.Contains(release.Name, ":") || len(release.Name) > 63 {
		t.Fatalf("release CR name must be a DNS label, got %q", release.Name)
	}
	if got := release.Spec.Parameters["release-name"]; got != "git-app-release" {
		t.Fatalf("stable Helm release-name = %q, want git-app-release", got)
	}
	if got := release.Spec.Parameters["image.tag"]; got != "v1" {
		t.Fatalf("image.tag parameter = %q, want v1", got)
	}
}

func TestApplicationReconciler_reconcileAnalysisRuns_createsRunAndAggregates(t *testing.T) {
	ctx := context.Background()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app",
			Namespace: "default",
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			AnalysisTemplates: []pipelinesv1alpha1.AnalysisTemplateRef{
				{Name: "tpl", IntervalSeconds: 30},
			},
		},
	}

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).
		Build()

	r := &ApplicationReconciler{client: c, Scheme: scheme}
	if err := r.reconcileAnalysisRuns(ctx, app); err != nil {
		t.Fatalf("reconcileAnalysisRuns failed: %v", err)
	}

	var run pipelinesv1alpha1.AnalysisRun
	if err := c.Get(ctx, client.ObjectKey{Name: "app-tpl-analysis", Namespace: "default"}, &run); err != nil {
		t.Fatalf("expected analysis run to be created: %v", err)
	}
	if run.Spec.TemplateRef != "tpl" {
		t.Errorf("templateRef: got %q, want %q", run.Spec.TemplateRef, "tpl")
	}
	if run.Spec.IntervalSeconds != 30 {
		t.Errorf("intervalSeconds: got %d, want 30", run.Spec.IntervalSeconds)
	}
}

func TestApplicationReconciler_reconcileAnalysisRuns_deletesStaleRun(t *testing.T) {
	ctx := context.Background()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app",
			Namespace: "default",
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			AnalysisTemplates: []pipelinesv1alpha1.AnalysisTemplateRef{
				{Name: "tpl", IntervalSeconds: 30},
			},
		},
	}

	staleRun := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-old-analysis",
			Namespace: "default",
			Labels: map[string]string{
				engine.ApplicationNameLabelKey: "app",
			},
		},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef:    "old",
			ApplicationRef: "app",
		},
	}

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app, staleRun).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).
		Build()

	r := &ApplicationReconciler{client: c, Scheme: scheme}
	if err := r.reconcileAnalysisRuns(ctx, app); err != nil {
		t.Fatalf("reconcileAnalysisRuns failed: %v", err)
	}

	var list pipelinesv1alpha1.AnalysisRunList
	if err := c.List(ctx, &list, client.InNamespace("default")); err != nil {
		t.Fatalf("list analysis runs: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("expected 1 analysis run, got %d", len(list.Items))
	}
	if list.Items[0].Name != "app-tpl-analysis" {
		t.Errorf("unexpected run name: %s", list.Items[0].Name)
	}
}

func TestApplicationReconciler_handleAnalysisFailure_rollback(t *testing.T) {
	ctx := context.Background()

	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-release",
			Namespace: "default",
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase: pipelinesv1alpha1.ReleaseComplete,
		},
	}

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app",
			Namespace: "default",
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			AnalysisTemplates: []pipelinesv1alpha1.AnalysisTemplateRef{
				{
					Name: "tpl",
					OnFailure: &pipelinesv1alpha1.FailureAction{
						Action: "rollback",
					},
				},
			},
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase:      pipelinesv1alpha1.ApplicationHealthy,
			ReleaseRef: release.Name,
		},
	}

	failedRun := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-tpl-analysis",
			Namespace: "default",
		},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef:    "tpl",
			ApplicationRef: "app",
		},
		Status: pipelinesv1alpha1.AnalysisRunStatus{
			Phase: pipelinesv1alpha1.AnalysisRunFailed,
		},
	}

	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app, release, failedRun).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}).
		Build()

	r := &ApplicationReconciler{client: c, Scheme: scheme}
	if err := r.handleAnalysisFailure(ctx, app); err != nil {
		t.Fatalf("handleAnalysisFailure failed: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := c.Get(ctx, client.ObjectKey{Name: release.Name, Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if _, ok := updated.Annotations[rollbackAnnotation]; !ok {
		t.Errorf("expected release to have rollback annotation")
	}
}
