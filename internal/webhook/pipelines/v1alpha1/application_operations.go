package v1alpha1

import (
	"k8s.io/apimachinery/pkg/util/validation/field"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

func validateApplicationOperations(app *api.Application) field.ErrorList {
	var errors field.ErrorList
	for i, check := range app.Spec.HealthChecks {
		if check.SLO != nil {
			if _, _, err := health.SLODurations(check); err != nil {
				errors = append(errors, field.Invalid(field.NewPath("spec", "healthChecks").Index(i).Child("slo"), "[configuration]", err.Error()))
			}
		}
	}
	if app.Spec.Operations != nil {
		for i, link := range app.Spec.Operations.Links {
			if !health.SafeOperationalURL(link.URL) {
				errors = append(errors, field.Invalid(field.NewPath("spec", "operations", "links").Index(i).Child("url"), "[URL]", "must be an absolute HTTP(S) URL without embedded credentials"))
			}
		}
	}
	return errors
}
