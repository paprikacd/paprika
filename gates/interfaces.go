// Package gates provides verification gate implementations for pipeline promotion stages.
package gates

import "context"

//go:generate mockgen -destination=mocks/gate_executor.go -package=mocks . GateExecutor

// GateExecutor defines the interface for executing verification gates.
type GateExecutor interface {
	Execute(ctx context.Context, config GateConfig) GateResult
}

// Compile-time checks for interface implementations.
var (
	_ GateExecutor = (*SmokeGate)(nil)
	_ GateExecutor = (*DurationGate)(nil)
)
