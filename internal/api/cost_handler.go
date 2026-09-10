package apiserver

import (
	"context"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// maxSignalApplications bounds one QueryApplicationSignals batch to a single
// console page, as the request contract requires.
const maxSignalApplications = 100

// maxSignalWindowSeconds bounds the golden-signal window to one day. Anything
// longer is not a near-real-time signal and is a caller error, not a query.
const maxSignalWindowSeconds = 86400

// QueryCost serves one authorized page of the cost surface.
//
// Phase 0 stub: no cost provider is bound, so the response state, and the state
// on the total, report NOT_CONFIGURED with zeroed numerics and an empty
// currency. The page is empty rather than an error — the degraded-mode contract
// forbids failing a read RPC merely because its data source is absent — and no
// CostBasis is claimed, so an estimate can never be mistaken for billed spend.
func (s *PaprikaServer) QueryCost(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryCostRequest],
) (*connect.Response[paprikav1.QueryCostResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	namespaces, err := validateCostRequest(req.Msg)
	if err != nil {
		return nil, err
	}
	generation, err := s.authorizeFleetSnapshotScope(ctx, namespaces)
	if err != nil {
		return nil, err
	}

	// The cursor is accepted and ignored on purpose: this stub never emits one,
	// so no caller can hold a cursor of ours, and the first page is always the
	// last page. next_cursor stays empty to say exactly that.
	return connect.NewResponse(&paprikav1.QueryCostResponse{
		State:           paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Applications:    []*paprikav1.ApplicationCost{},
		Clusters:        []*paprikav1.ClusterCost{},
		Total:           notConfiguredCostSummary(costUnavailableReason),
		NextCursor:      "",
		IndexGeneration: generation,
	}), nil
}

// QueryApplicationSignals serves one bounded batch of per-application golden
// signals.
//
// Phase 0 stub: no observability source is wired, so the response state and
// every SignalValue report NOT_CONFIGURED with zeroed numerics. One entry is
// still returned per requested application and per requested signal kind, so a
// client that already handles per-signal partial failure needs no special case
// for the degraded shape, and an absent signal never disappears silently.
func (s *PaprikaServer) QueryApplicationSignals(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryApplicationSignalsRequest],
) (*connect.Response[paprikav1.QueryApplicationSignalsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	kinds, err := validateApplicationSignalsRequest(req.Msg)
	if err != nil {
		return nil, err
	}
	applications := req.Msg.Applications
	generation, err := s.authorizeFleetSnapshotScope(ctx, signalRequestNamespaces(applications))
	if err != nil {
		return nil, err
	}

	response := &paprikav1.QueryApplicationSignalsResponse{
		State:           paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Applications:    make([]*paprikav1.ApplicationSignals, 0, len(applications)),
		IndexGeneration: generation,
	}
	for _, application := range applications {
		// Cluster and Source stay empty: with no provider bound, the server
		// cannot substantiate which cluster served this identity, nor which
		// source would have answered for it.
		response.Applications = append(response.Applications, &paprikav1.ApplicationSignals{
			Application: &paprikav1.FleetObjectKey{
				Namespace: application.GetNamespace(), Name: application.GetName(),
			},
			Stage:   req.Msg.Stage,
			State:   paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			Signals: notConfiguredSignalValues(kinds),
		})
	}
	return connect.NewResponse(response), nil
}

// validateApplicationSignalsRequest validates the batch and returns the signal
// kinds to answer for. An empty request means every kind the contract defines.
func validateApplicationSignalsRequest(
	msg *paprikav1.QueryApplicationSignalsRequest,
) ([]paprikav1.SignalKind, error) {
	if len(msg.Applications) > maxSignalApplications {
		return nil, fleetInvalidArgument(
			"applications must not exceed %d entries", maxSignalApplications,
		)
	}
	if _, err := fleetObjectKeysFromProto(msg.Applications, "application"); err != nil {
		return nil, err
	}
	if msg.Stage != "" {
		if err := validateFleetStrings([]string{msg.Stage}, "stage"); err != nil {
			return nil, err
		}
	}
	if msg.WindowSeconds < 0 || msg.WindowSeconds > maxSignalWindowSeconds {
		return nil, fleetInvalidArgument(
			"window_seconds must be between 0 and %d", maxSignalWindowSeconds,
		)
	}
	return signalKindsFromProto(msg.Signals)
}

// signalKindsFromProto fails closed on an unspecified kind: in a repeated field
// it identifies no bucket. Duplicates collapse, so the response holds exactly
// one entry per requested kind.
func signalKindsFromProto(values []paprikav1.SignalKind) ([]paprikav1.SignalKind, error) {
	if len(values) == 0 {
		return concreteSignalKinds(), nil
	}
	kinds := make([]paprikav1.SignalKind, 0, len(values))
	seen := make(map[paprikav1.SignalKind]struct{}, len(values))
	for _, value := range values {
		if !validSignalKind(value) {
			return nil, fleetInvalidArgument("signals has invalid value %d", value)
		}
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		seen[value] = struct{}{}
		kinds = append(kinds, value)
	}
	return kinds, nil
}

// notConfiguredSignalValues zeroes every measurement, including the observation
// time and the window: nothing was sampled, so no window was covered. Only the
// kind and its intrinsic unit are populated, because neither is a measurement.
func notConfiguredSignalValues(kinds []paprikav1.SignalKind) []*paprikav1.SignalValue {
	values := make([]*paprikav1.SignalValue, 0, len(kinds))
	for _, kind := range kinds {
		values = append(values, &paprikav1.SignalValue{
			Kind:              kind,
			State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			Value:             0,
			Unit:              unitForSignalKind(kind),
			Quantile:          0,
			ObservedAtUnixMs:  0,
			WindowSeconds:     0,
			UnavailableReason: applicationSignalsUnavailableReason,
		})
	}
	return values
}

// concreteSignalKinds is the fixed set of concrete signal kinds, in enum order.
func concreteSignalKinds() []paprikav1.SignalKind {
	return []paprikav1.SignalKind{
		paprikav1.SignalKind_SIGNAL_KIND_REQUEST_RATE,
		paprikav1.SignalKind_SIGNAL_KIND_ERROR_RATE,
		paprikav1.SignalKind_SIGNAL_KIND_LATENCY,
		paprikav1.SignalKind_SIGNAL_KIND_SATURATION,
	}
}

func validSignalKind(value paprikav1.SignalKind) bool {
	switch value {
	case paprikav1.SignalKind_SIGNAL_KIND_UNSPECIFIED:
		return false
	case paprikav1.SignalKind_SIGNAL_KIND_REQUEST_RATE,
		paprikav1.SignalKind_SIGNAL_KIND_ERROR_RATE,
		paprikav1.SignalKind_SIGNAL_KIND_LATENCY,
		paprikav1.SignalKind_SIGNAL_KIND_SATURATION:
		return true
	default:
		return false
	}
}

// unitForSignalKind reports the unit a kind is always expressed in. It is a
// property of the contract, not of any sample, so it is safe to state while the
// value itself is unavailable.
func unitForSignalKind(kind paprikav1.SignalKind) paprikav1.SignalUnit {
	switch kind {
	case paprikav1.SignalKind_SIGNAL_KIND_REQUEST_RATE:
		return paprikav1.SignalUnit_SIGNAL_UNIT_REQUESTS_PER_SECOND
	case paprikav1.SignalKind_SIGNAL_KIND_ERROR_RATE:
		return paprikav1.SignalUnit_SIGNAL_UNIT_RATIO
	case paprikav1.SignalKind_SIGNAL_KIND_LATENCY:
		return paprikav1.SignalUnit_SIGNAL_UNIT_MILLISECONDS
	case paprikav1.SignalKind_SIGNAL_KIND_SATURATION:
		return paprikav1.SignalUnit_SIGNAL_UNIT_PERCENT
	case paprikav1.SignalKind_SIGNAL_KIND_UNSPECIFIED:
		return paprikav1.SignalUnit_SIGNAL_UNIT_UNSPECIFIED
	default:
		return paprikav1.SignalUnit_SIGNAL_UNIT_UNSPECIFIED
	}
}

// signalRequestNamespaces derives the authorization scope from the identities
// the caller named. Keys are already validated as namespace plus name.
func signalRequestNamespaces(applications []*paprikav1.FleetObjectKey) []string {
	namespaces := make([]string, 0, len(applications))
	seen := make(map[string]struct{}, len(applications))
	for _, application := range applications {
		namespace := application.GetNamespace()
		if namespace == "" {
			continue
		}
		if _, duplicate := seen[namespace]; duplicate {
			continue
		}
		seen[namespace] = struct{}{}
		namespaces = append(namespaces, namespace)
	}
	return namespaces
}

// validateCostRequest validates every request dimension the real handler will
// honour, and returns the namespace scope authorization is derived from.
// Validation is complete from day one so the stub can never accept a request
// the real implementation would reject.
func validateCostRequest(msg *paprikav1.QueryCostRequest) ([]string, error) {
	if msg.PageSize > maxFleetPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	if err := validateFleetFilter(msg.Filter); err != nil {
		return nil, err
	}
	if _, err := fleetObjectKeysFromProto(msg.Applications, "application"); err != nil {
		return nil, err
	}
	if _, err := fleetObjectKeysFromProto(msg.Clusters, "cluster"); err != nil {
		return nil, err
	}
	filter, err := fleetFilterFromProto(msg.Filter)
	if err != nil {
		return nil, err
	}
	return filter.Namespaces, nil
}

// notConfiguredCostSummary is the one shape every cost figure degrades to:
// zero amount, no currency, no observation time, and no basis — an unspecified
// basis is what stops the console rendering an absent figure as either an
// estimate or billed spend.
func notConfiguredCostSummary(reason string) *paprikav1.CostSummary {
	return &paprikav1.CostSummary{
		State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Basis:             paprikav1.CostBasis_COST_BASIS_UNSPECIFIED,
		MonthlyAmount:     0,
		Currency:          "",
		ObservedAtUnixMs:  0,
		Provider:          "",
		UnavailableReason: reason,
	}
}
