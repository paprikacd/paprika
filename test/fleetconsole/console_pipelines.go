package main

import (
	"context"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// pipelineRunPrefix is the identifier shape this fixture mints:
// run-<applicationIndex>-<ordinal>.
//
// The application index is in the name on purpose. A run identifier has to be
// resolvable on its own, because GetPipelineRun receives nothing but the
// namespace and the name — it has no idea which filter the page it came from
// was built with. An ordinal alone is not enough: the same ordinal maps to a
// different application in an unfiltered feed than in a namespace-filtered one,
// so listing without a filter and then opening a row would have silently
// resolved to a different application's run.
//
// GetPipelineRun recognises exactly what ListPipelineRuns minted and NotFounds
// everything else, so the console's not-found path is reachable from here too.
const pipelineRunPrefix = "run-"

// pipelineRunName mints the self-describing identifier described above.
func pipelineRunName(application *paprikav1.FleetObjectKey, ordinal int) string {
	return pipelineRunPrefix +
		strconv.Itoa(fixtureApplicationIndex(application.GetName())) + "-" + strconv.Itoa(ordinal)
}

var pipelineStepNames = [...]string{"resolve-source", "render-manifests", "unit-tests", "publish-bundle"}

var pipelineRunOutcomeRotation = [...]paprikav1.PipelineRunOutcome{
	paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_SUCCEEDED,
	paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_SUCCEEDED,
	paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_SUCCEEDED,
	paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_FAILED,
	paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_SUCCEEDED,
	paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_CANCELLED,
}

// ListPipelineRuns serves completed pipeline run summaries.
func (c *consoleServer) ListPipelineRuns(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPipelineRunsRequest],
) (*connect.Response[paprikav1.ListPipelineRunsResponse], error) {
	response, err := c.PaprikaServer.ListPipelineRuns(ctx, req)
	if err != nil {
		return nil, err
	}
	start, end, next := pipelineRunFeed.window(
		req.Msg.GetPageSize(), req.Msg.GetCursor(), req.Msg.GetSinceUnixMs(),
	)
	runs := make([]*paprikav1.PipelineRunSummary, 0, end-start)
	for ordinal := start; ordinal < end; ordinal++ {
		application := c.pipelineRunApplication(ordinal, req.Msg)
		if application == nil {
			continue
		}
		runs = append(runs, c.buildPipelineRun(ordinal, application, req.Msg.GetPipeline()))
	}
	response.Msg.State = paprikav1.DataState_DATA_STATE_OK
	response.Msg.Runs = runs
	response.Msg.NextCursor = next
	response.Msg.RetentionHorizonUnixMs = pipelineRunFeed.horizon()
	response.Msg.RetentionLimit = pipelineRunRetentionLimit
	return response, nil
}

// GetPipelineRun returns one recorded run.
//
// The real handler always answers NotFound, but it authorizes and validates
// before it does, so delegating and then inspecting the code is what lets this
// override inherit the whole prologue instead of reimplementing it. A code
// other than NotFound is a real refusal and is passed straight through.
func (c *consoleServer) GetPipelineRun(
	ctx context.Context,
	req *connect.Request[paprikav1.GetPipelineRunRequest],
) (*connect.Response[paprikav1.GetPipelineRunResponse], error) {
	response, prologueErr := c.PaprikaServer.GetPipelineRun(ctx, req)
	if response != nil {
		// Unreachable while the RPC is stubbed. If a recorder ever lands behind
		// it, its answer is the real one and must win over this fixture's.
		return response, nil
	}
	if connect.CodeOf(prologueErr) != connect.CodeNotFound {
		return nil, prologueErr
	}
	application, ordinal, minted := c.resolvePipelineRun(req.Msg.GetNamespace(), req.Msg.GetName())
	if !minted {
		return nil, connect.NewError(connect.CodeNotFound, errPipelineRunNotFound)
	}
	return connect.NewResponse(&paprikav1.GetPipelineRunResponse{
		Run: c.buildPipelineRun(ordinal, application, nil),
	}), nil
}

// resolvePipelineRun recovers the application and ordinal a run identifier
// names, and refuses one addressed to the wrong namespace. Refusing is not
// pedantry: the namespace is the tenant boundary, and answering across it from
// a name alone would let a caller read a run it was never scoped to.
func (c *consoleServer) resolvePipelineRun(
	namespace, name string,
) (application *paprikav1.FleetObjectKey, ordinal int, ok bool) {
	suffix, found := strings.CutPrefix(name, pipelineRunPrefix)
	if !found {
		return nil, 0, false
	}
	indexText, ordinalText, split := strings.Cut(suffix, "-")
	if !split {
		return nil, 0, false
	}
	index, indexErr := strconv.Atoi(indexText)
	ordinal, ordinalErr := strconv.Atoi(ordinalText)
	if indexErr != nil || ordinalErr != nil {
		return nil, 0, false
	}
	if index < 0 || index >= c.applications || ordinal < 0 || ordinal >= pipelineRunRetentionLimit {
		return nil, 0, false
	}
	if fixtureNamespace(index) != namespace {
		return nil, 0, false
	}
	return &paprikav1.FleetObjectKey{
		Namespace: fixtureNamespace(index), Name: fixtureApplicationName(index),
	}, ordinal, true
}

func (c *consoleServer) pipelineRunApplication(
	ordinal int,
	msg *paprikav1.ListPipelineRunsRequest,
) *paprikav1.FleetObjectKey {
	if application := msg.GetApplication(); application != nil {
		return application
	}
	return c.applicationKeyForOrdinal(ordinal, msg.Namespace)
}

func (c *consoleServer) buildPipelineRun(
	ordinal int,
	application *paprikav1.FleetObjectKey,
	pipeline *paprikav1.FleetObjectKey,
) *paprikav1.PipelineRunSummary {
	outcome := pipelineRunOutcomeRotation[ordinal%len(pipelineRunOutcomeRotation)]
	finishedAt := pipelineRunFeed.timestamp(ordinal)
	steps, duration, succeeded := buildPipelineSteps(application, ordinal, outcome, finishedAt)
	if pipeline == nil {
		pipeline = &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: application.GetName() + "-pipeline",
		}
	}
	return &paprikav1.PipelineRunSummary{
		Identity: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: pipelineRunName(application, ordinal),
		},
		Pipeline:         pipeline,
		Application:      application,
		RunNumber:        countU64(pipelineRunRetentionLimit - ordinal),
		Outcome:          outcome,
		StartedAtUnixMs:  finishedAt - duration,
		FinishedAtUnixMs: finishedAt,
		DurationMs:       duration,
		StepsTotal:       countU32(len(steps)),
		StepsSucceeded:   succeeded,
		Steps:            steps,
		Commit:           syntheticCommit(application, ordinal, finishedAt-duration),
		TriggeredBy:      "paprika-pipeline-controller",
		Tests:            buildPipelineTests(application, ordinal, outcome),
		Cache:            buildPipelineCache(),
		// Requested resources times wall duration is an allocation figure, not
		// a measurement, and COMPUTE_BASIS_REQUESTED is how the wire says so.
		ComputeState:    paprikav1.DataState_DATA_STATE_OK,
		CpuMinutes:      float64(duration) / 60000 * 1.2,
		CpuMinutesBasis: paprikav1.ComputeBasis_COMPUTE_BASIS_REQUESTED,
		Artifacts:       buildPipelineArtifacts(application, outcome),
	}
}

func buildPipelineSteps(
	application *paprikav1.FleetObjectKey,
	ordinal int,
	outcome paprikav1.PipelineRunOutcome,
	finishedAt int64,
) (steps []*paprikav1.PipelineRunStep, totalDurationMs int64, succeeded uint32) {
	failedAt := len(pipelineStepNames)
	if outcome != paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_SUCCEEDED {
		failedAt = consoleSpread(consoleHash(strconv.Itoa(ordinal), "fail-step"), 1, len(pipelineStepNames)) - 1
	}
	steps = make([]*paprikav1.PipelineRunStep, 0, len(pipelineStepNames))
	for position, name := range pipelineStepNames {
		if position > failedAt {
			break
		}
		seed := consoleHash(application.GetName(), name, strconv.Itoa(ordinal))
		stepDuration := int64(consoleSpread(seed, 8, 240)) * 1000
		phase := "Succeeded"
		message := ""
		if position == failedAt && failedAt < len(pipelineStepNames) {
			phase = pipelineFailurePhase(outcome)
			message = "step did not complete; see step logs"
		} else {
			succeeded++
		}
		steps = append(steps, &paprikav1.PipelineRunStep{
			Name: name, Phase: phase,
			StartedAtUnixMs:  finishedAt - totalDurationMs - stepDuration,
			FinishedAtUnixMs: finishedAt - totalDurationMs,
			DurationMs:       stepDuration, Attempts: 1,
			Resources: buildStepResources(seed), Image: "ghcr.io/paprika/step-" + name + ":2026.01",
			Message: message,
		})
		totalDurationMs += stepDuration
	}
	return steps, totalDurationMs, succeeded
}

func pipelineFailurePhase(outcome paprikav1.PipelineRunOutcome) string {
	if outcome == paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_CANCELLED {
		return "Cancelled"
	}
	return "Failed"
}

func buildStepResources(seed uint32) *paprikav1.StepResources {
	requestCPU := float64(consoleSpread(seed, 100, 1500))
	requestMemory := float64(consoleSpread(seed>>4, 128, 2048)) * 1024 * 1024
	return &paprikav1.StepResources{
		State:                paprikav1.DataState_DATA_STATE_OK,
		CpuRequestMillicores: requestCPU,
		MemoryRequestBytes:   requestMemory,
		CpuLimitMillicores:   requestCPU * 2,
		MemoryLimitBytes:     requestMemory * 2,
	}
}

func buildPipelineTests(
	application *paprikav1.FleetObjectKey,
	ordinal int,
	outcome paprikav1.PipelineRunOutcome,
) *paprikav1.PipelineTestSummary {
	seed := consoleHash(application.GetName(), strconv.Itoa(ordinal), "tests")
	total := countU32(consoleSpread(seed, 40, 900))
	skipped := countU32(consoleSpread(seed>>3, 0, 12))
	flaked := countU32(consoleSpread(seed>>6, 0, 4))
	failed := uint32(0)
	if outcome == paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_FAILED {
		failed = countU32(consoleSpread(seed>>9, 1, 9))
	}
	return &paprikav1.PipelineTestSummary{
		State: paprikav1.DataState_DATA_STATE_OK,
		Total: total, Passed: total - skipped - failed, Failed: failed,
		Skipped: skipped, Flaked: flaked, ReportFormat: "junit",
	}
}

// buildPipelineCache reports NOT_AVAILABLE, matching the proto's own note that
// pipeline step caching does not exist. This is the one class the fixture
// refuses to populate even in --data-sources=all: the capability is absent, not
// unconfigured, and inventing a hit ratio for it would teach the console to
// render a number no control plane can ever produce.
func buildPipelineCache() *paprikav1.PipelineCacheSummary {
	return &paprikav1.PipelineCacheSummary{
		State: paprikav1.DataState_DATA_STATE_NOT_AVAILABLE,
		Scope: "manifest-render",
	}
}

func buildPipelineArtifacts(
	application *paprikav1.FleetObjectKey,
	outcome paprikav1.PipelineRunOutcome,
) []*paprikav1.ArtifactRef {
	if outcome != paprikav1.PipelineRunOutcome_PIPELINE_RUN_OUTCOME_SUCCEEDED {
		return []*paprikav1.ArtifactRef{}
	}
	digest := revisionForSeed(consoleHash(application.GetName(), "artifact"))
	return []*paprikav1.ArtifactRef{{
		Name: "rendered-manifests", Path: "bundle/manifests.yaml", Kind: "bundle",
		Reference:         "ghcr.io/paprika/" + application.GetName() + ":2026.01",
		ResolvedReference: "ghcr.io/paprika/" + application.GetName() + "@sha256:" + digest,
		Digest:            "sha256:" + digest, Phase: "Available",
		ProducingStep: "publish-bundle", CreatedAt: consoleNowUnixMs(),
	}}
}
