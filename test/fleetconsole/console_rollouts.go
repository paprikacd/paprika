package main

import (
	"context"
	"strconv"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// rolloutOutcomeRotation mixes real failure into the history. Median and p90
// duration, and the succeeded/aborted/failed split, are the numbers the console
// draws, so a feed that only ever succeeded would leave every one of them
// constant and every failure affordance unrendered.
var rolloutOutcomeRotation = [...]paprikav1.RolloutOutcome{
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_FAILED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_ABORTED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_ROLLED_BACK,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED,
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUPERSEDED,
}

// rolloutOutcomeShare is the fraction of the rotation each outcome occupies,
// used to derive the aggregate without walking the retained records.
var rolloutOutcomeShare = map[paprikav1.RolloutOutcome]uint64{}

func init() {
	for _, outcome := range rolloutOutcomeRotation {
		rolloutOutcomeShare[outcome]++
	}
}

// ListRolloutHistory serves completed rollout records and their aggregate.
func (c *consoleServer) ListRolloutHistory(
	ctx context.Context,
	req *connect.Request[paprikav1.ListRolloutHistoryRequest],
) (*connect.Response[paprikav1.ListRolloutHistoryResponse], error) {
	response, err := c.PaprikaServer.ListRolloutHistory(ctx, req)
	if err != nil {
		return nil, err
	}
	start, end, next := rolloutHistoryFeed.window(
		req.Msg.GetPageSize(), req.Msg.GetCursor(), req.Msg.GetSinceUnixMs(),
	)
	entries := make([]*paprikav1.RolloutHistoryEntry, 0, end-start)
	for ordinal := start; ordinal < end; ordinal++ {
		if entry := c.buildRolloutHistoryEntry(ordinal, req.Msg); entry != nil {
			entries = append(entries, entry)
		}
	}
	response.Msg.State = paprikav1.DataState_DATA_STATE_OK
	response.Msg.Entries = entries
	response.Msg.NextCursor = next
	response.Msg.Stats = rolloutHistoryStats()
	response.Msg.RetentionHorizonUnixMs = rolloutHistoryFeed.horizon()
	response.Msg.RetentionLimit = rolloutHistoryRetentionLimit
	return response, nil
}

func (c *consoleServer) buildRolloutHistoryEntry(
	ordinal int,
	msg *paprikav1.ListRolloutHistoryRequest,
) *paprikav1.RolloutHistoryEntry {
	application := c.rolloutHistoryApplication(ordinal, msg)
	if application == nil {
		return nil
	}
	index := fixtureApplicationIndex(application.GetName())
	state := fixtureStateFor(index)
	outcome := rolloutOutcomeRotation[ordinal%len(rolloutOutcomeRotation)]
	finishedAt := rolloutHistoryFeed.timestamp(ordinal)
	duration := rolloutDurationMs(application, ordinal)
	stepsTotal, stepsCompleted := rolloutSteps(outcome, application, ordinal)
	stage := rolloutHistoryStage(msg.GetStages())
	revision := syntheticCommit(application, ordinal, finishedAt-duration)
	return &paprikav1.RolloutHistoryEntry{
		Identity: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(),
			Name:      application.GetName() + "-rollout-" + strconv.Itoa(ordinal),
		},
		Application: application,
		Rollout: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: application.GetName() + "-rollout-v1",
		},
		Release: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: application.GetName() + "-release-v1",
		},
		Stage: stage,
		Cluster: &paprikav1.FleetObjectKey{
			Namespace: application.GetNamespace(), Name: state.cluster,
		},
		Strategy:         "Rolling",
		Outcome:          outcome,
		StartedAtUnixMs:  finishedAt - duration,
		FinishedAtUnixMs: finishedAt,
		DurationMs:       duration,
		StepsCompleted:   stepsCompleted,
		StepsTotal:       stepsTotal,
		FinalWeight:      rolloutFinalWeight(outcome),
		Revision:         revision.GetRevision(),
		Commit:           revision,
		Reason:           rolloutReasons[outcome],
		Message:          "rollout record written by the fleet console fixture",
		TriggeredBy:      "paprika-rollout-controller",
	}
}

// rolloutReasons keeps one short, safe sentence per outcome. Absent entries
// leave the reason empty, which is the honest answer for an outcome that needs
// no explanation.
var rolloutReasons = map[paprikav1.RolloutOutcome]string{
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED:   "AllStepsCompleted",
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_ABORTED:     "AbortedByOperator",
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_FAILED:      "AnalysisRunFailed",
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_ROLLED_BACK: "RolledBackToStable",
	paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUPERSEDED:  "SupersededByNewerRelease",
}

func (c *consoleServer) rolloutHistoryApplication(
	ordinal int,
	msg *paprikav1.ListRolloutHistoryRequest,
) *paprikav1.FleetObjectKey {
	if filters := msg.GetApplications(); len(filters) != 0 {
		return filters[ordinal%len(filters)]
	}
	return c.applicationKeyForOrdinal(ordinal, msg.Namespace)
}

func rolloutHistoryStage(stages []string) string {
	if len(stages) != 0 {
		return stages[0]
	}
	return "production"
}

func rolloutDurationMs(application *paprikav1.FleetObjectKey, ordinal int) int64 {
	seed := consoleHash(application.GetName(), strconv.Itoa(ordinal), "duration")
	return int64(consoleSpread(seed, 45, 900)) * 1000
}

// rolloutSteps reports fewer completed steps than total for every outcome that
// did not finish, so steps_completed and steps_total cannot both be read as a
// success signal.
func rolloutSteps(
	outcome paprikav1.RolloutOutcome,
	application *paprikav1.FleetObjectKey,
	ordinal int,
) (total, completed uint32) {
	total = countU32(consoleSpread(consoleHash(application.GetName(), "steps"), 3, 8))
	if outcome == paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED {
		return total, total
	}
	return total, countU32(consoleSpread(consoleHash(strconv.Itoa(ordinal), "step-progress"), 1, int(total)))
}

func rolloutFinalWeight(outcome paprikav1.RolloutOutcome) int32 {
	if outcome == paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED {
		return 100
	}
	return 0
}

// rolloutHistoryStats derives the aggregate from the rotation rather than from
// the page, and states the sample it covers. sample_size and
// window_start_unix_ms are mandatory (design section 4.5, rule 3): without them
// a 200-record window reads as a fleet-lifetime total.
func rolloutHistoryStats() *paprikav1.RolloutHistoryStats {
	const retained = rolloutHistoryRetentionLimit
	share := func(outcome paprikav1.RolloutOutcome) uint64 {
		return retained * rolloutOutcomeShare[outcome] / uint64(len(rolloutOutcomeRotation))
	}
	return &paprikav1.RolloutHistoryStats{
		State:             paprikav1.DataState_DATA_STATE_OK,
		Total:             retained,
		Succeeded:         share(paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_SUCCEEDED),
		Aborted:           share(paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_ABORTED),
		Failed:            share(paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_FAILED),
		RolledBack:        share(paprikav1.RolloutOutcome_ROLLOUT_OUTCOME_ROLLED_BACK),
		MedianDurationMs:  472 * 1000,
		P90DurationMs:     811 * 1000,
		SampleSize:        retained,
		WindowStartUnixMs: rolloutHistoryFeed.horizon(),
	}
}
