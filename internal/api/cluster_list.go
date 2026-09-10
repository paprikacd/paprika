package apiserver

import (
	"context"
	"sort"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

// The cluster projection: the Cluster CRs this control plane knows about,
// rendered onto the console's Cluster message.
//
// It is a projection of two sources and nothing else. The Cluster object
// supplies identity and everything the operator declared or the cluster
// controller observed — mode, server, phase, conditions, version. The fleet
// snapshot supplies how many authorized applications point at it, which is
// also what decides whether a caller sees it at all. Nothing here is
// synthesised: a data class no collector has produced still reports
// NOT_CONFIGURED with a zero beside it, exactly as the stub did.

// clusterCapacityConcurrency bounds how many clusters a single ListClusters
// reads capacity for at once. Each read is a round trip to a different API
// server, so serialising a page of them would make one slow cluster the page's
// latency; letting all of them go at once would make one page a burst of
// connections across the whole fleet.
const clusterCapacityConcurrency = 8

// clusterReferences counts what points at one cluster from within the caller's
// authorized scope. Both counts are authorized counts: an application the
// caller cannot read is not counted, so the number on the card cannot be used
// to infer the existence of another tenant's workload.
type clusterReferences struct {
	applications uint64
	targets      uint64
}

// listAuthorizedClusters returns every cluster the caller may see, sorted by
// namespace then name so a cursor can resume at a stable position.
//
// A nil client is not an error: the API server can be built without one (the
// console stubs are), and an inventory that cannot be read is an empty
// inventory, not a failed request.
func (s *PaprikaServer) listAuthorizedClusters(
	ctx context.Context,
	snapshot *fleet.Snapshot,
	scope fleet.QueryScope,
	namespace *string,
	includeUnreferenced bool,
) ([]clustersv1alpha1.Cluster, map[fleet.ClusterKey]clusterReferences, error) {
	references := authorizedClusterReferences(snapshot, scope)
	if s.client == nil {
		return nil, references, nil
	}

	var list clustersv1alpha1.ClusterList
	options := make([]client.ListOption, 0, 1)
	if namespace != nil {
		options = append(options, client.InNamespace(*namespace))
	}
	if err := s.client.List(ctx, &list, options...); err != nil {
		return nil, nil, mapFleetError(err)
	}

	visible := make([]clustersv1alpha1.Cluster, 0, len(list.Items))
	for i := range list.Items {
		key := types.NamespacedName{Namespace: list.Items[i].Namespace, Name: list.Items[i].Name}
		if _, referenced := references[key]; !referenced && !includeUnreferenced {
			continue
		}
		visible = append(visible, list.Items[i])
	}
	sort.Slice(visible, func(i, j int) bool {
		if visible[i].Namespace != visible[j].Namespace {
			return visible[i].Namespace < visible[j].Namespace
		}
		return visible[i].Name < visible[j].Name
	})

	return visible, references, nil
}

// authorizedClusterReferences counts, per cluster, the applications and stage
// targets inside scope that deploy to it.
//
// The postings are walked rather than the application map because they are
// already keyed by cluster, and every candidate is checked against scope: the
// snapshot is shared by every caller, so its postings say what exists, never
// what this caller may see.
func authorizedClusterReferences(
	snapshot *fleet.Snapshot,
	scope fleet.QueryScope,
) map[fleet.ClusterKey]clusterReferences {
	references := make(map[fleet.ClusterKey]clusterReferences, len(snapshot.ByCluster))
	for key, ids := range snapshot.ByCluster {
		counted := clusterReferences{}
		for id := range ids {
			summary, known := snapshot.Applications[id]
			if !known {
				continue
			}
			if _, authorized := scope.Projects[summary.Project]; !authorized {
				continue
			}
			counted.applications++
			for i := range summary.Targets {
				if summary.Targets[i].Cluster == key {
					counted.targets++
				}
			}
		}
		if counted.applications > 0 {
			references[key] = counted
		}
	}

	return references
}

// clusterMessages projects one page of clusters, pairing each with the fleet
// summary and reference counts held under its own identity.
func clusterMessages(
	page []clustersv1alpha1.Cluster,
	snapshot *fleet.Snapshot,
	references map[fleet.ClusterKey]clusterReferences,
) []*paprikav1.Cluster {
	messages := make([]*paprikav1.Cluster, 0, len(page))
	for i := range page {
		key := types.NamespacedName{Namespace: page[i].Namespace, Name: page[i].Name}
		messages = append(messages, clusterMessage(&page[i], snapshot.Clusters[key], references[key]))
	}

	return messages
}

// clusterMessage projects one Cluster onto the wire.
//
// It starts from the degraded shape and fills in only what has actually been
// observed, so a field this control plane does not collect keeps the state the
// stub gave it rather than acquiring a plausible-looking zero. Capacity is left
// to the caller: it is the one class that costs a round trip per cluster.
func clusterMessage(
	cluster *clustersv1alpha1.Cluster,
	summary fleet.ClusterSummary,
	references clusterReferences,
) *paprikav1.Cluster {
	message := notConfiguredCluster(cluster.Namespace, cluster.Name)
	message.DisplayName = cluster.Spec.DisplayName
	message.Mode = clusterModeMessage(cluster.Spec.Mode)
	message.Server = cluster.Spec.Server
	message.ServiceAccount = cluster.Spec.ServiceAccount
	message.Labels = cluster.Spec.Labels
	message.Disabled = cluster.Spec.Disabled
	message.Phase = clusterPhaseMessage(cluster.Status.Phase)
	// Connection comes from the fleet index rather than being re-derived here:
	// it is the same reachability every other fleet view reports, so a cluster
	// card and the fleet map cannot disagree about whether a cluster is up.
	message.Connection = fleetConnectionToProto(summary.Connection)
	message.KubernetesVersion = cluster.Status.Version
	message.ObservedGeneration = cluster.Status.ObservedGeneration
	// Only a recorded time is reported: an unset timestamp must stay 0 rather
	// than becoming the Unix epoch, which reads as a real date.
	if !cluster.CreationTimestamp.IsZero() {
		message.CreatedAtUnixMs = cluster.CreationTimestamp.UnixMilli()
	}
	if cluster.Status.LastHealthCheckTime != nil {
		message.LastHealthCheckUnixMs = cluster.Status.LastHealthCheckTime.UnixMilli()
	}
	message.Conditions = convertConditions(cluster.Status.Conditions)
	message.ApplicationCount = references.applications
	message.TargetCount = references.targets
	if cluster.Spec.HealthCheck != nil {
		message.HealthCheckInterval = cluster.Spec.HealthCheck.Interval
		message.HealthCheckTimeout = cluster.Spec.HealthCheck.Timeout
	}

	return message
}

// clusterModeMessage maps the CRD's mode onto the wire enum. Spelled out rather
// than cast so a new mode is a compile-time concern here, not a silently
// mistranslated one.
func clusterModeMessage(mode clustersv1alpha1.ClusterMode) paprikav1.ClusterMode {
	switch mode {
	case clustersv1alpha1.ClusterModeInCluster:
		return paprikav1.ClusterMode_CLUSTER_MODE_IN_CLUSTER
	case clustersv1alpha1.ClusterModeDirect:
		return paprikav1.ClusterMode_CLUSTER_MODE_DIRECT
	case clustersv1alpha1.ClusterModeAgent:
		return paprikav1.ClusterMode_CLUSTER_MODE_AGENT
	default:
		return paprikav1.ClusterMode_CLUSTER_MODE_UNSPECIFIED
	}
}

// clusterPhaseMessage maps the CRD's phase onto the wire enum. An empty phase
// means the cluster controller has not reported one yet, which is UNSPECIFIED
// rather than any particular health.
func clusterPhaseMessage(phase clustersv1alpha1.ClusterPhase) paprikav1.ClusterPhase {
	switch phase {
	case clustersv1alpha1.ClusterPhasePending:
		return paprikav1.ClusterPhase_CLUSTER_PHASE_PENDING
	case clustersv1alpha1.ClusterPhaseHealthy:
		return paprikav1.ClusterPhase_CLUSTER_PHASE_HEALTHY
	case clustersv1alpha1.ClusterPhaseUnhealthy:
		return paprikav1.ClusterPhase_CLUSTER_PHASE_UNHEALTHY
	case clustersv1alpha1.ClusterPhaseDisabled:
		return paprikav1.ClusterPhase_CLUSTER_PHASE_DISABLED
	default:
		return paprikav1.ClusterPhase_CLUSTER_PHASE_UNSPECIFIED
	}
}

// attachClusterCapacity fills in the capacity meter for every cluster on a
// page, through the same providers and the same resolution GetCluster uses.
//
// One deadline covers the whole page rather than each cluster separately, so a
// fleet of unreachable clusters costs one capacity timeout instead of one per
// cluster. A cluster the budget did not reach reports its own non-OK state,
// which is a state the console already renders.
func (s *PaprikaServer) attachClusterCapacity(ctx context.Context, clusters []*paprikav1.Cluster) {
	readCtx, cancel := context.WithTimeout(ctx, capacityReadTimeout)
	defer cancel()

	slots := make(chan struct{}, clusterCapacityConcurrency)
	var group sync.WaitGroup
	for i := range clusters {
		cluster := clusters[i]
		slots <- struct{}{}
		group.Go(func() {
			defer func() { <-slots }()
			cluster.Capacity = s.clusterCapacity(readCtx, cluster.Identity.Namespace, cluster.Identity.Name)
		})
	}
	group.Wait()
}

// pageClusters returns the slice of clusters starting after cursor, and the
// cursor a caller resumes with.
//
// The cursor is the "<namespace>/<name>" of the last cluster served, and
// resuming means seeking to the first identity strictly after it. That survives
// a cluster being registered or removed between pages — which a positional
// cursor would not — and it addresses nothing the caller was not just shown.
func pageClusters(
	clusters []clustersv1alpha1.Cluster,
	cursor string,
	pageSize uint32,
) (page []clustersv1alpha1.Cluster, nextCursor string) {
	start := 0
	if cursor != "" {
		namespace, name, _ := strings.Cut(cursor, "/")
		start = sort.Search(len(clusters), func(i int) bool {
			return clusterSortsAfter(&clusters[i], namespace, name)
		})
	}

	end := start + int(pageSize)
	if end >= len(clusters) {
		return clusters[start:], ""
	}

	return clusters[start:end], clusterCursor(&clusters[end-1])
}

func clusterCursor(cluster *clustersv1alpha1.Cluster) string {
	return cluster.Namespace + "/" + cluster.Name
}

// clusterSortsAfter reports whether cluster comes strictly after the identity a
// cursor names, in the (namespace, name) order the page is sorted in.
//
// The comparison is on the pair, not on the joined cursor string, because the
// two orders disagree: '-' sorts before '/', so "tenant-b/a" precedes
// "tenant/a" as a string while its cluster follows in namespace order. Seeking
// with a comparison that disagrees with the sort would skip or repeat rows at
// exactly the page boundary, which is the hardest place to notice it.
func clusterSortsAfter(cluster *clustersv1alpha1.Cluster, namespace, name string) bool {
	if cluster.Namespace != namespace {
		return cluster.Namespace > namespace
	}

	return cluster.Name > name
}

// authorizeUnreferencedClusters gates include_unreferenced, which reveals
// clusters no application the caller can read deploys to.
//
// That is an inventory of the install rather than a view of the caller's own
// workloads, so it is an admin read. With no authorizer configured there is no
// tenancy boundary to cross and the flag is simply honoured.
func (s *PaprikaServer) authorizeUnreferencedClusters(
	ctx context.Context,
	namespace *string,
	requested bool,
) error {
	if !requested || s.authorizer == nil {
		return nil
	}
	principal := auth.PrincipalFromContext(ctx)
	if principal == nil {
		return mapFleetError(auth.ErrUnauthorized)
	}
	scoped := ""
	if namespace != nil {
		scoped = *namespace
	}
	err := s.authorizer.Authorize(
		ctx, principal, auth.ActionAdmin, auth.ResourceApplications, scoped, "",
	)
	if err != nil {
		return mapFleetError(err)
	}

	return nil
}
