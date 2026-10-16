package v1alpha1

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func (v *ApplicationCustomValidator) validateApplicationTrigger(ctx context.Context, app *pipelinesv1alpha1.Application) field.ErrorList {
	trigger := app.Spec.Trigger
	if trigger == nil {
		return nil
	}
	path := field.NewPath("spec", "trigger")
	switch trigger.Type {
	case pipelinesv1alpha1.ApplicationTriggerPromotion:
		return v.validatePromotionTrigger(ctx, app, path)
	case pipelinesv1alpha1.ApplicationTriggerGitOps, pipelinesv1alpha1.ApplicationTriggerManual:
		var errs field.ErrorList
		if trigger.From != nil {
			errs = append(errs, field.Forbidden(path.Child("from"), "from requires a Promotion trigger"))
		}
		if trigger.Tests != nil {
			errs = append(errs, field.Forbidden(path.Child("tests"), "tests requires a Promotion trigger"))
		}
		if len(trigger.Gates) > 0 {
			errs = append(errs, field.Forbidden(path.Child("gates"), "gates requires a Promotion trigger"))
		}
		return errs
	default:
		return field.ErrorList{field.NotSupported(path.Child("type"), trigger.Type, []string{"GitOps", "Promotion", "Manual"})}
	}
}

func (v *ApplicationCustomValidator) validatePromotionTrigger(ctx context.Context, app *pipelinesv1alpha1.Application, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	trigger := app.Spec.Trigger
	source := app.Spec.Source
	versionedInline := source.Type == pipelinesv1alpha1.SourceTypeInline && source.Inline != nil && source.Inline.Artifact != nil
	if source.Type != pipelinesv1alpha1.SourceTypeGit && !versionedInline {
		errs = append(errs, field.Invalid(field.NewPath("spec", "source", "type"), source.Type, "Promotion requires a Git source or a versioned inline artifact"))
	}
	if trigger.From == nil {
		errs = append(errs, field.Required(path.Child("from"), "Promotion requires an upstream Application reference"))
	} else {
		refErrs := validatePromotionReference(trigger.From, path.Child("from"))
		errs = append(errs, refErrs...)
		if len(refErrs) == 0 {
			errs = append(errs, v.validatePromotionChain(ctx, app, path.Child("from"))...)
		}
	}
	if trigger.Tests != nil {
		errs = append(errs, validatePromotionTests(trigger.Tests, path.Child("tests"))...)
	}
	for i, gate := range trigger.Gates {
		errs = append(errs, validatePromotionGate(gate, path.Child("gates").Index(i))...)
	}
	return errs
}

func validatePromotionReference(ref *pipelinesv1alpha1.ApplicationReference, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	if ref.Name == "" {
		errs = append(errs, field.Required(path.Child("name"), "Application name is required"))
	} else if problems := validation.IsDNS1123Subdomain(ref.Name); len(problems) > 0 {
		errs = append(errs, field.Invalid(path.Child("name"), ref.Name, strings.Join(problems, "; ")))
	}
	if ref.Namespace != "" {
		if problems := validation.IsDNS1123Label(ref.Namespace); len(problems) > 0 {
			errs = append(errs, field.Invalid(path.Child("namespace"), ref.Namespace, strings.Join(problems, "; ")))
		}
	}
	return errs
}

func promotionReferenceKey(ref *pipelinesv1alpha1.ApplicationReference, defaultNamespace string) client.ObjectKey {
	namespace := ref.Namespace
	if namespace == "" {
		namespace = defaultNamespace
	}
	return client.ObjectKey{Name: ref.Name, Namespace: namespace}
}

// Missing ancestors are accepted so a complete environment chain can be
// bootstrapped declaratively in any order. Other read failures fail closed.
func (v *ApplicationCustomValidator) validatePromotionChain(ctx context.Context, app *pipelinesv1alpha1.Application, path *field.Path) field.ErrorList {
	key := promotionReferenceKey(app.Spec.Trigger.From, app.Namespace)
	self := client.ObjectKeyFromObject(app)
	if key == self {
		return field.ErrorList{field.Invalid(path, app.Spec.Trigger.From, "an Application cannot promote from itself")}
	}
	if v.client == nil {
		return nil
	}
	visited := map[client.ObjectKey]bool{self: true}
	for {
		if visited[key] {
			return field.ErrorList{field.Invalid(path, app.Spec.Trigger.From, "upstream Application references form a promotion cycle")}
		}
		visited[key] = true
		var upstream pipelinesv1alpha1.Application
		if err := v.client.Get(ctx, key, &upstream); err != nil {
			if apierrors.IsNotFound(err) {
				return nil
			}
			return field.ErrorList{field.InternalError(path, fmt.Errorf("inspect upstream Application %s: %w", key, err))}
		}
		trigger := upstream.Spec.Trigger
		if trigger == nil || trigger.Type != pipelinesv1alpha1.ApplicationTriggerPromotion || trigger.From == nil {
			return nil
		}
		key = promotionReferenceKey(trigger.From, upstream.Namespace)
	}
}

func validatePromotionTests(tests *pipelinesv1alpha1.ApplicationBuildSpec, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	stepsPath := path.Child("steps")
	if len(tests.Steps) == 0 {
		errs = append(errs, field.Required(stepsPath, "at least one verification step is required"))
	}
	if tests.MaxParallel < 0 {
		errs = append(errs, field.Invalid(path.Child("maxParallel"), tests.MaxParallel, "must be non-negative; zero uses the default"))
	}
	names := make(map[string]bool, len(tests.Steps))
	for i := range tests.Steps {
		step := &tests.Steps[i]
		stepPath := stepsPath.Index(i)
		errs = append(errs, validatePromotionTestStep(step, stepPath)...)
		if names[step.Name] {
			errs = append(errs, field.Duplicate(stepPath.Child("name"), step.Name))
		}
		names[step.Name] = true
	}
	for i, step := range tests.Steps {
		for j, dependency := range step.Depends {
			if !names[dependency] {
				errs = append(errs, field.Invalid(stepsPath.Index(i).Child("depends").Index(j), dependency, "must reference a verification step"))
			}
		}
	}
	if len(errs) == 0 && promotionTestsHaveCycle(tests.Steps) {
		errs = append(errs, field.Invalid(stepsPath, tests.Steps, "verification step dependencies must form an acyclic graph"))
	}
	return errs
}

func validatePromotionTestStep(step *pipelinesv1alpha1.ApplicationBuildStep, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	if step.Name == "" {
		errs = append(errs, field.Required(path.Child("name"), "step name is required"))
	} else if problems := validation.IsDNS1123Label(step.Name); len(problems) > 0 {
		errs = append(errs, field.Invalid(path.Child("name"), step.Name, strings.Join(problems, "; ")))
	}
	if strings.TrimSpace(step.Image) == "" {
		errs = append(errs, field.Required(path.Child("image"), "step image is required"))
	}
	if strings.TrimSpace(step.Script) == "" {
		errs = append(errs, field.Required(path.Child("script"), "step script is required"))
	}
	if step.Timeout < 0 {
		errs = append(errs, field.Invalid(path.Child("timeout"), step.Timeout, "must be non-negative; zero uses the default"))
	}
	if step.Retry < 0 {
		errs = append(errs, field.Invalid(path.Child("retry"), step.Retry, "must be non-negative"))
	}
	return errs
}

func promotionTestsHaveCycle(steps []pipelinesv1alpha1.ApplicationBuildStep) bool {
	dependencies := make(map[string][]string, len(steps))
	for _, step := range steps {
		dependencies[step.Name] = step.Depends
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(name string) bool {
		if visiting[name] {
			return true
		}
		if visited[name] {
			return false
		}
		visiting[name] = true
		for _, dependency := range dependencies[name] {
			if visit(dependency) {
				return true
			}
		}
		visiting[name] = false
		visited[name] = true
		return false
	}
	for _, step := range steps {
		if visit(step.Name) {
			return true
		}
	}
	return false
}

func validatePromotionGate(gate pipelinesv1alpha1.GateConfig, path *field.Path) field.ErrorList {
	var errs field.ErrorList
	switch gate.Type {
	case "smoke-test":
		errs = append(errs, validatePromotionSmokeEndpoint(gate.Endpoint, path.Child("endpoint"))...)
		if gate.Timeout < 0 {
			errs = append(errs, field.Invalid(path.Child("timeout"), gate.Timeout, "must be non-negative; zero uses the default"))
		}
	case "duration":
		if gate.Timeout <= 0 {
			errs = append(errs, field.Invalid(path.Child("timeout"), gate.Timeout, "duration gates require a positive timeout in seconds"))
		}
		if gate.Endpoint != "" {
			errs = append(errs, field.Forbidden(path.Child("endpoint"), "duration gates do not use an endpoint"))
		}
	default:
		errs = append(errs, field.NotSupported(path.Child("type"), gate.Type, []string{"smoke-test", "duration"}))
	}
	return errs
}

func validatePromotionSmokeEndpoint(value string, path *field.Path) field.ErrorList {
	endpoint, err := url.Parse(value)
	if err != nil || endpoint.Hostname() == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return field.ErrorList{field.Invalid(path, value, "smoke-test requires an absolute HTTP or HTTPS endpoint")}
	}
	return nil
}
