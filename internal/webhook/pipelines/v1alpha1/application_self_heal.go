package v1alpha1

import (
	"k8s.io/apimachinery/pkg/util/validation/field"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func validateApplicationSelfHeal(app *api.Application) field.ErrorList {
	if app.Spec.SelfHeal == nil {
		return nil
	}
	threshold := app.Spec.SelfHeal.HealthFailureThreshold
	// Zero is the typed representation of an omitted field, whose default is 1.
	// The CRD schema rejects an explicitly supplied zero.
	if threshold < 0 || threshold > api.MaxHealthFailureThreshold {
		return field.ErrorList{field.Invalid(field.NewPath("spec", "selfHeal", "healthFailureThreshold"), threshold, "must be between 1 and 10")}
	}
	return nil
}
