package featureflag

import (
	"errors"
	"fmt"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/ext"

	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
)

// ValidateValue returns an error if the value does not match the expected flag type.
func ValidateValue(flagType string, value featureflagsv1alpha1.FeatureFlagValue) error {
	switch flagType {
	case "boolean":
		if value.BoolValue == nil {
			return errors.New("boolean value required")
		}
	case "string":
		if value.StringValue == nil {
			return errors.New("string value required")
		}
	case "int":
		if value.IntValue == nil {
			return errors.New("int value required")
		}
	case "float":
		if value.FloatValue == nil {
			return errors.New("float value required")
		}
	default:
		return fmt.Errorf("unsupported flag type %q", flagType)
	}
	return nil
}

// ValidateDefaultValue validates the default value for a flag type.
func ValidateDefaultValue(flagType string, value featureflagsv1alpha1.FeatureFlagValue) error {
	return ValidateValue(flagType, value)
}

// ValidateCondition checks that a targeting rule condition compiles to a boolean CEL expression.
func ValidateCondition(condition string) error {
	env, err := cel.NewEnv(
		cel.Variable("user", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("group", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("device", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("targetingKey", cel.StringType),
		ext.Strings(),
	)
	if err != nil {
		return fmt.Errorf("create CEL environment: %w", err)
	}
	ast, issues := env.Compile(condition)
	if issues != nil && issues.Err() != nil {
		return fmt.Errorf("compile CEL condition: %w", issues.Err())
	}
	if ast.OutputType() != cel.BoolType {
		return errors.New("condition must evaluate to a boolean")
	}
	return nil
}
