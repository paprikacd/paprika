// Package engine provides template rendering, diff computation, and workflow execution.
package engine

import (
	"context"

	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/source"
)

//go:generate mockgen -destination=mocks/template_renderer.go -package=mocks . TemplateRenderer
//go:generate mockgen -destination=mocks/diff_engine.go -package=mocks . DiffEngine
//go:generate mockgen -destination=mocks/source_resolver.go -package=mocks . SourceResolver
//go:generate mockgen -destination=mocks/workflow_engine.go -package=mocks . WorkflowEngine

// TemplateRenderer renders templates to Kubernetes manifests.
type TemplateRenderer interface {
	Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error)
	RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error)
	ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error)
	RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error)
}

// DiffOptions configures how ComputeDiff fetches live resources.
type DiffOptions struct {
	Namespace     string
	LabelSelector string
	FieldSelector string
}

// DiffEngine computes differences between desired and actual cluster state.
type DiffEngine interface {
	ComputeDiff(ctx context.Context, desired []unstructured.Unstructured, opts DiffOptions) (*DiffResult, error)
}

// SourceResolver resolves source locations.
type SourceResolver interface {
	Resolve(ctx context.Context) (*source.ResolveResult, error)
}

// WorkflowEngine executes pipeline workflows by creating Kubernetes jobs.
type WorkflowEngine interface {
	RunPipeline(ctx context.Context, pipeline *paprikav1.Pipeline) ([]paprikav1.StepStatus, error)
	CreateStepJob(ctx context.Context, step *paprikav1.PipelineStep, pipelineName string) (*batchv1.Job, error)
	GetStepLogs(ctx context.Context, pipelineName, stepName string) (string, error)
}

// Compile-time interface checks.
var (
	_ TemplateRenderer = (*TemplateRendererImpl)(nil)
	_ DiffEngine       = (*DiffEngineImpl)(nil)
	_ WorkflowEngine   = (*WorkflowEngineImpl)(nil)
)
