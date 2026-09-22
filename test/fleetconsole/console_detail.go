package main

import (
	"context"
	"strconv"

	"connectrpc.com/connect"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// GetRevisionInfo answers with the commit behind the application's current
// revision, or behind the revision the caller named.
func (c *consoleServer) GetRevisionInfo(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRevisionInfoRequest],
) (*connect.Response[paprikav1.GetRevisionInfoResponse], error) {
	response, err := c.PaprikaServer.GetRevisionInfo(ctx, req)
	if err != nil {
		return nil, err
	}
	key := &paprikav1.FleetObjectKey{
		Namespace: req.Msg.GetNamespace(), Name: req.Msg.GetApplication(),
	}
	index := fixtureApplicationIndex(key.GetName())
	state := fixtureStateFor(index)
	// Seeding from the requested revision keeps a named revision's author and
	// message identical wherever the console shows it, including on a history
	// row that predates the current one.
	ordinal := int(consoleHash(req.Msg.GetRevision()) % pipelineRunRetentionLimit)
	response.Msg.Commit = syntheticCommit(key, ordinal, consoleNowUnixMs()-int64(ordinal)*pipelineRunSpacingMs)
	response.Msg.Repository = &paprikav1.FleetObjectKey{
		Namespace: key.GetNamespace(), Name: state.repository,
	}
	response.Msg.RepositoryUrl = "https://example.invalid/fixture/" + state.repository + ".git"
	response.Msg.RunNumber = countU64(pipelineRunRetentionLimit - ordinal)
	response.Msg.RunNumberState = paprikav1.DataState_DATA_STATE_OK
	return response, nil
}

// ownershipTiers rotates tiers so every badge the console draws appears in the
// fixture. Tier is not decorative: it drives escalation affordances.
var ownershipTiers = [...]paprikav1.OwnershipTier{
	paprikav1.OwnershipTier_OWNERSHIP_TIER_1,
	paprikav1.OwnershipTier_OWNERSHIP_TIER_2,
	paprikav1.OwnershipTier_OWNERSHIP_TIER_3,
	paprikav1.OwnershipTier_OWNERSHIP_TIER_4,
}

// GetApplicationOwnership answers with owner, on-call and drilldown links.
func (c *consoleServer) GetApplicationOwnership(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationOwnershipRequest],
) (*connect.Response[paprikav1.GetApplicationOwnershipResponse], error) {
	response, err := c.PaprikaServer.GetApplicationOwnership(ctx, req)
	if err != nil {
		return nil, err
	}
	namespace := req.Msg.GetNamespace()
	name := req.Msg.GetName()
	index := fixtureApplicationIndex(name)
	state := fixtureStateFor(index)
	seed := consoleHash(namespace, name, "ownership")
	contact := commitAuthors[int(seed)%len(commitAuthors)]
	response.Msg.Ownership = &paprikav1.Ownership{
		State:      paprikav1.DataState_DATA_STATE_OK,
		Owner:      state.project + "-team",
		OwnerLabel: "Team " + state.project,
		OnCall:     contact.name,
		Tier:       ownershipTiers[index%len(ownershipTiers)],
		// Fully resolved server-side, https only, as the wire requires.
		EscalationUrl: "https://example.invalid/oncall/" + state.project,
		Links:         ownershipLinks(namespace, name, state.project),
		// "inherited" is the honest source here: the fixture's ownership comes
		// from the AppProject, not from an annotation on the Application.
		Source: "inherited",
	}
	return response, nil
}

func ownershipLinks(namespace, name, project string) []*paprikav1.DrilldownLink {
	base := "https://example.invalid/"
	return []*paprikav1.DrilldownLink{
		{
			Kind: paprikav1.DrilldownKind_DRILLDOWN_KIND_DASHBOARD, Label: "Grafana",
			Url: base + "grafana/d/" + namespace + "/" + name,
		},
		{
			Kind: paprikav1.DrilldownKind_DRILLDOWN_KIND_LOGS, Label: "Logs",
			Url: base + "logs?app=" + name,
		},
		{
			Kind: paprikav1.DrilldownKind_DRILLDOWN_KIND_RUNBOOK, Label: "Runbook",
			Url: base + "runbooks/" + project,
		},
		{
			Kind: paprikav1.DrilldownKind_DRILLDOWN_KIND_REPOSITORY, Label: "Repository",
			Url: base + project + "/" + name + ".git",
		},
	}
}

// ListDriftDetails answers from the same seed state the projected Application
// carries, so the drift count on a fleet row and the resources on its detail
// view describe one fact rather than two.
func (c *consoleServer) ListDriftDetails(
	ctx context.Context,
	req *connect.Request[paprikav1.ListDriftDetailsRequest],
) (*connect.Response[paprikav1.ListDriftDetailsResponse], error) {
	response, err := c.PaprikaServer.ListDriftDetails(ctx, req)
	if err != nil {
		return nil, err
	}
	namespace := req.Msg.GetNamespace()
	name := req.Msg.GetApplication()
	state := fixtureStateFor(fixtureApplicationIndex(name))
	resources := driftResources(namespace, name, &state, req.Msg.GetIncludeFields())
	response.Msg.State = paprikav1.DataState_DATA_STATE_OK
	response.Msg.Resources = resources
	response.Msg.DriftedCount = countDrift(resources, paprikav1.DriftReason_DRIFT_REASON_FIELD_CHANGED)
	response.Msg.MissingCount = countDrift(resources, paprikav1.DriftReason_DRIFT_REASON_RESOURCE_MISSING)
	response.Msg.PrunedCount = countDrift(resources, paprikav1.DriftReason_DRIFT_REASON_PRUNE_PENDING)
	response.Msg.EvaluatedAtUnixMs = consoleNowUnixMs()
	return response, nil
}

func countDrift(resources []*paprikav1.ResourceDriftDetail, reason paprikav1.DriftReason) uint32 {
	count := uint32(0)
	for _, resource := range resources {
		if resource.GetReason() == reason {
			count++
		}
	}
	return count
}

// driftResources mirrors fixtureResources in seed.go: a degraded application
// has a missing Deployment, and a drifted one has an out-of-sync Service and
// ConfigMap. Anything else is genuinely clean and gets an empty list with
// state OK — which is a different thing from an unconfigured list, and the
// console must render it differently.
func driftResources(
	namespace, name string,
	state *fixtureState,
	includeFields bool,
) []*paprikav1.ResourceDriftDetail {
	if state.health == pipelinesv1alpha1.HealthDegraded {
		return []*paprikav1.ResourceDriftDetail{
			driftDetail(namespace, name, "apps", "v1", "Deployment", name,
				paprikav1.DriftReason_DRIFT_REASON_RESOURCE_MISSING, nil),
		}
	}
	if state.driftCount == 0 {
		return []*paprikav1.ResourceDriftDetail{}
	}
	return []*paprikav1.ResourceDriftDetail{
		driftDetail(namespace, name, "", "v1", "Service", name,
			paprikav1.DriftReason_DRIFT_REASON_FIELD_CHANGED,
			driftedFields(includeFields, "/spec/ports/0/targetPort", "8080", "8081")),
		driftDetail(namespace, name, "", "v1", "ConfigMap", name,
			paprikav1.DriftReason_DRIFT_REASON_FIELD_CHANGED,
			driftedFields(includeFields, "/data/LOG_LEVEL", "info", "debug")),
	}
}

func driftDetail(
	namespace, application, group, version, kind, name string,
	reason paprikav1.DriftReason,
	fields []*paprikav1.DriftedField,
) *paprikav1.ResourceDriftDetail {
	sync := paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC
	changed := countU32(len(fields))
	if reason == paprikav1.DriftReason_DRIFT_REASON_RESOURCE_MISSING {
		// A missing object has no fields to compare, so a changed-field count
		// above zero would be meaningless rather than merely unknown.
		sync = paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC
		changed = 0
	} else if changed == 0 {
		// include_fields was false: the count is still authoritative, and the
		// console must show it without the inline list.
		changed = 1
	}
	return &paprikav1.ResourceDriftDetail{
		Group: group, Version: version, Kind: kind, Name: name, Namespace: namespace,
		Sync: sync, Reason: reason, ChangedFieldCount: changed,
		Fields: fields, FieldsTruncated: false,
		DriftDetectedAtUnixMs: consoleNowUnixMs() - 3_600_000,
		DetailState:           paprikav1.DataState_DATA_STATE_OK,
		LastAppliedBy:         "kubectl-client-side-apply",
		LastAppliedAtUnixMs:   consoleNowUnixMs() - 7_200_000,
	}
}

func driftedFields(include bool, path, desired, live string) []*paprikav1.DriftedField {
	if !include {
		return nil
	}
	return []*paprikav1.DriftedField{{Path: path, Desired: desired, Live: live}}
}

// GetRolloutHold reports a hold on the applications the seed leaves blocked
// behind a manual gate. The mutations that place and lift a hold stay
// unimplemented in every mode (see the mutation note in console.go), so this is
// a hold placed by something other than the console, which is exactly the case
// an operator most needs the badge for.
func (c *consoleServer) GetRolloutHold(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRolloutHoldRequest],
) (*connect.Response[paprikav1.GetRolloutHoldResponse], error) {
	response, err := c.PaprikaServer.GetRolloutHold(ctx, req)
	if err != nil {
		return nil, err
	}
	state := fixtureStateFor(fixtureApplicationIndex(req.Msg.GetName()))
	if !state.blockedByGate {
		return response, nil
	}
	response.Msg.Hold = &paprikav1.RolloutHold{
		Held:         true,
		HeldBy:       "release-manager@example.invalid",
		HeldAtUnixMs: consoleNowUnixMs() - 5_400_000,
		// Zero means held until explicitly resumed, which is the state a
		// blocked manual gate actually leaves a rollout in.
		ExpiresAtUnixMs: 0,
		Reason:          "awaiting production change approval",
		FrozenWeight:    weightI32(consoleSpread(consoleHash(req.Msg.GetName(), "weight"), 10, 60)),
	}
	return response, nil
}

// GetApplicationLifecycle fills the fixed six-phase vector from the same seed
// variant the projected Application was built from.
func (c *consoleServer) GetApplicationLifecycle(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationLifecycleRequest],
) (*connect.Response[paprikav1.GetApplicationLifecycleResponse], error) {
	response, err := c.PaprikaServer.GetApplicationLifecycle(ctx, req)
	if err != nil {
		return nil, err
	}
	name := req.Msg.GetName()
	variant := fixtureApplicationIndex(name) % len(lifecycleVariants)
	states := lifecycleVariants[variant]
	// The real handler already emitted all six phases in enum order, so
	// rewriting in place preserves the positional contract callers index by.
	phases := response.Msg.GetLifecycle().GetPhases()
	for position, state := range states {
		if position >= len(phases) {
			break
		}
		applyLifecyclePhase(phases[position], state, req.Msg.GetNamespace(), name, position)
	}
	response.Msg.GetLifecycle().ObservedAtUnixMs = consoleNowUnixMs()
	return response, nil
}

func applyLifecyclePhase(
	phase *paprikav1.LifecyclePhaseStatus,
	state paprikav1.LifecyclePhaseState,
	namespace, name string,
	position int,
) {
	phase.State = state
	if state == paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_NOT_APPLICABLE {
		// No stage exists, so there is nothing to timestamp and nothing to
		// reference. Leaving them zero is what makes "inert" distinguishable
		// from "ran instantly".
		return
	}
	finished := consoleNowUnixMs() - int64(6-position)*600_000
	phase.StartedAtUnixMs = finished - 300_000
	if state != paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_RUNNING &&
		state != paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_BLOCKED &&
		state != paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_PENDING {
		phase.FinishedAtUnixMs = finished
		phase.DurationMs = finished - phase.GetStartedAtUnixMs()
	}
	phase.Detail = lifecycleDetails[state]
	phase.Reference = &paprikav1.FleetObjectKey{
		Namespace: namespace, Name: name + "-" + strconv.Itoa(position),
	}
	phase.ReferenceKind = lifecycleReferenceKinds[position]
}

var lifecycleReferenceKinds = [...]string{"Pipeline", "Pipeline", "Pipeline", "Release", "Rollout", "AnalysisRun"}

var lifecycleDetails = map[paprikav1.LifecyclePhaseState]string{
	paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_PENDING:   "waiting on the preceding phase",
	paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_RUNNING:   "in progress",
	paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_BLOCKED:   "blocked on a manual approval gate",
	paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED: "completed",
	paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_FAILED:    "did not complete; see the phase reference",
	paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_UNKNOWN:   "applicable, but nothing has reported yet",
}

// lifecycleVariants is one row per seed variant, six phases per row in
// LifecyclePhase order 1..6. A table rather than branching, because the vector
// is positional on the wire and an off-by-one here would misreport every
// application in that variant.
var lifecycleVariants = [...][6]paprikav1.LifecyclePhaseState{
	// Healthy and complete.
	{
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
	},
	// Degraded: the deploy failed, so verify never started.
	{
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_FAILED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_PENDING,
	},
	// Healthy but drifted: nothing has re-verified since the drift appeared.
	{
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_UNKNOWN,
	},
	// Promoting: an OCI source has no test stage at all, which is
	// NOT_APPLICABLE rather than unknown — the console renders it inert.
	{
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_NOT_APPLICABLE,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_RUNNING,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_PENDING,
	},
	// Awaiting approval.
	{
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_SUCCEEDED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_BLOCKED,
		paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_PENDING,
	},
}
