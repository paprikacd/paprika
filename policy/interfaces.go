package policy

import "context"

type Action string

const (
	EnforceAction Action = "enforce"
	WarnAction    Action = "warn"
)

type EvaluateOptions struct {
	Namespace       string
	ApplicationName string
	SkipPolicies    []string
	PolicyOverrides map[string]Action
}

type Result struct {
	Name     string
	Severity string
	Action   string
	Passed   bool
	Message  string
}

type EvaluationResult struct {
	Passed  bool
	Results []Result
	Blocked bool
	Message string
}

type Evaluator interface {
	Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error)
}
