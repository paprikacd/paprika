// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	"github.com/benebsworth/paprika/internal/gates"
)

// GateExecutor executes verification gates for pipeline promotion stages.
type GateExecutor interface {
	Execute(ctx context.Context, config gates.GateConfig) gates.GateResult
}
