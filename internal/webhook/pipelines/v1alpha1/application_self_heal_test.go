package v1alpha1

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestApplicationSelfHealHealthFailureThreshold(t *testing.T) {
	for _, test := range []struct {
		name     string
		selfHeal string
		invalid  bool
	}{
		{name: "omitted self heal", selfHeal: "null"},
		{name: "omitted threshold", selfHeal: `{}`},
		{name: "single observation", selfHeal: `{"healthFailureThreshold":1}`},
		{name: "three observations", selfHeal: `{"healthFailureThreshold":3}`},
		{name: "maximum threshold", selfHeal: `{"healthFailureThreshold":10}`},
		{name: "negative threshold", selfHeal: `{"healthFailureThreshold":-1}`, invalid: true},
		{name: "excessive threshold", selfHeal: `{"healthFailureThreshold":11}`, invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := triggerTestApplication("service", "default")
			require.NoError(t, json.Unmarshal([]byte(test.selfHeal), &app.Spec.SelfHeal))
			validator := &ApplicationCustomValidator{}
			for _, operation := range []struct {
				name string
				run  func(*api.Application) error
			}{
				{name: "create", run: func(app *api.Application) error {
					_, err := validator.ValidateCreate(t.Context(), app)
					return err
				}},
				{name: "update", run: func(app *api.Application) error {
					_, err := validator.ValidateUpdate(t.Context(), triggerTestApplication("service", "default"), app)
					return err
				}},
			} {
				t.Run(operation.name, func(t *testing.T) {
					err := operation.run(app)
					if !test.invalid {
						require.NoError(t, err)
						return
					}
					require.Error(t, err)
					require.True(t, apierrors.IsInvalid(err))
					require.Contains(t, err.Error(), "spec.selfHeal.healthFailureThreshold")
					require.Contains(t, err.Error(), "must be between 1 and 10")
				})
			}
		})
	}
}
