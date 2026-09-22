package main

import (
	"context"
	"time"

	"connectrpc.com/connect"

	apiserver "github.com/benebsworth/paprika/internal/api"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

// The console-redesign RPCs (design
// docs/superpowers/specs/console-redesign/01-backend-design.md section 2) are
// stub-implemented on the real server: every data class reports
// DATA_STATE_NOT_CONFIGURED. That is the honest production answer today, but a
// UI fixture that could only ever produce it would leave every populated board
// undevelopable and untestable.
//
// consoleServer therefore synthesizes the classes a control plane can genuinely
// derive from projected CRs, and leaves the rest degraded. It embeds the real
// *apiserver.PaprikaServer, so:
//
//   - every RPC it does not override behaves exactly as production does, and
//   - every RPC it does override delegates to the real handler first, then
//     replaces the payload.
//
// Delegating first is what stops the fixture drifting from the contract: the
// request bounds, the DNS-1123 target validation, the authorization prologue
// and index_generation all come from the handler under test, so the fixture can
// never accept a request production would reject, nor answer one production
// would refuse.
// Mutations are deliberately not overridden. HoldRollout, ResumeRollout,
// IgnoreDriftedField, ApplyResourcePatch and SyncResources keep the real
// server's CodeUnimplemented refusal in every mode, including
// --data-sources=all. A fixture that accepted them would let an e2e test pass
// against an affordance production refuses, and the console gates all five on
// FleetCapability values this control plane does not advertise, so the button
// should not be reachable in the first place. The flag selects which data
// classes are readable; it does not grant write capabilities.
type consoleServer struct {
	*apiserver.PaprikaServer

	mode dataSourceMode
	// clusters and clustersWithoutCapacity are built once and shared read-only
	// across requests. Both are bounded by the seeded namespace count (at most
	// 2 x 12 = 24 entries), never by the application count, which is what keeps
	// --applications 10000 from allocating per-application cluster state.
	clusters                []*paprikav1.Cluster
	clustersWithoutCapacity []*paprikav1.Cluster
	applications            int
	// reasons is the server's own sentence per absent DataClass, read back at
	// startup so no synthesized field can paraphrase a degraded-mode message.
	reasons map[paprikav1.DataClass]string
}

// fixtureConsoleNow anchors every synthesized timestamp to a fixed instant so
// two runs of the fixture agree field for field, which is what lets a Playwright
// assertion name a value instead of a range. It sits two weeks after
// fixtureEpoch: the seeded stage transitions run to epoch+N minutes, so even at
// --applications 10000 (about 7 days) no synthesized record can claim to
// predate the application it describes.
var fixtureConsoleNow = fixtureEpoch.Add(14 * 24 * time.Hour)

func consoleNowUnixMs() int64 {
	return fixtureConsoleNow.UnixMilli()
}

// newConsoleServer wraps base for the modes that publish data. dataSourcesNone
// must not be wrapped at all — see newFixtureHandler — because "none" means
// "behave exactly like the unconfigured control plane", and the most faithful
// way to do that is to run the real stubs unmodified rather than to reimplement
// their answers here and let the two copies diverge.
func newConsoleServer(
	ctx context.Context,
	base *apiserver.PaprikaServer,
	snapshot *fleet.Snapshot,
	mode dataSourceMode,
	applications int,
) (*consoleServer, error) {
	reasons, err := canonicalUnavailableReasons(ctx, base)
	if err != nil {
		return nil, err
	}
	server := &consoleServer{
		PaprikaServer: base, mode: mode, applications: applications, reasons: reasons,
	}
	// Both projections are materialized once. The alternative — cloning the
	// page on every request — would make the cheapest console call the most
	// allocating one, and the set is small, immutable and deterministic.
	server.clusters = server.buildFixtureClusters(snapshot, true)
	server.clustersWithoutCapacity = server.buildFixtureClusters(snapshot, false)
	return server, nil
}

// GetDataSources reports which classes this fixture publishes. The console
// calls it once at boot to decide which boards exist at all, so it is the one
// RPC the --data-sources flag has to be visible through.
func (c *consoleServer) GetDataSources(
	ctx context.Context,
	req *connect.Request[paprikav1.GetDataSourcesRequest],
) (*connect.Response[paprikav1.GetDataSourcesResponse], error) {
	response, err := c.PaprikaServer.GetDataSources(ctx, req)
	if err != nil {
		return nil, err
	}
	// The real handler guarantees one entry per DataClass in enum order; only
	// the status of each entry is fixture-specific, so the vector is rewritten
	// in place and its length stays an invariant the console can rely on.
	for _, source := range response.Msg.GetSources() {
		applyFixtureDataSource(source, c.mode)
	}
	return response, nil
}

// ListClusters serves the synthesized cluster inventory.
func (c *consoleServer) ListClusters(
	ctx context.Context,
	req *connect.Request[paprikav1.ListClustersRequest],
) (*connect.Response[paprikav1.ListClustersResponse], error) {
	response, err := c.PaprikaServer.ListClusters(ctx, req)
	if err != nil {
		return nil, err
	}
	clusters := c.clusters
	if !req.Msg.GetIncludeCapacity() {
		clusters = c.clustersWithoutCapacity
	}
	clusters = filterClustersByNamespace(clusters, req.Msg.Namespace)
	page, next := pageFixtureClusters(clusters, req.Msg.GetPageSize(), req.Msg.GetCursor())
	response.Msg.Clusters = page
	response.Msg.Total = countU64(len(clusters))
	response.Msg.NextCursor = next
	return response, nil
}

// GetCluster serves one synthesized cluster, or NotFound for a name this
// fixture never seeded. Answering NotFound rather than an empty shell is the
// behaviour the real projection will have, so the console's error path is
// exercised by the fixture rather than discovered in production.
func (c *consoleServer) GetCluster(
	ctx context.Context,
	req *connect.Request[paprikav1.GetClusterRequest],
) (*connect.Response[paprikav1.GetClusterResponse], error) {
	response, err := c.PaprikaServer.GetCluster(ctx, req)
	if err != nil {
		return nil, err
	}
	cluster := findFixtureCluster(c.clusters, req.Msg.GetNamespace(), req.Msg.GetName())
	if cluster == nil {
		return nil, connect.NewError(connect.CodeNotFound, errClusterNotFound)
	}
	response.Msg.Cluster = cluster
	return response, nil
}

func filterClustersByNamespace(clusters []*paprikav1.Cluster, namespace *string) []*paprikav1.Cluster {
	if namespace == nil {
		return clusters
	}
	filtered := make([]*paprikav1.Cluster, 0, len(clusters))
	for _, cluster := range clusters {
		if cluster.GetIdentity().GetNamespace() == *namespace {
			filtered = append(filtered, cluster)
		}
	}
	return filtered
}

func findFixtureCluster(clusters []*paprikav1.Cluster, namespace, name string) *paprikav1.Cluster {
	for _, cluster := range clusters {
		if cluster.GetIdentity().GetNamespace() == namespace && cluster.GetIdentity().GetName() == name {
			return cluster
		}
	}
	return nil
}

// pageFixtureClusters pages the immutable cluster slice with an offset cursor.
// The cursor is the fixture's own opaque token, minted and consumed here, so a
// caller can only ever hand back one this server emitted.
func pageFixtureClusters(
	clusters []*paprikav1.Cluster,
	pageSize uint32,
	cursor string,
) (page []*paprikav1.Cluster, nextCursor string) {
	offset := decodeFixtureCursor(cursor)
	if offset >= len(clusters) {
		return []*paprikav1.Cluster{}, ""
	}
	limit := int(pageSize)
	if limit <= 0 || limit > len(clusters)-offset {
		limit = len(clusters) - offset
	}
	end := offset + limit
	if end >= len(clusters) {
		return clusters[offset:], ""
	}
	return clusters[offset:end], encodeFixtureCursor(end)
}
