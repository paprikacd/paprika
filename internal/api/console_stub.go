package apiserver

import (
	"context"

	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/fleet"
)

// Shared Phase 0 scaffolding for the console redesign (design
// docs/superpowers/specs/console-redesign/01-backend-design.md §4).
//
// The console surface lands its wire contract ahead of every collector behind
// it. Each stub handler therefore answers honestly rather than plausibly:
// DATA_STATE_NOT_CONFIGURED on every state-carrying field, zero on every
// numeric beside it, and a short, safe, actionable unavailable_reason. This
// file holds the three things all four stub handlers must agree on — the reason
// strings, the authorization prologue, and target validation — so a board and
// the GetDataSources probe that gates it can never contradict each other.

// Phase 0 unavailability reasons: exactly one canonical string per DataClass.
//
// Every one follows the same grammar — what is missing, then what to do about
// it, then what doing it would reveal — and the first clause names the state
// itself ("is not configured") so the sentence and the DataState agree. Each is
// authored here as a literal, never derived from a backend error, so no reason
// can leak internal detail; that is the same sanitization rule mapFleetError
// applies on the fleet path (fleet_handler.go:186).
//
// These are shared rather than per-file on purpose. GetDataSources is the
// boot-time probe the console uses to decide which boards exist at all, so the
// sentence it reports for a class must be the same sentence the RPC for that
// class reports in its own unavailable_reason. Two wordings for one condition
// read to an operator as two different problems.
const (
	dataClassUnspecifiedReason = "no data class was specified"

	clusterInventoryUnavailableReason = "cluster inventory collection is not configured; " +
		"enable it to see node, pod and namespace counts"
	clusterCapacityUnavailableReason = "cluster capacity collection is not configured; " +
		"enable it to see CPU and memory meters"
	applicationSignalsUnavailableReason = "no observability source is configured; " +
		"add an ObservabilitySource to see application signals"
	costUnavailableReason = "no cost source is configured; " +
		"add a CostSource to see spend"
	sourceEventsUnavailableReason = "source event recording is not configured; " +
		"enable it to see source trigger history"
	rolloutHistoryUnavailableReason = "rollout history recording is not configured; " +
		"enable it to see completed rollouts"
	pipelineRunsUnavailableReason = "pipeline run recording is not configured; " +
		"enable it to see completed pipeline runs"
	commitMetadataUnavailableReason = "commit metadata collection is not configured; " +
		"enable it to see the deployed revision"
	ownershipUnavailableReason = "ownership metadata is not configured; " +
		"add ownership metadata to see owners and contacts"
	driftDetailUnavailableReason = "per-resource drift detail is not configured; " +
		"enable it to see which fields drifted"
	lifecycleUnavailableReason = "lifecycle phase collection is not configured; " +
		"enable it to see per-stage progress"
)

// authorizeFleetSnapshotScope applies the same authorization and fleet-index
// path the real handlers will use, and returns the index generation a stub
// response reports. A stub must never be more permissive, or more available,
// than the data it stands in for, so authorization happens before the empty
// answer rather than being deferred with it.
//
// Candidates come only from the cache-only Reader, so the authorizer can narrow
// visibility but never invent it, and every error goes through mapFleetError so
// no backend text reaches the caller.
func (s *PaprikaServer) authorizeFleetSnapshotScope(
	ctx context.Context,
	namespaces []string,
) (uint64, error) {
	reader, err := s.requireFleetIndex()
	if err != nil {
		return 0, err
	}
	snapshot, err := reader.LoadSnapshot()
	if err != nil {
		return 0, mapFleetError(err)
	}
	if snapshot == nil {
		return 0, mapFleetError(&fleet.ErrUnavailable{Reason: "fleet snapshot is unavailable"})
	}

	_, err = buildFleetQueryScopeFromProjects(
		ctx, s.authorizer, auth.PrincipalFromContext(ctx), snapshot.ProjectKeys(namespaces),
	)
	if err != nil {
		return 0, mapFleetError(err)
	}
	return snapshot.Generation, nil
}

// authorizeOptionalNamespaceScope authorizes a read whose namespace filter is
// optional. A nil namespace means the whole fleet the caller is authorized to
// read, which is why it cannot simply be defaulted to the empty string: "" is a
// namespace that does not exist, whereas nil is "no filter".
func (s *PaprikaServer) authorizeOptionalNamespaceScope(
	ctx context.Context,
	namespace *string,
) (uint64, error) {
	namespaces, err := optionalNamespaceScope(namespace)
	if err != nil {
		return 0, err
	}
	return s.authorizeFleetSnapshotScope(ctx, namespaces)
}

// beginObjectScopedStub runs the prologue every stub RPC addressing a single
// object shares: validate the target, then authorize its namespace against the
// immutable fleet snapshot. Factoring it out keeps each handler a single honest
// response and guarantees authorization cannot be forgotten when real data
// lands behind it.
func (s *PaprikaServer) beginObjectScopedStub(
	ctx context.Context,
	namespace, name, nameField string,
) error {
	if err := validateFleetObjectTarget(namespace, name, nameField); err != nil {
		return err
	}
	_, err := s.authorizeFleetSnapshotScope(ctx, []string{namespace})
	return err
}

// optionalNamespaceScope narrows an authorized scope to one namespace when the
// caller asked for one, and validates it while doing so, so no caller of the
// scope helpers has to remember to validate separately.
func optionalNamespaceScope(namespace *string) ([]string, error) {
	if namespace == nil {
		return nil, nil
	}
	if problems := validation.IsDNS1123Label(*namespace); len(problems) != 0 {
		return nil, fleetInvalidArgument("namespace must be a valid DNS-1123 label")
	}
	return []string{*namespace}, nil
}

// validateFleetObjectTarget checks the namespace/name pair addressing a single
// object. It names only the field at fault — nameField is the caller's own
// field name, so the message matches the request the caller sent — and never
// reports whether the object exists, so no endpoint built on it can be used to
// enumerate objects across a tenant shield. Both checks reject the empty
// string, which is what makes this the required-target validator.
func validateFleetObjectTarget(namespace, name, nameField string) error {
	if problems := validation.IsDNS1123Label(namespace); len(problems) != 0 {
		return fleetInvalidArgument("namespace must be a valid DNS-1123 label")
	}
	if problems := validation.IsDNS1123Subdomain(name); len(problems) != 0 {
		return fleetInvalidArgument("%s must be a valid DNS-1123 subdomain", nameField)
	}
	return nil
}
