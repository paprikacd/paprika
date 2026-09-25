package pipelines

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func rollingSyncScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := pipelinesv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return s
}

func desiredApp(name, wave, image string) pipelinesv1alpha1.Application {
	return pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "default",
			Labels:    map[string]string{"wave": wave},
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Source: pipelinesv1alpha1.ApplicationSource{Image: image},
		},
	}
}

func existingApp(name, wave, image, health string) *pipelinesv1alpha1.Application {
	app := desiredApp(name, wave, image)
	app.Status.Health = pipelinesv1alpha1.HealthStatus(health)
	app.Status.Phase = pipelinesv1alpha1.ApplicationPhase(health)
	return &app
}

func rollingSyncSet(steps ...pipelinesv1alpha1.RollingSyncStep) *pipelinesv1alpha1.ApplicationSet {
	return &pipelinesv1alpha1.ApplicationSet{
		Spec: pipelinesv1alpha1.ApplicationSetSpec{
			Strategy: &pipelinesv1alpha1.ApplicationSetStrategy{
				Type:        "RollingSync",
				RollingSync: &pipelinesv1alpha1.RollingSyncStrategy{Steps: steps},
			},
		},
	}
}

func getSpecImage(t *testing.T, c client.Client, name string) string {
	t.Helper()
	var app pipelinesv1alpha1.Application
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: name}, &app); err != nil {
		t.Fatalf("get %s: %v", name, err)
	}
	return app.Spec.Source.Image
}

func TestRollingSync_HealthGateBlocksLaterSteps(t *testing.T) {
	// canary app updated but still Progressing → prod step must not update.
	canary := existingApp("set-canary", "canary", "v2", "Progressing")
	prod := existingApp("set-prod", "prod", "v1", "Healthy")

	c := fake.NewClientBuilder().WithScheme(rollingSyncScheme(t)).
		WithObjects(canary, prod).Build()
	r := &ApplicationSetReconciler{client: c}

	desired := map[string]pipelinesv1alpha1.Application{
		"set-canary": desiredApp("set-canary", "canary", "v2"),
		"set-prod":   desiredApp("set-prod", "prod", "v2"),
	}
	existing := map[string]pipelinesv1alpha1.Application{
		"set-canary": *canary,
		"set-prod":   *prod,
	}

	gated, err := r.applyApplicationUpdates(context.Background(), rollingSyncSet(
		pipelinesv1alpha1.RollingSyncStep{MatchLabels: map[string]string{"wave": "canary"}},
		pipelinesv1alpha1.RollingSyncStep{MatchLabels: map[string]string{"wave": "prod"}},
	), desired, existing)
	if err != nil {
		t.Fatal(err)
	}
	if !gated {
		t.Fatal("expected the prod step to be gated by the unhealthy canary")
	}
	if got := getSpecImage(t, c, "set-prod"); got != "v1" {
		t.Fatalf("prod was updated behind a gated step: image=%s", got)
	}
}

func TestRollingSync_HealthyPriorStepUnblocks(t *testing.T) {
	canary := existingApp("set-canary", "canary", "v2", "Healthy") // already at desired + healthy
	prod := existingApp("set-prod", "prod", "v1", "Healthy")

	c := fake.NewClientBuilder().WithScheme(rollingSyncScheme(t)).
		WithObjects(canary, prod).Build()
	r := &ApplicationSetReconciler{client: c}

	desired := map[string]pipelinesv1alpha1.Application{
		"set-canary": desiredApp("set-canary", "canary", "v2"),
		"set-prod":   desiredApp("set-prod", "prod", "v2"),
	}
	existing := map[string]pipelinesv1alpha1.Application{
		"set-canary": *canary,
		"set-prod":   *prod,
	}

	gated, err := r.applyApplicationUpdates(context.Background(), rollingSyncSet(
		pipelinesv1alpha1.RollingSyncStep{MatchLabels: map[string]string{"wave": "canary"}},
		pipelinesv1alpha1.RollingSyncStep{MatchLabels: map[string]string{"wave": "prod"}},
	), desired, existing)
	if err != nil {
		t.Fatal(err)
	}
	if gated {
		t.Fatal("healthy prior step should not gate")
	}
	if got := getSpecImage(t, c, "set-prod"); got != "v2" {
		t.Fatalf("prod should have updated: image=%s", got)
	}
}

func TestRollingSync_MaxUpdateBatches(t *testing.T) {
	one := intstr.FromInt(1)
	apps := []*pipelinesv1alpha1.Application{
		existingApp("set-a", "prod", "v1", "Healthy"),
		existingApp("set-b", "prod", "v1", "Healthy"),
		existingApp("set-c", "prod", "v1", "Healthy"),
	}
	objs := []client.Object{apps[0], apps[1], apps[2]}
	c := fake.NewClientBuilder().WithScheme(rollingSyncScheme(t)).WithObjects(objs...).Build()
	r := &ApplicationSetReconciler{client: c}

	desired := map[string]pipelinesv1alpha1.Application{}
	existing := map[string]pipelinesv1alpha1.Application{}
	for _, a := range apps {
		desired[a.Name] = desiredApp(a.Name, "prod", "v2")
		existing[a.Name] = *a
	}

	gated, err := r.applyApplicationUpdates(context.Background(), rollingSyncSet(
		pipelinesv1alpha1.RollingSyncStep{MatchLabels: map[string]string{"wave": "prod"}, MaxUpdate: &one},
	), desired, existing)
	if err != nil {
		t.Fatal(err)
	}
	if !gated {
		t.Fatal("budget spent mid-step should report gated")
	}
	updated := 0
	for _, name := range []string{"set-a", "set-b", "set-c"} {
		if getSpecImage(t, c, name) == "v2" {
			updated++
		}
	}
	if updated != 1 {
		t.Fatalf("maxUpdate=1 should update exactly one app, got %d", updated)
	}
}

func TestRollingSync_UnmatchedAppsUpdateLast(t *testing.T) {
	// "set-misc" matches no step → trailing implicit step, gated on canary.
	canary := existingApp("set-canary", "canary", "v1", "Progressing")
	misc := existingApp("set-misc", "misc", "v1", "Healthy")

	c := fake.NewClientBuilder().WithScheme(rollingSyncScheme(t)).
		WithObjects(canary, misc).Build()
	r := &ApplicationSetReconciler{client: c}

	desired := map[string]pipelinesv1alpha1.Application{
		"set-canary": desiredApp("set-canary", "canary", "v2"),
		"set-misc":   desiredApp("set-misc", "misc", "v2"),
	}
	existing := map[string]pipelinesv1alpha1.Application{
		"set-canary": *canary,
		"set-misc":   *misc,
	}

	// Step 0 canary is outdated AND unhealthy — canary may update (step 0
	// has no priors), misc must wait for step 0 to pass.
	gated, err := r.applyApplicationUpdates(context.Background(), rollingSyncSet(
		pipelinesv1alpha1.RollingSyncStep{MatchLabels: map[string]string{"wave": "canary"}},
	), desired, existing)
	if err != nil {
		t.Fatal(err)
	}
	if !gated {
		t.Fatal("trailing step should gate on an outdated canary step")
	}
	if got := getSpecImage(t, c, "set-canary"); got != "v2" {
		t.Fatalf("canary (step 0) should have updated: image=%s", got)
	}
	if got := getSpecImage(t, c, "set-misc"); got != "v1" {
		t.Fatalf("unmatched app updated before prior steps converged: image=%s", got)
	}
}

func TestApplicationMatchesDesired_SkipsNoOpWrites(t *testing.T) {
	desired := desiredApp("a", "w", "v1")
	desired.Annotations = map[string]string{"k": "v"}
	existing := desiredApp("a", "w", "v1")
	existing.Annotations = map[string]string{"k": "v"}
	existing.Labels["extra"] = "untouched" // unmanaged labels must not force a write
	if !applicationMatchesDesired(&existing, &desired) {
		t.Fatal("identical app should match desired")
	}
	existing.Spec.Source.Image = "v0"
	if applicationMatchesDesired(&existing, &desired) {
		t.Fatal("spec drift should not match")
	}
}
