// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/benebsworth/paprika/internal/engine"
)

//go:generate mockgen -destination=mocks/diff_engine.go -package=mocks -typed . DiffEngine

// DiffEngine computes differences between desired and actual cluster state.
type DiffEngine interface {
	ComputeDiff(ctx context.Context, desired []unstructured.Unstructured, opts engine.DiffOptions) (*engine.DiffResult, error)
}
