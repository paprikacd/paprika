package main

import (
	"context"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// defaultSignalWindowSeconds is the window a synthesized sample claims to cover
// when the caller did not ask for one. Reporting the real window matters: an
// error rate over five minutes and the same figure over a day are different
// facts, and window_seconds is how the console tells them apart.
const defaultSignalWindowSeconds = 300

// maxSyntheticCostApplications bounds an unfiltered cost page. The console asks
// for one page of applications at a time, so a cost answer must never be
// proportional to fleet size — this is what keeps --applications 10000 from
// building 10000 cost records for a single request.
const maxSyntheticCostApplications = 50

// QueryApplicationSignals fills in golden signals when an observability source
// is configured.
//
// In realistic mode it returns the real handler's answer untouched: one entry
// per requested application and per requested signal kind, every one
// NOT_CONFIGURED. That is not a fixture shortcut — no ObservabilitySource is
// bound in most installs, and the console has to render that.
func (c *consoleServer) QueryApplicationSignals(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryApplicationSignalsRequest],
) (*connect.Response[paprikav1.QueryApplicationSignalsResponse], error) {
	response, err := c.PaprikaServer.QueryApplicationSignals(ctx, req)
	if err != nil {
		return nil, err
	}
	if !c.mode.publishesSignals() {
		return response, nil
	}
	window := req.Msg.GetWindowSeconds()
	if window <= 0 {
		window = defaultSignalWindowSeconds
	}
	// The response-level state gates every board that reads a signal, so it has
	// to move with the values beneath it. Leaving it NOT_CONFIGURED beside OK
	// samples would tell the console to hide numbers it was just handed.
	response.Msg.State = paprikav1.DataState_DATA_STATE_OK
	// The real handler already built the per-application, per-kind skeleton
	// from the validated request, so rewriting it in place keeps the "one entry
	// per requested kind, even when unavailable" invariant intact rather than
	// re-deriving it and risking a different answer.
	for _, application := range response.Msg.GetApplications() {
		c.fillApplicationSignals(application, window)
	}
	return response, nil
}

func (c *consoleServer) fillApplicationSignals(
	application *paprikav1.ApplicationSignals,
	window int64,
) {
	key := application.GetApplication()
	index := fixtureApplicationIndex(key.GetName())
	state := fixtureStateFor(index)
	application.State = paprikav1.DataState_DATA_STATE_OK
	application.Cluster = &paprikav1.FleetObjectKey{
		Namespace: key.GetNamespace(), Name: state.cluster,
	}
	application.Source = &paprikav1.FleetObjectKey{
		Namespace: key.GetNamespace(), Name: "fixture-observability",
	}
	for _, signal := range application.GetSignals() {
		fillSignalValue(signal, key, window)
	}
}

// signalBand is the range one kind is synthesized within, plus the quantile it
// reports. Bands are a table rather than a switch so a new SignalKind cannot
// pick up an arbitrary neighbour's range by falling through.
type signalBand struct {
	low, high int
	scale     float64
	quantile  float64
}

var signalBands = map[paprikav1.SignalKind]signalBand{
	paprikav1.SignalKind_SIGNAL_KIND_REQUEST_RATE: {low: 12, high: 800, scale: 1},
	// Error rate is a ratio, so the band is basis points scaled back down:
	// 0 to 8% covers healthy, watch and alarming without ever exceeding 1.
	paprikav1.SignalKind_SIGNAL_KIND_ERROR_RATE: {low: 0, high: 800, scale: 0.0001},
	paprikav1.SignalKind_SIGNAL_KIND_LATENCY:    {low: 40, high: 900, scale: 1, quantile: 0.99},
	paprikav1.SignalKind_SIGNAL_KIND_SATURATION: {low: 5, high: 95, scale: 1},
}

func fillSignalValue(signal *paprikav1.SignalValue, key *paprikav1.FleetObjectKey, window int64) {
	band, known := signalBands[signal.GetKind()]
	if !known {
		// An unbanded kind keeps the real handler's NOT_CONFIGURED answer
		// rather than acquiring a number from an unrelated range.
		return
	}
	seed := consoleHash(key.GetNamespace(), key.GetName(), signal.GetKind().String())
	signal.State = paprikav1.DataState_DATA_STATE_OK
	signal.Value = float64(consoleSpread(seed, band.low, band.high)) * band.scale
	signal.Quantile = band.quantile
	signal.ObservedAtUnixMs = consoleNowUnixMs()
	signal.WindowSeconds = window
	signal.UnavailableReason = ""
}

// QueryCost fills in spend when a cost provider is configured, and otherwise
// returns the real handler's NOT_CONFIGURED answer untouched.
func (c *consoleServer) QueryCost(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryCostRequest],
) (*connect.Response[paprikav1.QueryCostResponse], error) {
	response, err := c.PaprikaServer.QueryCost(ctx, req)
	if err != nil {
		return nil, err
	}
	if !c.mode.publishesCost() {
		return response, nil
	}
	applications := c.costApplications(req.Msg)
	clusters := c.costClusters(req.Msg)
	total := 0.0
	for _, entry := range applications {
		total += entry.GetCost().GetMonthlyAmount()
	}
	for _, entry := range clusters {
		total += entry.GetCost().GetMonthlyAmount()
	}
	response.Msg.State = paprikav1.DataState_DATA_STATE_OK
	response.Msg.Applications = applications
	response.Msg.Clusters = clusters
	response.Msg.Total = &paprikav1.CostSummary{
		State:            paprikav1.DataState_DATA_STATE_OK,
		Basis:            paprikav1.CostBasis_COST_BASIS_RATE_CARD_REQUESTED,
		MonthlyAmount:    total,
		Currency:         "USD",
		ObservedAtUnixMs: consoleNowUnixMs(),
		Provider:         "fixture-rate-card",
	}
	return response, nil
}

// costApplications answers for exactly the identities the caller named, and
// falls back to a bounded synthetic page when it named none.
func (c *consoleServer) costApplications(msg *paprikav1.QueryCostRequest) []*paprikav1.ApplicationCost {
	keys := msg.GetApplications()
	if len(keys) == 0 {
		keys = c.syntheticApplicationKeys(msg.GetPageSize())
	}
	costs := make([]*paprikav1.ApplicationCost, 0, len(keys))
	for _, key := range keys {
		costs = append(costs, &paprikav1.ApplicationCost{
			Application: key,
			Cost:        applicationCostSummary(key),
		})
	}
	return costs
}

func (c *consoleServer) costClusters(msg *paprikav1.QueryCostRequest) []*paprikav1.ClusterCost {
	if len(msg.GetClusters()) == 0 {
		return clusterCostsFrom(c.clusters)
	}
	costs := make([]*paprikav1.ClusterCost, 0, len(msg.GetClusters()))
	for _, key := range msg.GetClusters() {
		cluster := findFixtureCluster(c.clusters, key.GetNamespace(), key.GetName())
		if cluster == nil {
			continue
		}
		costs = append(costs, &paprikav1.ClusterCost{Cluster: key, Cost: cluster.GetCost()})
	}
	return costs
}

func clusterCostsFrom(clusters []*paprikav1.Cluster) []*paprikav1.ClusterCost {
	costs := make([]*paprikav1.ClusterCost, 0, len(clusters))
	for _, cluster := range clusters {
		costs = append(costs, &paprikav1.ClusterCost{
			Cluster: cluster.GetIdentity(), Cost: cluster.GetCost(),
		})
	}
	return costs
}

// syntheticApplicationKeys walks the seed's own naming scheme instead of the
// fleet index, so the work is bounded by the page rather than by the fleet.
func (c *consoleServer) syntheticApplicationKeys(pageSize uint32) []*paprikav1.FleetObjectKey {
	limit := int(pageSize)
	if limit <= 0 || limit > maxSyntheticCostApplications {
		limit = maxSyntheticCostApplications
	}
	limit = min(limit, c.applications)
	keys := make([]*paprikav1.FleetObjectKey, 0, limit)
	for index := 0; index < limit; index++ {
		keys = append(keys, &paprikav1.FleetObjectKey{
			Namespace: fixtureNamespace(index), Name: fixtureApplicationName(index),
		})
	}
	return keys
}

func applicationCostSummary(key *paprikav1.FleetObjectKey) *paprikav1.CostSummary {
	seed := consoleHash(key.GetNamespace(), key.GetName(), "cost")
	return &paprikav1.CostSummary{
		State: paprikav1.DataState_DATA_STATE_OK,
		// Requested resources times a rate card is an estimate, and saying so
		// on the wire is what stops the console presenting it as billed spend.
		Basis:            paprikav1.CostBasis_COST_BASIS_RATE_CARD_REQUESTED,
		MonthlyAmount:    float64(consoleSpread(seed, 2000, 400000)) / 100,
		Currency:         "USD",
		ObservedAtUnixMs: consoleNowUnixMs(),
		Provider:         "fixture-rate-card",
	}
}
