package fleet

import (
	"errors"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/types"
)

// GroupDimension is a provider-neutral fleet aggregation axis.
type GroupDimension uint8

const (
	GroupDimensionUnspecified GroupDimension = 0
	GroupDimensionProject     GroupDimension = 1
	GroupDimensionCluster     GroupDimension = 2
	GroupDimensionStage       GroupDimension = 3
	GroupDimensionHealth      GroupDimension = 4
	GroupDimensionNamespace   GroupDimension = 5
)

// SizeMetric selects the effective visual weight of a map or matrix result.
type SizeMetric uint8

const (
	SizeMetricUnspecified   SizeMetric = 0
	SizeMetricResourceCount SizeMetric = 1
	SizeMetricRequestRate   SizeMetric = 2
)

// HealthBucket counts contributions at one deterministic health level.
type HealthBucket struct {
	Health Health
	Count  uint64
}

// TargetWeightKey is the exact, provider-neutral lookup identity for one
// application's real deployment target. It deliberately contains no source
// endpoint, query expression, or Kubernetes object.
type TargetWeightKey struct {
	Project     ProjectKey
	Application types.NamespacedName
	Stage       string
	Cluster     ClusterKey
}

// WeightReader is the optional future seam for a bounded in-memory request
// rate cache. Implementations must perform no Kubernetes or provider reads.
type WeightReader interface {
	RequestRate(TargetWeightKey) (float64, bool)
}

// FleetMapQuery is the complete provider-neutral map query.
type FleetMapQuery struct {
	Filter     ApplicationFilter
	Search     string
	Group      GroupDimension
	SizeMetric SizeMetric
}

// FleetMapNodeKind distinguishes aggregate roots from application leaves.
type FleetMapNodeKind uint8

const (
	FleetMapNodeKindUnspecified FleetMapNodeKind = 0
	FleetMapNodeKindGroup       FleetMapNodeKind = 1
	FleetMapNodeKindApplication FleetMapNodeKind = 2
)

// FleetMapNode is an application-centric treemap node. An Application appears
// once, grouped by its current actual target for Stage or Cluster. The Matrix
// query is the target-expanding view.
type FleetMapNode struct {
	StableID             string
	Kind                 FleetMapNodeKind
	Label                string
	Application          types.NamespacedName
	GroupObject          types.NamespacedName
	GroupValue           string
	ApplicationCount     uint64
	TargetCount          uint64
	Health               []HealthBucket
	ResourceWeight       uint64
	RequestRateWeight    float64
	EffectiveWeight      float64
	UsedResourceFallback bool
	Children             []FleetMapNode
	ApplicationMetadata  *FleetMapApplicationMetadata
}

// FleetMapApplicationMetadata is the compact projected record attached only
// to application leaves. It deliberately contains no capabilities or raw
// provider/Kubernetes data.
type FleetMapApplicationMetadata struct {
	Project              ProjectKey
	CurrentCluster       ClusterKey
	CurrentStage         string
	Sync                 SyncState
	Release              ReleaseState
	Rollout              RolloutState
	DriftedResources     uint64
	MissingResources     uint64
	ManagedResources     uint64
	LastTransitionUnixMS int64
	IssueSummary         string
}

// FleetMap is one authorized result over one immutable snapshot generation.
type FleetMap struct {
	Roots      []FleetMapNode
	Total      uint64
	Generation uint64
	Facets     []FacetBucket
}

type mapGroupKey struct {
	dimension GroupDimension
	object    types.NamespacedName
	value     string
	label     string
	canonical string
	order     uint8
}

// QueryMap authorizes, searches, and filters before performing any aggregate.
// ResourceCount is the default group size. RequestRate falls back atomically
// per application leaf when any selected target weight is missing or invalid.
//
//nolint:gocritic // Fleet queries are immutable value objects across the package API.
func (s *Snapshot) QueryMap(scope QueryScope, query FleetMapQuery, weights WeightReader) (FleetMap, error) {
	group, err := normalizeGroupDimension(query.Group)
	if err != nil {
		return FleetMap{}, err
	}
	sizeMetric, err := normalizeSizeMetric(query.SizeMetric)
	if err != nil {
		return FleetMap{}, err
	}
	filter := query.Filter.Normalized()
	err = validateApplicationFilter(&filter)
	if err != nil {
		return FleetMap{}, err
	}

	filtered, err := s.FilterApplications(scope, filter, query.Search)
	if err != nil {
		return FleetMap{}, err
	}
	facets, err := s.Facets(scope, filter, query.Search)
	if err != nil {
		return FleetMap{}, err
	}
	selector := newTargetFilterSelector(&filter)

	grouped := make(map[mapGroupKey][]FleetMapNode)
	labels := make(map[mapGroupKey]string)
	for _, id := range sortedIDs(filtered.IDs) {
		application := s.Applications[id]
		targets := uniqueStageTargets(application.Targets)
		current := currentStageTarget(&application, targets)
		key := s.mapKey(group, &application, current)
		label := key.label
		key.label = ""
		labels[key] = preferredMapGroupLabel(labels[key], label)
		selected := selectedMapTargets(targets, current, selector)
		grouped[key] = append(grouped[key], applicationMapLeaf(&application, selected, sizeMetric, weights))
	}

	keys := make([]mapGroupKey, 0, len(grouped))
	for key := range grouped {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return mapGroupKeyLess(&keys[i], &keys[j]) })

	result := FleetMap{
		Roots:      make([]FleetMapNode, 0, len(keys)),
		Total:      uint64(len(filtered.IDs)),
		Generation: s.Generation,
		Facets:     facets,
	}
	for _, key := range keys {
		children := grouped[key]
		sort.Slice(children, func(i, j int) bool {
			return compareObjectKeys(children[i].Application, children[j].Application) < 0
		})
		result.Roots = append(result.Roots, aggregateMapGroup(&key, labels[key], children))
	}
	return result, nil
}

func normalizeGroupDimension(dimension GroupDimension) (GroupDimension, error) {
	if dimension == GroupDimensionUnspecified {
		return GroupDimensionProject, nil
	}
	if dimension < GroupDimensionProject || dimension > GroupDimensionNamespace {
		return GroupDimensionUnspecified, errors.New("invalid fleet group dimension")
	}
	return dimension, nil
}

func normalizeSizeMetric(metric SizeMetric) (SizeMetric, error) {
	if metric == SizeMetricUnspecified {
		return SizeMetricResourceCount, nil
	}
	if metric != SizeMetricResourceCount && metric != SizeMetricRequestRate {
		return SizeMetricUnspecified, errors.New("invalid fleet size metric")
	}
	return metric, nil
}

func (s *Snapshot) mapKey(
	dimension GroupDimension,
	application *ApplicationSummary,
	current *StageTargetSummary,
) mapGroupKey {
	switch dimension {
	case GroupDimensionProject:
		return objectMapGroupKey(dimension, application.Project, application.Project.Name)
	case GroupDimensionCluster:
		return s.mapClusterKey(current)
	case GroupDimensionStage:
		return mapStageKey(current)
	case GroupDimensionHealth:
		health := projectedApplicationHealth(application)
		value := healthValue(health)
		return scalarMapGroupKey(dimension, value, value, value, uint8(health))
	case GroupDimensionNamespace:
		return mapNamespaceKey(application.Identity.Namespace)
	case GroupDimensionUnspecified:
		// normalizeGroupDimension prevents this case.
		return mapGroupKey{}
	default:
		return mapGroupKey{}
	}
}

func mapNamespaceKey(namespace string) mapGroupKey {
	if namespace == "" {
		return scalarMapGroupKey(
			GroupDimensionNamespace, "unassigned", "unassigned", "Unassigned", 0,
		)
	}
	return scalarMapGroupKey(
		GroupDimensionNamespace,
		"value:"+canonicalComponent(namespace), namespace, namespace, 0,
	)
}

func (s *Snapshot) mapClusterKey(current *StageTargetSummary) mapGroupKey {
	if current == nil {
		return scalarMapGroupKey(GroupDimensionCluster, "unassigned", "unassigned", "Unassigned", 0)
	}
	if current.Cluster != (ClusterKey{}) {
		return objectMapGroupKey(GroupDimensionCluster, current.Cluster, s.clusterLabel(current.Cluster))
	}

	canonical, label := "in-cluster", "In-cluster"
	if current.UnmanagedInlineCluster {
		canonical, label = "unmanaged-inline", "Unmanaged inline"
	}
	return scalarMapGroupKey(GroupDimensionCluster, canonical, canonical, label, 0)
}

func mapStageKey(current *StageTargetSummary) mapGroupKey {
	if current == nil || current.Stage == "" {
		return scalarMapGroupKey(
			GroupDimensionStage, "sentinel:unspecified", "unspecified", "Unspecified", 0,
		)
	}
	return scalarMapGroupKey(
		GroupDimensionStage, "value:"+canonicalComponent(current.Stage), current.Stage, current.Stage, 0,
	)
}

func objectMapGroupKey(dimension GroupDimension, object types.NamespacedName, label string) mapGroupKey {
	if object == (types.NamespacedName{}) {
		return scalarMapGroupKey(dimension, "unassigned", "unassigned", "Unassigned", 0)
	}
	if label == "" {
		label = object.Name
	}
	return mapGroupKey{
		dimension: dimension,
		object:    object,
		label:     label,
		canonical: canonicalObjectIdentity(object),
		order:     0,
	}
}

func scalarMapGroupKey(dimension GroupDimension, canonical, value, label string, order uint8) mapGroupKey {
	return mapGroupKey{dimension: dimension, value: value, label: label, canonical: canonical, order: order}
}

func mapGroupKeyLess(left, right *mapGroupKey) bool {
	if left.dimension == GroupDimensionHealth && left.order != right.order {
		return left.order < right.order
	}
	return left.canonical < right.canonical
}

func preferredMapGroupLabel(current, candidate string) string {
	if current == "" || (candidate != "" && candidate < current) {
		return candidate
	}
	return current
}

func applicationMapLeaf(
	application *ApplicationSummary,
	targets []StageTargetSummary,
	sizeMetric SizeMetric,
	weights WeightReader,
) FleetMapNode {
	leaf := FleetMapNode{
		StableID:         "a:" + canonicalObjectIdentity(application.Identity),
		Kind:             FleetMapNodeKindApplication,
		Label:            application.Identity.Name,
		Application:      application.Identity,
		ApplicationCount: 1,
		TargetCount:      uint64(len(targets)),
		Health:           []HealthBucket{{Health: projectedApplicationHealth(application), Count: 1}},
		ResourceWeight:   uint64(application.ResourceCount),
		ApplicationMetadata: &FleetMapApplicationMetadata{
			Project: application.Project, CurrentCluster: application.CurrentCluster,
			CurrentStage: application.CurrentStage, Sync: application.Sync,
			Release: application.ReleaseState, Rollout: application.RolloutState,
			DriftedResources:     uint64(application.DriftCount),
			MissingResources:     uint64(application.MissingResourceCount),
			ManagedResources:     uint64(application.ResourceCount),
			LastTransitionUnixMS: application.LastTransitionUnixMS,
		},
	}
	if sizeMetric == SizeMetricResourceCount {
		leaf.EffectiveWeight = float64(leaf.ResourceWeight)
		return leaf
	}

	leaf.UsedResourceFallback = len(targets) == 0 || weights == nil
	requestRateOverflow := false
	if weights != nil {
		for i := range targets {
			value, ok := weights.RequestRate(targetWeightKey(application, &targets[i]))
			if !ok {
				leaf.UsedResourceFallback = true
				continue
			}
			updated, added := checkedAddWeight(leaf.RequestRateWeight, value)
			if !added {
				leaf.UsedResourceFallback = true
				requestRateOverflow = requestRateOverflow || validWeightOperand(value)
				continue
			}
			leaf.RequestRateWeight = updated
		}
	}
	if requestRateOverflow {
		leaf.RequestRateWeight = 0
	}
	if leaf.UsedResourceFallback {
		leaf.EffectiveWeight = float64(leaf.ResourceWeight)
	} else {
		leaf.EffectiveWeight = leaf.RequestRateWeight
	}
	return leaf
}

func aggregateMapGroup(key *mapGroupKey, label string, children []FleetMapNode) FleetMapNode {
	node := FleetMapNode{
		StableID:    mapGroupStableID(key),
		Kind:        FleetMapNodeKindGroup,
		Label:       label,
		GroupObject: key.object,
		GroupValue:  key.value,
		Children:    children,
	}
	health := make(map[Health]uint64)
	weightOverflow := false
	for i := range children {
		child := &children[i]
		node.ApplicationCount += child.ApplicationCount
		node.TargetCount += child.TargetCount
		node.ResourceWeight += child.ResourceWeight
		if !weightOverflow {
			requestRate, requestRateOK := checkedAddWeight(node.RequestRateWeight, child.RequestRateWeight)
			effective, effectiveOK := checkedAddWeight(node.EffectiveWeight, child.EffectiveWeight)
			if requestRateOK && effectiveOK {
				node.RequestRateWeight = requestRate
				node.EffectiveWeight = effective
			} else {
				weightOverflow = true
			}
		}
		node.UsedResourceFallback = node.UsedResourceFallback || child.UsedResourceFallback
		for _, bucket := range child.Health {
			health[bucket.Health] += bucket.Count
		}
	}
	if weightOverflow {
		node.RequestRateWeight = 0
		node.EffectiveWeight = float64(node.ResourceWeight)
		node.UsedResourceFallback = true
	}
	node.Health = orderedHealthBuckets(health)
	return node
}

func mapGroupStableID(key *mapGroupKey) string {
	return "g:" + groupDimensionValue(key.dimension) + ":" + key.canonical
}

func selectedMapTargets(
	targets []StageTargetSummary,
	current *StageTargetSummary,
	selector targetFilterSelector,
) []StageTargetSummary {
	if len(selector.stages) == 0 && len(selector.clusters) == 0 {
		if current == nil {
			return []StageTargetSummary{}
		}
		return []StageTargetSummary{*current}
	}

	selected := make([]StageTargetSummary, 0, len(targets))
	for i := range targets {
		if selector.matches(&targets[i]) {
			selected = append(selected, targets[i])
		}
	}
	return selected
}

type targetFilterSelector struct {
	stages   map[string]struct{}
	clusters map[ClusterKey]struct{}
}

func newTargetFilterSelector(filter *ApplicationFilter) targetFilterSelector {
	selector := targetFilterSelector{
		stages:   make(map[string]struct{}, len(filter.Stages)),
		clusters: make(map[ClusterKey]struct{}, len(filter.Clusters)),
	}
	for _, stage := range filter.Stages {
		selector.stages[stage] = struct{}{}
	}
	for _, cluster := range filter.Clusters {
		selector.clusters[cluster] = struct{}{}
	}
	return selector
}

func (s targetFilterSelector) matches(target *StageTargetSummary) bool {
	if len(s.stages) > 0 {
		if _, ok := s.stages[target.Stage]; !ok {
			return false
		}
	}
	if len(s.clusters) == 0 {
		return true
	}
	_, ok := s.clusters[target.Cluster]
	return ok
}

func checkedAddWeight(left, right float64) (float64, bool) {
	if !validWeightOperand(left) || !validWeightOperand(right) {
		return 0, false
	}
	if right > math.MaxFloat64-left {
		return 0, false
	}
	result := left + right
	if !validWeightOperand(result) {
		return 0, false
	}
	return result, true
}

func validWeightOperand(value float64) bool {
	if value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return false
	}
	return true
}

func currentStageTarget(application *ApplicationSummary, targets []StageTargetSummary) *StageTargetSummary {
	if application.CurrentStage == "" {
		return nil
	}
	for i := range targets {
		if targets[i].Stage == application.CurrentStage && targets[i].Cluster == application.CurrentCluster {
			return &targets[i]
		}
	}
	return nil
}

// uniqueStageTargets returns deterministic real target records. Stable IDs
// are authoritative dedupe keys; legacy targets without one dedupe by their
// complete stage/cluster/ring identity.
func uniqueStageTargets(source []StageTargetSummary) []StageTargetSummary {
	targets := append([]StageTargetSummary(nil), source...)
	sort.Slice(targets, func(i, j int) bool { return stageTargetLess(&targets[i], &targets[j]) })
	seen := make(map[string]struct{}, len(targets))
	unique := make([]StageTargetSummary, 0, len(targets))
	for i := range targets {
		key := targetDedupeKey(&targets[i])
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, targets[i])
	}
	return unique
}

func targetDedupeKey(target *StageTargetSummary) string {
	if target.StableID != "" {
		return "id\x00" + target.StableID
	}
	return strings.Join([]string{
		"legacy", target.Stage, target.Cluster.Namespace, target.Cluster.Name,
		target.ClusterLabel, strconv.FormatInt(int64(target.Ring), 10),
	}, "\x00")
}

func stageTargetLess(left, right *StageTargetSummary) bool {
	if left.Stage != right.Stage {
		return left.Stage < right.Stage
	}
	if compared := compareObjectKeys(left.Cluster, right.Cluster); compared != 0 {
		return compared < 0
	}
	if left.ClusterLabel != right.ClusterLabel {
		return left.ClusterLabel < right.ClusterLabel
	}
	if left.Ring != right.Ring {
		return left.Ring < right.Ring
	}
	if left.StableID != right.StableID {
		return left.StableID < right.StableID
	}
	return left.Health < right.Health
}

func targetWeightKey(application *ApplicationSummary, target *StageTargetSummary) TargetWeightKey {
	return TargetWeightKey{
		Project: application.Project, Application: application.Identity,
		Stage: target.Stage, Cluster: target.Cluster,
	}
}

func orderedHealthBuckets(counts map[Health]uint64) []HealthBucket {
	health := make([]Health, 0, len(counts))
	for value, count := range counts {
		if count > 0 {
			health = append(health, normalizedAggregateHealth(value))
		}
	}
	sort.Slice(health, func(i, j int) bool { return health[i] < health[j] })
	health = compactSorted(health)
	buckets := make([]HealthBucket, 0, len(health))
	for _, value := range health {
		var count uint64
		for original, originalCount := range counts {
			if normalizedAggregateHealth(original) == value {
				count += originalCount
			}
		}
		buckets = append(buckets, HealthBucket{Health: value, Count: count})
	}
	return buckets
}

func normalizedAggregateHealth(health Health) Health {
	if health < HealthHealthy || health > HealthMissing {
		return HealthUnknown
	}
	return health
}

func projectedApplicationHealth(application *ApplicationSummary) Health {
	health := normalizedAggregateHealth(application.Health)
	if application.MissingResourceCount == 0 {
		return health
	}
	switch health {
	case HealthProgressing, HealthDegraded, HealthFailed:
		return health
	case HealthUnspecified, HealthHealthy, HealthUnknown, HealthMissing:
		return HealthMissing
	default:
		return HealthMissing
	}
}

func healthValue(health Health) string {
	if value := canonicalHealth(normalizedAggregateHealth(health)); value != "" {
		return value
	}
	return "unknown"
}

func groupDimensionValue(dimension GroupDimension) string {
	switch dimension {
	case GroupDimensionProject:
		return "project"
	case GroupDimensionCluster:
		return "cluster"
	case GroupDimensionStage:
		return "stage"
	case GroupDimensionHealth:
		return "health"
	case GroupDimensionNamespace:
		return "namespace"
	case GroupDimensionUnspecified:
		return "unspecified"
	default:
		return "unspecified"
	}
}

func canonicalObjectIdentity(identity types.NamespacedName) string {
	return canonicalComponent(identity.Namespace) + "/" + canonicalComponent(identity.Name)
}

func canonicalComponent(value string) string {
	return url.PathEscape(value)
}
