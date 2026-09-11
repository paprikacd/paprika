package main

import (
	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

// fixtureDataClassProfile is what this fixture would report for one DataClass
// if it published that class at all.
//
// realistic is the field that encodes the default: true for the classes a
// control plane can genuinely derive from projected CRs and its own recorders,
// false for the three that need an external provider nobody has bound. That
// split is the whole point of --data-sources=realistic — it is the state most
// installs are actually in, so it is the state the console must be developed
// against by default.
type fixtureDataClassProfile struct {
	provider          string
	stalenessBudgetMs int64
	retentionLimit    uint32
	retentionWindowMs int64
	realistic         bool
}

const (
	// observedBudgetMs is design section 4.3's cluster budget: three missed
	// 30s reconciles. It is reused for every continuously observed class.
	observedBudgetMs = 90_000
	// costBudgetMs is design section 4.3's cost budget. Monthly figures move
	// slowly, so a day-old sample is still current.
	costBudgetMs = 24 * 60 * 60 * 1000
	dayMs        = 24 * 60 * 60 * 1000
)

// fixtureDataClassProfiles is keyed rather than switched so adding a DataClass
// to the proto cannot silently acquire a wrong default here: an unlisted class
// keeps whatever the real handler said, which is NOT_CONFIGURED.
//
// DATA_CLASS_UNSPECIFIED is deliberately absent. It names no bucket, so there
// is nothing for a fixture to publish for it.
var fixtureDataClassProfiles = map[paprikav1.DataClass]fixtureDataClassProfile{
	paprikav1.DataClass_DATA_CLASS_CLUSTER_INVENTORY: {
		provider: "fixture-cluster-projection", stalenessBudgetMs: observedBudgetMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY: {
		// OK even by default: allocatable and requested come from the Cluster
		// CR and the workloads scheduled on it. Only ResourceMeter.used needs
		// a usage provider, and that degrades per meter rather than per class
		// so the console still draws the requested and allocatable segments.
		provider: "fixture-cluster-projection", stalenessBudgetMs: observedBudgetMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_APPLICATION_SIGNALS: {
		provider: "fixture-observability", stalenessBudgetMs: observedBudgetMs,
	},
	paprikav1.DataClass_DATA_CLASS_COST: {
		provider: "fixture-rate-card", stalenessBudgetMs: costBudgetMs,
	},
	paprikav1.DataClass_DATA_CLASS_SOURCE_EVENTS: {
		// Records are immutable, so there is no staleness budget; the horizon
		// and the limit are the completeness markers instead.
		provider: "fixture-source-recorder", retentionLimit: sourceEventRetentionLimit,
		retentionWindowMs: 7 * dayMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_ROLLOUT_HISTORY: {
		provider: "fixture-rollout-recorder", retentionLimit: rolloutHistoryRetentionLimit,
		retentionWindowMs: 30 * dayMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_PIPELINE_RUNS: {
		provider: "fixture-pipeline-recorder", retentionLimit: pipelineRunRetentionLimit,
		retentionWindowMs: 30 * dayMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_COMMIT_METADATA: {
		provider: "fixture-git-provider", stalenessBudgetMs: observedBudgetMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_OWNERSHIP: {
		provider: "fixture-appproject", stalenessBudgetMs: observedBudgetMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_DRIFT_DETAIL: {
		provider: "fixture-diff-engine", stalenessBudgetMs: observedBudgetMs, realistic: true,
	},
	paprikav1.DataClass_DATA_CLASS_LIFECYCLE: {
		provider: "fixture-pipeline-projection", stalenessBudgetMs: observedBudgetMs, realistic: true,
	},
}

// applyFixtureDataSource promotes one entry to OK when the mode publishes it.
// A class the mode does not publish is left exactly as the real handler
// answered — NOT_CONFIGURED with the canonical sentence — so the degraded
// wording the console renders is the production wording, never a fixture
// paraphrase of it.
func applyFixtureDataSource(source *paprikav1.DataSourceStatus, mode dataSourceMode) {
	profile, known := fixtureDataClassProfiles[source.GetDataClass()]
	if !known || !mode.publishes(profile.realistic) {
		return
	}
	source.State = paprikav1.DataState_DATA_STATE_OK
	source.Provider = profile.provider
	source.ObservedAtUnixMs = consoleNowUnixMs()
	source.StalenessBudgetMs = profile.stalenessBudgetMs
	source.RetentionLimit = profile.retentionLimit
	source.RetentionWindowMs = profile.retentionWindowMs
	source.UnavailableReason = ""
}

// fixtureClusterSpec mirrors the two clusters seed.go creates per namespace, so
// the inventory the console lists is the inventory the fleet index projected
// rather than a second, disagreeing catalogue.
type fixtureClusterSpec struct {
	name        string
	displayName string
	phase       paprikav1.ClusterPhase
	connection  paprikav1.FleetConnectionState
	healthy     bool
}

var fixtureClusterSpecs = [...]fixtureClusterSpec{
	{
		name: "delivery-primary", displayName: "Primary delivery",
		phase:      paprikav1.ClusterPhase_CLUSTER_PHASE_HEALTHY,
		connection: paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_HEALTHY,
		healthy:    true,
	},
	{
		name: "delivery-unhealthy", displayName: "Unavailable delivery",
		phase:      paprikav1.ClusterPhase_CLUSTER_PHASE_UNHEALTHY,
		connection: paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_UNHEALTHY,
		healthy:    false,
	},
}

// buildFixtureClusters materializes the whole inventory once, at startup.
//
// The result is bounded by the seeded namespace count, never by the application
// count: at --applications 10000 this is still 24 clusters, and the per-cluster
// application totals are read from the fleet index's existing ByCluster
// grouping rather than by walking 10000 applications here.
func (c *consoleServer) buildFixtureClusters(
	snapshot *fleet.Snapshot,
	includeCapacity bool,
) []*paprikav1.Cluster {
	namespaces := min(c.applications, fixtureNamespaceCount)
	clusters := make([]*paprikav1.Cluster, 0, namespaces*len(fixtureClusterSpecs))
	for index := 0; index < namespaces; index++ {
		namespace := fixtureNamespace(index)
		for _, spec := range fixtureClusterSpecs {
			key := types.NamespacedName{Namespace: namespace, Name: spec.name}
			clusters = append(clusters, c.buildFixtureCluster(
				key, spec, clusterAppCount(snapshot, key), includeCapacity,
			))
		}
	}
	return clusters
}

func clusterAppCount(snapshot *fleet.Snapshot, key types.NamespacedName) int {
	if snapshot == nil {
		return 0
	}
	return len(snapshot.ByCluster[key])
}

func (c *consoleServer) buildFixtureCluster(
	key types.NamespacedName,
	spec fixtureClusterSpec,
	applications int,
	includeCapacity bool,
) *paprikav1.Cluster {
	nodes := 3 + applications/6
	pods := applications*4 + nodes*6
	observed := consoleNowUnixMs()
	return &paprikav1.Cluster{
		Identity:    &paprikav1.FleetObjectKey{Namespace: key.Namespace, Name: key.Name},
		DisplayName: spec.displayName,
		// Direct mode matches the seeded Cluster CR, which is why Agent below
		// reports NOT_CONFIGURED rather than inventing an agent that a
		// direct-mode cluster does not have.
		Mode:              paprikav1.ClusterMode_CLUSTER_MODE_DIRECT,
		Server:            "https://" + key.Name + ".example.invalid",
		ServiceAccount:    "paprika-delivery",
		Labels:            map[string]string{"paprika.io/team": key.Namespace, "paprika.io/tier": clusterTier(spec)},
		Phase:             spec.phase,
		Connection:        spec.connection,
		KubernetesVersion: clusterKubeletVersions(spec)[0],

		LastHealthCheckUnixMs: observed,
		CreatedAtUnixMs:       fixtureEpoch.UnixMilli(),
		ObservedGeneration:    1,
		Conditions:            []*paprikav1.Condition{clusterReadyCondition(spec)},
		ApplicationCount:      countU64(applications),
		TargetCount:           countU64(applications),
		Inventory:             buildClusterInventory(spec, nodes, pods, applications, observed),
		Capacity:              buildClusterCapacity(c.mode, nodes, pods, observed, includeCapacity),
		Cost:                  c.buildClusterCost(key, nodes),
		Agent:                 &paprikav1.ClusterAgentInfo{State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED},
		HealthCheckInterval:   "30s",
		HealthCheckTimeout:    "10s",
	}
}

func clusterTier(spec fixtureClusterSpec) string {
	if spec.healthy {
		return "production"
	}
	return "degraded"
}

// clusterKubeletVersions gives the unhealthy cluster genuine version skew. Skew
// is a condition the console draws differently from a single version, and a
// fixture that never produced it would leave that branch unrendered.
func clusterKubeletVersions(spec fixtureClusterSpec) []string {
	if spec.healthy {
		return []string{"v1.31.4"}
	}
	return []string{"v1.30.8", "v1.31.4"}
}

func clusterReadyCondition(spec fixtureClusterSpec) *paprikav1.Condition {
	condition := &paprikav1.Condition{
		Type: "Ready", Status: "True", ObservedGeneration: 1,
		LastTransitionTime: fixtureConsoleNow.UTC().Format(rfc3339Layout),
		Reason:             "ConnectionEstablished", Message: "cluster responded to the last health check",
	}
	if !spec.healthy {
		condition.Status = "False"
		condition.Reason = "ConnectionFailed"
		condition.Message = "cluster did not respond to the last health check"
	}
	return condition
}

func buildClusterInventory(
	spec fixtureClusterSpec,
	nodes, pods, applications int,
	observed int64,
) *paprikav1.ClusterInventory {
	readyNodes := nodes
	runningPods := pods
	if !spec.healthy {
		readyNodes = max(nodes-1, 0)
		runningPods = max(pods-applications, 0)
	}
	zones := []string{"ap-southeast-2a", "ap-southeast-2b", "ap-southeast-2c"}
	if !spec.healthy {
		zones = zones[:1]
	}
	return &paprikav1.ClusterInventory{
		State:            paprikav1.DataState_DATA_STATE_OK,
		NodeCount:        countU32(nodes),
		ReadyNodeCount:   countU32(readyNodes),
		PodCount:         countU32(pods),
		RunningPodCount:  countU32(runningPods),
		NamespaceCount:   countU32(4 + applications/10),
		Regions:          []string{"ap-southeast-2"},
		Zones:            zones,
		KubeletVersions:  clusterKubeletVersions(spec),
		ObservedAtUnixMs: observed,
	}
}
