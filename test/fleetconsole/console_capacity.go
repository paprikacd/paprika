package main

import (
	"context"
	"time"

	"connectrpc.com/connect"

	"k8s.io/apimachinery/pkg/types"

	apiserver "github.com/benebsworth/paprika/internal/api"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

const rfc3339Layout = time.RFC3339

// clusterUsageUnavailableReason is authored here rather than reused from the
// server's canonical set, and that is deliberate.
//
// The canonical DATA_CLASS_CLUSTER_CAPACITY sentence says capacity collection
// is not configured, which is false in realistic mode: allocatable and
// requested are real. What is missing is the usage source alone, and design
// section 4.4 makes that a per-meter degradation rather than a per-class one,
// so the meter still draws its requested and allocatable segments. There is no
// competing server-side sentence for this narrower condition, so there is
// nothing here that can drift out of agreement with GetDataSources.
const clusterUsageUnavailableReason = "no usage source is configured; " +
	"install metrics-server to see used CPU and memory"

const (
	millicoresPerNode         = 8000
	allocatableMillicoresNode = 7900
	bytesPerNode              = 32 * 1024 * 1024 * 1024
	allocatableBytesPerNode   = 30 * 1024 * 1024 * 1024
	millicoresPerPod          = 120
	bytesPerPod               = 512 * 1024 * 1024
	// usedFractionOfRequested is the utilisation a usage provider would report.
	// It is below 1 on purpose: a fixture that reported usage equal to requests
	// would never exercise the console's headroom rendering.
	usedCPUFractionOfRequested    = 0.62
	usedMemoryFractionOfRequested = 0.71
)

// canonicalUnavailableReasons reads the server's own sentence for every data
// class it reports as absent.
//
// The fixture must never paraphrase a degraded-mode reason. GetDataSources is
// the probe that decides whether a board renders at all, so a chip inside that
// board describing the same absence in different words reads to an operator as
// a second, different problem — the exact inconsistency console_stub.go's
// canonical constants exist to prevent. Reading them back from the real handler
// makes drift impossible rather than merely unlikely.
func canonicalUnavailableReasons(
	ctx context.Context,
	base *apiserver.PaprikaServer,
) (map[paprikav1.DataClass]string, error) {
	response, err := base.GetDataSources(ctx, connect.NewRequest(&paprikav1.GetDataSourcesRequest{}))
	if err != nil {
		return nil, err
	}
	reasons := make(map[paprikav1.DataClass]string, len(response.Msg.GetSources()))
	for _, source := range response.Msg.GetSources() {
		reasons[source.GetDataClass()] = source.GetUnavailableReason()
	}
	return reasons, nil
}

// buildClusterCapacity reports allocatable and requested as real in every mode
// that publishes data, and degrades used alone unless a usage provider is
// configured. usage_provider stays empty while used is unavailable: naming a
// provider that produced nothing would be a claim, not metadata.
func buildClusterCapacity(
	mode dataSourceMode,
	nodes, pods int,
	observed int64,
	includeCapacity bool,
) *paprikav1.ClusterCapacity {
	if !includeCapacity {
		// include_capacity=false means the caller asked not to be sent the
		// meters, not that the cluster has none. Omitting the whole message is
		// the only representation that cannot be misread as zeroed capacity.
		return nil
	}
	capacity := &paprikav1.ClusterCapacity{
		Cpu: buildResourceMeter(
			mode, paprikav1.ResourceUnit_RESOURCE_UNIT_MILLICORES, observed,
			float64(nodes*millicoresPerNode), float64(nodes*allocatableMillicoresNode),
			float64(pods*millicoresPerPod), usedCPUFractionOfRequested,
		),
		Memory: buildResourceMeter(
			mode, paprikav1.ResourceUnit_RESOURCE_UNIT_BYTES, observed,
			float64(nodes*bytesPerNode), float64(nodes*allocatableBytesPerNode),
			float64(pods*bytesPerPod), usedMemoryFractionOfRequested,
		),
	}
	if mode.publishesUsage() {
		capacity.UsageProvider = "metrics-server"
	}
	return capacity
}

func buildResourceMeter(
	mode dataSourceMode,
	unit paprikav1.ResourceUnit,
	observed int64,
	capacity, allocatable, requested, usedFraction float64,
) *paprikav1.ResourceMeter {
	meter := &paprikav1.ResourceMeter{
		Unit:             unit,
		RequestedState:   paprikav1.DataState_DATA_STATE_OK,
		Requested:        requested,
		AllocatableState: paprikav1.DataState_DATA_STATE_OK,
		Allocatable:      allocatable,
		Capacity:         capacity,
		ObservedAtUnixMs: observed,
	}
	if !mode.publishesUsage() {
		// NOT_AVAILABLE, not NOT_CONFIGURED: design section 4.2 names an absent
		// metrics-server as the canonical "source configured, capability
		// absent" case, and section 4.4 requires the meter to keep drawing its
		// requested and allocatable segments with a hatched unknown band.
		// NOT_CONFIGURED would tell the console to hide the meter outright, so
		// the fixture would never exercise the render path it exists to drive.
		//
		// Used is still zeroed rather than omitted: a client that ignores
		// used_state renders an obviously wrong 0 rather than a plausible lie.
		meter.UsedState = paprikav1.DataState_DATA_STATE_NOT_AVAILABLE
		meter.Used = 0
		meter.UnavailableReason = clusterUsageUnavailableReason
		return meter
	}
	meter.UsedState = paprikav1.DataState_DATA_STATE_OK
	meter.Used = requested * usedFraction
	return meter
}

// buildClusterCost degrades to the server's own cost sentence unless a cost
// provider is configured, so the cluster card and the cost board describe the
// same absence identically.
func (c *consoleServer) buildClusterCost(key types.NamespacedName, nodes int) *paprikav1.CostSummary {
	if !c.mode.publishesCost() {
		return c.notConfiguredCost()
	}
	// Rate-card times node allocatable, which is exactly what
	// COST_BASIS_RATE_CARD_ALLOCATABLE declares it to be. Declaring the basis
	// is what stops the console presenting an estimate as billed spend.
	const monthlyPerNode = 218.40
	return &paprikav1.CostSummary{
		State:            paprikav1.DataState_DATA_STATE_OK,
		Basis:            paprikav1.CostBasis_COST_BASIS_RATE_CARD_ALLOCATABLE,
		MonthlyAmount:    float64(nodes) * monthlyPerNode,
		Currency:         "USD",
		ObservedAtUnixMs: consoleNowUnixMs(),
		Provider:         "fixture-rate-card",
	}
}

func (c *consoleServer) notConfiguredCost() *paprikav1.CostSummary {
	return &paprikav1.CostSummary{
		State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Basis:             paprikav1.CostBasis_COST_BASIS_UNSPECIFIED,
		UnavailableReason: c.reasons[paprikav1.DataClass_DATA_CLASS_COST],
	}
}
