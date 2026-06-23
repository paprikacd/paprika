package policy

import (
	"fmt"

	"github.com/google/cel-go/cel"
)

// CompileExpression validates a policy CEL expression against the standard
// variable environment exposed to policies at evaluation time.
func CompileExpression(expr string) error {
	env, err := cel.NewEnv(
		cel.Variable("object", cel.MapType(cel.StringType, cel.AnyType)),
		cel.Variable("kind", cel.StringType),
		cel.Variable("apiVersion", cel.StringType),
		cel.Variable("name", cel.StringType),
		cel.Variable("namespace", cel.StringType),
		cel.Variable("labels", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("annotations", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("spec", cel.MapType(cel.StringType, cel.AnyType)),
	)
	if err != nil {
		return fmt.Errorf("failed to create CEL environment: %w", err)
	}
	if _, iss := env.Compile(expr); iss != nil {
		return fmt.Errorf("compile CEL expression: %w", iss.Err())
	}
	return nil
}
