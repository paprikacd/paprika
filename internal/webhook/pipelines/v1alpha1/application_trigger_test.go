package v1alpha1

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func triggerTestApplication(name, namespace string) *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "default",
			Source: pipelinesv1alpha1.ApplicationSource{
				Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/example/service", Revision: "main",
			},
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "stg", Ring: 1}},
		},
	}
}

func promotionTestTrigger() *pipelinesv1alpha1.ApplicationTrigger {
	return &pipelinesv1alpha1.ApplicationTrigger{
		Type: pipelinesv1alpha1.ApplicationTriggerPromotion,
		From: &pipelinesv1alpha1.ApplicationReference{Name: "api-dev", Namespace: "dev"},
	}
}

func promotionTestSteps() *pipelinesv1alpha1.ApplicationBuildSpec {
	return &pipelinesv1alpha1.ApplicationBuildSpec{
		MaxParallel: 2,
		Steps: []pipelinesv1alpha1.ApplicationBuildStep{
			{Name: "integration", Image: "test-runner:v1", Script: "run-integration", Depends: []string{"smoke"}, Timeout: 300, Retry: 1},
			{Name: "smoke", Image: "test-runner:v1", Script: "run-smoke"},
		},
	}
}

func TestApplicationTriggerValidationAcceptsSupportedModes(t *testing.T) {
	for _, test := range []struct {
		name   string
		modify func(*pipelinesv1alpha1.Application)
	}{
		{name: "omitted trigger preserves GitOps"},
		{name: "explicit GitOps", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{Type: pipelinesv1alpha1.ApplicationTriggerGitOps}
		}},
		{name: "Manual permits Helm sources", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{Type: pipelinesv1alpha1.ApplicationTriggerManual}
			app.Spec.Source = pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeHelm}
		}},
		{name: "GitOps permits inline sources", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{Type: pipelinesv1alpha1.ApplicationTriggerGitOps}
			app.Spec.Source = pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeInline, Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: "snapshot"}}
		}},
		{name: "Promotion with tests gates and manual authorization", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger = promotionTestTrigger()
			app.Spec.Trigger.Tests = promotionTestSteps()
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{
				{Type: "smoke-test", Endpoint: "https://dev.example.com/healthz"},
				{Type: "duration", Timeout: 60},
			}
			app.Spec.SyncPolicy = pipelinesv1alpha1.SyncManual
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := triggerTestApplication("api-stg", "stg")
			if test.modify != nil {
				test.modify(app)
			}
			v := &ApplicationCustomValidator{}
			_, err := v.ValidateCreate(t.Context(), app)
			require.NoError(t, err)
			_, err = v.ValidateUpdate(t.Context(), triggerTestApplication("api-stg", "stg"), app)
			require.NoError(t, err, "updates must use the same trigger validation")
		})
	}
}

func TestApplicationTriggerValidationRejectsInvalidConfiguration(t *testing.T) {
	for _, test := range []struct {
		name   string
		modify func(*pipelinesv1alpha1.Application)
		field  string
	}{
		{name: "unknown trigger", field: "spec.trigger.type", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Type = "Webhook"
		}},
		{name: "missing trigger type", field: "spec.trigger.type", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Type = ""
		}},
		{name: "Promotion requires upstream", field: "spec.trigger.from", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.From = nil
		}},
		{name: "upstream name required", field: "spec.trigger.from.name", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.From.Name = ""
		}},
		{name: "upstream name must be DNS compatible", field: "spec.trigger.from.name", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.From.Name = "Invalid_App"
		}},
		{name: "upstream namespace must be DNS compatible", field: "spec.trigger.from.namespace", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.From.Namespace = "team.dev"
		}},
		{name: "Promotion rejects mutable OCI source", field: "spec.source.type", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Source = pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeOCI, OCI: &pipelinesv1alpha1.OCISourceSpec{URL: "oci://example.com/service:latest"}}
		}},
		{name: "GitOps forbids promotion configuration", field: "spec.trigger.from", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Type = pipelinesv1alpha1.ApplicationTriggerGitOps
		}},
		{name: "Manual forbids verification tests", field: "spec.trigger.tests", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{Type: pipelinesv1alpha1.ApplicationTriggerManual, Tests: promotionTestSteps()}
		}},
		{name: "GitOps forbids verification gates", field: "spec.trigger.gates", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{Type: pipelinesv1alpha1.ApplicationTriggerGitOps, Gates: []pipelinesv1alpha1.GateConfig{{Type: "duration", Timeout: 1}}}
		}},
		{name: "smoke gate needs HTTP endpoint", field: "spec.trigger.gates[0].endpoint", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{{Type: "smoke-test", Endpoint: "file:///etc/passwd"}}
		}},
		{name: "smoke gate needs absolute endpoint", field: "spec.trigger.gates[0].endpoint", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{{Type: "smoke-test", Endpoint: "/healthz"}}
		}},
		{name: "smoke gate rejects negative timeout", field: "spec.trigger.gates[0].timeout", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{{Type: "smoke-test", Endpoint: "https://example.com", Timeout: -1}}
		}},
		{name: "duration needs positive timeout", field: "spec.trigger.gates[0].timeout", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{{Type: "duration"}}
		}},
		{name: "duration forbids endpoint", field: "spec.trigger.gates[0].endpoint", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{{Type: "duration", Timeout: 1, Endpoint: "https://example.com"}}
		}},
		{name: "unknown gate type", field: "spec.trigger.gates[0].type", modify: func(app *pipelinesv1alpha1.Application) {
			app.Spec.Trigger.Gates = []pipelinesv1alpha1.GateConfig{{Type: "unknown"}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := triggerTestApplication("api-stg", "stg")
			app.Spec.Trigger = promotionTestTrigger()
			test.modify(app)
			v := &ApplicationCustomValidator{}
			_, err := v.ValidateCreate(t.Context(), app)
			require.ErrorContains(t, err, test.field)
			_, err = v.ValidateUpdate(t.Context(), triggerTestApplication("api-stg", "stg"), app)
			require.ErrorContains(t, err, test.field)
		})
	}
}

func TestApplicationPromotionTestsValidateDAGAndExecutionSettings(t *testing.T) {
	for _, test := range []struct {
		name   string
		modify func(*pipelinesv1alpha1.ApplicationBuildSpec)
		field  string
	}{
		{name: "empty verification", field: "spec.trigger.tests.steps", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps = nil }},
		{name: "duplicate step names", field: "spec.trigger.tests.steps[1].name", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[1].Name = tests.Steps[0].Name }},
		{name: "missing step name", field: "spec.trigger.tests.steps[0].name", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Name = "" }},
		{name: "invalid step name", field: "spec.trigger.tests.steps[0].name", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Name = "Integration Test" }},
		{name: "blank image", field: "spec.trigger.tests.steps[0].image", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Image = " " }},
		{name: "blank script", field: "spec.trigger.tests.steps[0].script", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Script = "\n\t" }},
		{name: "negative timeout", field: "spec.trigger.tests.steps[0].timeout", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Timeout = -1 }},
		{name: "negative retry", field: "spec.trigger.tests.steps[0].retry", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Retry = -1 }},
		{name: "negative parallelism", field: "spec.trigger.tests.maxParallel", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.MaxParallel = -1 }},
		{name: "unknown dependency", field: "spec.trigger.tests.steps[0].depends[0]", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) { tests.Steps[0].Depends = []string{"missing"} }},
		{name: "self dependency", field: "acyclic", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) {
			tests.Steps[0].Depends = []string{tests.Steps[0].Name}
		}},
		{name: "cycle", field: "acyclic", modify: func(tests *pipelinesv1alpha1.ApplicationBuildSpec) {
			tests.Steps[1].Depends = []string{tests.Steps[0].Name}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := triggerTestApplication("api-stg", "stg")
			app.Spec.Trigger = promotionTestTrigger()
			app.Spec.Trigger.Tests = promotionTestSteps()
			test.modify(app.Spec.Trigger.Tests)
			_, err := (&ApplicationCustomValidator{}).ValidateCreate(t.Context(), app)
			require.ErrorContains(t, err, test.field)
		})
	}
}

func TestApplicationPromotionReferencesValidateEnvironmentGraph(t *testing.T) {
	for _, test := range []struct {
		name     string
		upstream []*pipelinesv1alpha1.Application
		from     pipelinesv1alpha1.ApplicationReference
		error    string
	}{
		{name: "missing upstream permits declarative bootstrap", from: pipelinesv1alpha1.ApplicationReference{Name: "api-dev"}},
		{name: "self reference default namespace", from: pipelinesv1alpha1.ApplicationReference{Name: "api-prod"}, error: "itself"},
		{name: "self reference explicit namespace", from: pipelinesv1alpha1.ApplicationReference{Name: "api-prod", Namespace: "prod"}, error: "itself"},
		{name: "same name other namespace", from: pipelinesv1alpha1.ApplicationReference{Name: "api-prod", Namespace: "dev"}, upstream: []*pipelinesv1alpha1.Application{triggerTestApplication("api-prod", "dev")}},
		{name: "cross namespace chain uses each ancestors namespace", from: pipelinesv1alpha1.ApplicationReference{Name: "api-stg", Namespace: "team"}, upstream: []*pipelinesv1alpha1.Application{
			promotionGraphApplication("api-stg", "team", "api-dev", ""), triggerTestApplication("api-dev", "team"),
		}},
		{name: "two application cycle", from: pipelinesv1alpha1.ApplicationReference{Name: "api-stg", Namespace: "stg"}, error: "cycle", upstream: []*pipelinesv1alpha1.Application{
			promotionGraphApplication("api-stg", "stg", "api-prod", "prod"),
		}},
		{name: "three application cycle", from: pipelinesv1alpha1.ApplicationReference{Name: "api-stg", Namespace: "stg"}, error: "cycle", upstream: []*pipelinesv1alpha1.Application{
			promotionGraphApplication("api-stg", "stg", "api-dev", "dev"), promotionGraphApplication("api-dev", "dev", "api-prod", "prod"),
		}},
		{name: "existing ancestor cycle", from: pipelinesv1alpha1.ApplicationReference{Name: "api-stg", Namespace: "stg"}, error: "cycle", upstream: []*pipelinesv1alpha1.Application{
			promotionGraphApplication("api-stg", "stg", "api-dev", "dev"), promotionGraphApplication("api-dev", "dev", "api-stg", "stg"),
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := triggerTestApplication("api-prod", "prod")
			app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{Type: pipelinesv1alpha1.ApplicationTriggerPromotion, From: &test.from}
			scheme := runtime.NewScheme()
			require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
			objects := make([]client.Object, 0, len(test.upstream))
			for _, upstream := range test.upstream {
				objects = append(objects, upstream)
			}
			v := &ApplicationCustomValidator{client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()}
			_, err := v.ValidateCreate(t.Context(), app)
			if test.error == "" {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, test.error)
			}
			_, err = v.ValidateUpdate(t.Context(), triggerTestApplication("api-prod", "prod"), app)
			if test.error == "" {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, test.error)
			}
		})
	}
}

func promotionGraphApplication(name, namespace, fromName, fromNamespace string) *pipelinesv1alpha1.Application {
	app := triggerTestApplication(name, namespace)
	app.Spec.Trigger = &pipelinesv1alpha1.ApplicationTrigger{
		Type: pipelinesv1alpha1.ApplicationTriggerPromotion,
		From: &pipelinesv1alpha1.ApplicationReference{Name: fromName, Namespace: fromNamespace},
	}
	return app
}

type unavailablePromotionReader struct{ client.Reader }

func (unavailablePromotionReader) Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error {
	return errors.New("API unavailable")
}

func TestApplicationPromotionGraphReadErrorsFailClosed(t *testing.T) {
	app := promotionGraphApplication("api-prod", "prod", "api-stg", "stg")
	v := &ApplicationCustomValidator{client: unavailablePromotionReader{}}
	_, err := v.ValidateCreate(t.Context(), app)
	require.ErrorContains(t, err, "API unavailable")
	require.ErrorContains(t, err, "spec.trigger.from")
}
