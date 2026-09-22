package main

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// The fixture mints one pipeline per seeded application, named
// "<application>-build".
//
// Without these two methods the calls fell through to the embedded
// PaprikaServer, which has no Kubernetes backing here: ListPipelines answered
// with an empty set and GetPipeline failed outright, so the pipeline detail
// view was unreachable in development and in the end-to-end suite.
const pipelineNameSuffix = "-build"

// maxListedPipelines bounds the list response. Like every other feed in this
// fixture it must not grow with --applications, or the 10,000-application
// gate allocates a pipeline per application on every request.
const maxListedPipelines = 100

func pipelineName(application string) string {
	return application + pipelineNameSuffix
}

// applicationForPipeline reverses pipelineName. It returns false for a name the
// fixture never minted, so the console's not-found path stays reachable.
func applicationForPipeline(name string) (string, bool) {
	application, ok := strings.CutSuffix(name, pipelineNameSuffix)
	if !ok || application == "" {
		return "", false
	}
	if fixtureApplicationIndex(application) < 0 {
		return "", false
	}
	return application, true
}

// stepPhases maps a pipeline phase onto its per-step phases. A pipeline that
// says it is running must not show four completed steps.
func stepPhasesFor(phase string, stepCount, progressed int) []string {
	phases := make([]string, stepCount)
	for i := range phases {
		switch {
		case phase == "Succeeded":
			phases[i] = "Succeeded"
		case phase == "Failed" && i < progressed:
			phases[i] = "Succeeded"
		case phase == "Failed" && i == progressed:
			phases[i] = "Failed"
		case i < progressed:
			phases[i] = "Succeeded"
		case i == progressed:
			phases[i] = "Running"
		default:
			phases[i] = "Pending"
		}
	}
	return phases
}

func (c *consoleServer) buildPipeline(index int) *paprikav1.Pipeline {
	namespace := fixtureNamespace(index)
	application := fixtureApplicationName(index)
	name := pipelineName(application)

	seed := consoleHash(namespace, name)
	stepCount := len(pipelineStepNames)
	progressed := consoleSpread(seed, 0, stepCount)

	phase := "Running"
	switch seed % 5 {
	case 0:
		phase = "Failed"
	case 1, 2:
		phase = "Succeeded"
	}

	steps := make([]*paprikav1.Step, 0, stepCount)
	statuses := make([]*paprikav1.StepStatus, 0, stepCount)
	phases := stepPhasesFor(phase, stepCount, progressed)

	for i, stepName := range pipelineStepNames {
		depends := []string(nil)
		if i > 0 {
			depends = []string{pipelineStepNames[i-1]}
		}
		steps = append(steps, &paprikav1.Step{
			Name:    stepName,
			Image:   "ghcr.io/paprikacd/toolchain:v1",
			Script:  "paprika " + stepName,
			Depends: depends,
		})
		statuses = append(statuses, &paprikav1.StepStatus{
			Name:  stepName,
			Phase: phases[i],
		})
	}

	return &paprikav1.Pipeline{
		Name:         name,
		Namespace:    namespace,
		Steps:        steps,
		StepStatuses: statuses,
		MaxParallel:  1,
		Phase:        phase,
	}
}

// ListPipelines serves one pipeline per seeded application, bounded.
func (c *consoleServer) ListPipelines(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPipelinesRequest],
) (*connect.Response[paprikav1.ListPipelinesResponse], error) {
	// Run the embedded server first so authorization and scope validation
	// behave exactly as they do in production.
	if _, err := c.PaprikaServer.ListPipelines(ctx, req); err != nil {
		return nil, err
	}

	wantNamespace := req.Msg.GetNamespace()
	pipelines := make([]*paprikav1.Pipeline, 0, min(c.applications, maxListedPipelines))
	for index := range c.applications {
		if len(pipelines) >= maxListedPipelines {
			break
		}
		if wantNamespace != "" && fixtureNamespace(index) != wantNamespace {
			continue
		}
		pipelines = append(pipelines, c.buildPipeline(index))
	}

	return connect.NewResponse(&paprikav1.ListPipelinesResponse{Pipelines: pipelines}), nil
}

// GetPipeline resolves exactly the names ListPipelines mints.
func (c *consoleServer) GetPipeline(
	ctx context.Context,
	req *connect.Request[paprikav1.GetPipelineRequest],
) (*connect.Response[paprikav1.GetPipelineResponse], error) {
	application, ok := applicationForPipeline(req.Msg.GetName())
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, errPipelineNotFound)
	}
	index := fixtureApplicationIndex(application)
	if index < 0 || index >= c.applications {
		return nil, connect.NewError(connect.CodeNotFound, errPipelineNotFound)
	}
	if ns := req.Msg.GetNamespace(); ns != "" && ns != fixtureNamespace(index) {
		return nil, connect.NewError(connect.CodeNotFound, errPipelineNotFound)
	}

	return connect.NewResponse(&paprikav1.GetPipelineResponse{
		Pipeline: c.buildPipeline(index),
	}), nil
}
