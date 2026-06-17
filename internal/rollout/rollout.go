// Package rollout provides the strategy engine for the Rollout controller.
package rollout

import (
	"fmt"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/abtest"
	"github.com/benebsworth/paprika/internal/rollout/bluegreen"
	"github.com/benebsworth/paprika/internal/rollout/canary"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/mirror"
	"github.com/benebsworth/paprika/internal/rollout/rolling"
)

// Strategy is the rollout strategy interface.
type Strategy = core.Strategy

// SyncResult is the output of a strategy Sync call.
type SyncResult = core.SyncResult

// Action describes the high-level action the controller should take.
type Action = core.Action

// ReplicaSetAction describes a ReplicaSet the controller should reconcile.
type ReplicaSetAction = core.ReplicaSetAction

// Exported action constants for callers that import this package.
const (
	ActionNone         = core.ActionNone
	ActionCreateStable = core.ActionCreateStable
	ActionPromote      = core.ActionPromote
	ActionStep         = core.ActionStep
	ActionPause        = core.ActionPause
	ActionRollback     = core.ActionRollback
	ActionComplete     = core.ActionComplete
)

// NewStrategy creates a Strategy for the given RolloutStrategy spec.
func NewStrategy(spec *rolloutsv1alpha1.RolloutStrategy) (Strategy, error) {
	switch spec.Type {
	case "Rolling":
		return rolling.NewStrategy(spec.Rolling), nil
	case "Canary":
		return canary.NewStrategy(spec.Canary), nil
	case "BlueGreen":
		return bluegreen.NewStrategy(spec.BlueGreen), nil
	case "ABTest":
		return abtest.NewStrategy(spec.ABTest), nil
	case "Mirror":
		return mirror.NewStrategy(spec.Mirror), nil
	default:
		return nil, fmt.Errorf("unknown strategy type: %s", spec.Type)
	}
}
