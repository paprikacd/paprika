package satellite

import (
	"fmt"
	"sort"
	"sync"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/tools/cache"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

type observation struct {
	kind, namespace, name        string
	uid                          types.UID
	app                          Application
	ready, running               bool
	region, zone, kubeletVersion string
	// capacity holds the resource-accounting inputs for nodes, pods and node
	// metrics. It is only populated for those kinds; an Application leaves it
	// zero, which also keeps the struct comparable.
	capacity capacityObservation
}

// observationState retains no raw Kubernetes objects. All updates coalesce in
// this compact map, so an unavailable control plane cannot grow an event queue.
type observationState struct {
	mu                 sync.RWMutex
	objects            map[string]*observation
	version            uint64
	cachedVersion      uint64
	cachedInventory    clustersv1alpha1.ClusterInventory
	cachedApplications map[string]Application
	cachedCapacity     clustersv1alpha1.SatelliteCapacity
	cachedNodePools    []clustersv1alpha1.ClusterNodePool
	cachedProviderType string
}

func newObservationState() *observationState {
	return &observationState{objects: make(map[string]*observation)}
}

func observationKey(o *observation) string { return o.kind + "/" + o.namespace + "/" + o.name }

func (s *observationState) upsert(obj any) {
	o, ok := projectObject(obj)
	if !ok {
		return
	}
	s.mu.Lock()
	key := observationKey(&o)
	if previous, exists := s.objects[key]; !exists || *previous != o {
		updated := o
		s.objects[key] = &updated
		s.version++
	}
	s.mu.Unlock()
}

func (s *observationState) delete(obj any) {
	if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = tombstone.Obj
	}
	o, ok := projectObject(obj)
	if !ok {
		return
	}
	s.mu.Lock()
	key := observationKey(&o)
	if current, exists := s.objects[key]; exists && current.uid == o.uid {
		delete(s.objects, key)
		s.version++
	}
	s.mu.Unlock()
}

func (s *observationState) clearApplications() { s.clearKind("Application") }

// clearKind drops every observation of one kind. It runs when an optional API
// disappears: retention of a removed source's last reading would report a
// cluster state nobody can observe any more.
func (s *observationState) clearKind(kind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, object := range s.objects {
		if object.kind == kind {
			delete(s.objects, key)
			s.version++
		}
	}
}

// snapshot returns immutable application maps and inventory slices. A changed
// compact observation installs a fresh snapshot; retained snapshots never
// change. Watch updates affecting only resource versions, pod specs, or other
// unreported fields do not invalidate the cache.
func (s *observationState) snapshot() (inventory clustersv1alpha1.ClusterInventory, apps map[string]Application) {
	s.ensureProjection()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cachedInventory, s.cachedApplications
}

// capacitySnapshot returns the resource accounting built from the same cached
// projection snapshot() uses. Two accessors rather than one keeps the existing
// inventory contract intact while guaranteeing the numbers cannot disagree:
// both are produced by one rebuild per observation version.
func (s *observationState) capacitySnapshot() (clustersv1alpha1.SatelliteCapacity, []clustersv1alpha1.ClusterNodePool, string) {
	s.ensureProjection()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cachedCapacity, s.cachedNodePools, s.cachedProviderType
}

// ensureProjection rebuilds the cached view once per observation version. It
// takes the write lock only when a rebuild is actually needed, so the common
// steady-state call is a read-locked version check.
func (s *observationState) ensureProjection() {
	s.mu.RLock()
	if s.cachedApplications != nil && s.cachedVersion == s.version {
		s.mu.RUnlock()
		return
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cachedApplications != nil && s.cachedVersion == s.version {
		return
	}
	projection := newSnapshotProjection()
	for _, object := range s.objects {
		projection.add(object)
	}
	for _, object := range s.objects {
		if object.kind == "Application" {
			projection.apps[object.app.Key()] = object.app
		}
	}
	capacity, nodePools, providerType := projection.capacity.build()
	s.cachedVersion = s.version
	s.cachedInventory = projection.inventory()
	s.cachedApplications = projection.apps
	s.cachedCapacity = capacity
	s.cachedNodePools = nodePools
	s.cachedProviderType = providerType
}

type snapshotProjection struct {
	counts                   clustersv1alpha1.ClusterInventory
	regions, zones, versions map[string]bool
	apps                     map[string]Application
	conflictingGroups        map[string]bool
	capacity                 capacityBuilder
}

func newSnapshotProjection() *snapshotProjection {
	return &snapshotProjection{regions: map[string]bool{}, zones: map[string]bool{}, versions: map[string]bool{}, apps: map[string]Application{}, conflictingGroups: map[string]bool{}}
}

func (p *snapshotProjection) add(object *observation) {
	switch object.kind {
	case "Node":
		p.counts.NodeCount++
		if object.ready {
			p.counts.ReadyNodeCount++
		}
		p.regions[object.region], p.zones[object.zone], p.versions[object.kubeletVersion] = true, true, true
		p.capacity.addNode(&object.capacity)
	case "Pod":
		p.counts.PodCount++
		if object.running {
			p.counts.RunningPodCount++
		}
		p.capacity.addPod(&object.capacity)
	case nodeMetricsKind:
		p.capacity.addNodeMetrics(&object.capacity)
	case "Namespace":
		p.counts.NamespaceCount++
	case "Deployment", "StatefulSet", "DaemonSet":
		p.addWorkload(object)
	}
}

func (p *snapshotProjection) addWorkload(object *observation) {
	key := object.app.Key()
	if p.conflictingGroups[key] {
		return
	}
	candidate := normalizedWorkloadAssociation(&object.app)
	app, exists := p.apps[key]
	if !exists {
		p.apps[key] = candidate
		return
	}
	if app.Project != candidate.Project || app.Identity != candidate.Identity {
		// A name alone cannot authorize a cross-project merge. Drop ambiguous
		// native groups before any of their health/counts enter another project.
		delete(p.apps, key)
		p.conflictingGroups[key] = true
		return
	}
	app.ResourceCount += object.app.ResourceCount
	if healthSeverity(object.app.Health) > healthSeverity(app.Health) {
		app.Health, app.Phase = object.app.Health, object.app.Phase
	}
	p.apps[key] = app
}

func (p *snapshotProjection) inventory() clustersv1alpha1.ClusterInventory {
	p.counts.Regions, p.counts.Zones, p.counts.KubeletVersions = sortedValues(p.regions), sortedValues(p.zones), sortedValues(p.versions)
	return p.counts
}

func normalizedWorkloadAssociation(app *Application) Application {
	normalized := *app
	if normalized.Project == "" {
		normalized.Project = "default"
	}
	if normalized.Identity == normalized.Name {
		normalized.Identity = ""
	}
	return normalized
}

func sortedValues(values map[string]bool) []string {
	delete(values, "")
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func healthSeverity(health string) int {
	switch health {
	case "Healthy":
		return 0
	case "Progressing":
		return 1
	case "Unknown", "":
		return 2
	case "Degraded":
		return 3
	case "Failed", "Missing":
		return 4
	default:
		return 2
	}
}

func projectObject(obj any) (observation, bool) {
	switch typed := obj.(type) {
	case *corev1.Node:
		return projectNode(typed), true
	case *corev1.Pod:
		o := baseObservation("Pod", &typed.ObjectMeta)
		o.running = typed.Status.Phase == corev1.PodRunning
		o.capacity.projectPod(typed)
		return o, true
	case *corev1.Namespace:
		return baseObservation("Namespace", &typed.ObjectMeta), true
	case *appsv1.Deployment:
		return projectDeployment(typed), true
	case *appsv1.StatefulSet:
		return projectStatefulSet(typed), true
	case *appsv1.DaemonSet:
		return projectDaemonSet(typed), true
	case *unstructured.Unstructured:
		if isNodeMetricsValue(typed) {
			return projectNodeMetrics(typed)
		}
		return projectApplication(typed), true
	default:
		return observation{}, false
	}
}

// projectNodeMetrics turns one NodeMetrics object into a usage observation. An
// object with no parsable usage is dropped so a broken metrics API cannot report
// a phantom idle cluster.
func projectNodeMetrics(nodeMetrics *unstructured.Unstructured) (observation, bool) {
	o := baseObservation(nodeMetricsKind, &metav1.ObjectMeta{Name: nodeMetrics.GetName()})
	if !o.capacity.projectNodeMetrics(nodeMetrics) {
		return observation{}, false
	}
	return o, true
}

func projectNode(node *corev1.Node) observation {
	o := baseObservation("Node", &node.ObjectMeta)
	o.region, o.zone, o.kubeletVersion = node.Labels["topology.kubernetes.io/region"], node.Labels["topology.kubernetes.io/zone"], node.Status.NodeInfo.KubeletVersion
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady {
			o.ready = condition.Status == corev1.ConditionTrue
		}
	}
	o.capacity.projectNode(node)
	return o
}

func desiredReplicas(replicas *int32) int32 {
	if replicas != nil {
		return *replicas
	}
	return 1
}

func projectDeployment(deployment *appsv1.Deployment) observation {
	o := workloadObservation("Deployment", &deployment.ObjectMeta)
	desired := desiredReplicas(deployment.Spec.Replicas)
	healthy := deployment.Status.ObservedGeneration >= deployment.Generation && deployment.Status.UpdatedReplicas >= desired && deployment.Status.AvailableReplicas >= desired
	setWorkloadHealth(&o, healthy, deployment.Status.AvailableReplicas, desired)
	for _, condition := range deployment.Status.Conditions {
		if condition.Type == appsv1.DeploymentReplicaFailure && condition.Status == corev1.ConditionTrue {
			o.app.Health, o.app.Phase = "Failed", "Failed"
		}
		if condition.Type == appsv1.DeploymentProgressing && condition.Status == corev1.ConditionFalse && o.app.Health != "Failed" {
			o.app.Health, o.app.Phase = "Degraded", "Degraded"
		}
	}
	return o
}

func projectStatefulSet(stateful *appsv1.StatefulSet) observation {
	o := workloadObservation("StatefulSet", &stateful.ObjectMeta)
	desired := desiredReplicas(stateful.Spec.Replicas)
	updatedDesired := desired
	if rolling := stateful.Spec.UpdateStrategy.RollingUpdate; rolling != nil && rolling.Partition != nil {
		updatedDesired = max(0, desired-*rolling.Partition)
	}
	updated := stateful.Spec.UpdateStrategy.Type == appsv1.OnDeleteStatefulSetStrategyType || stateful.Status.UpdatedReplicas >= updatedDesired
	healthy := stateful.Status.ObservedGeneration >= stateful.Generation && stateful.Status.ReadyReplicas >= desired && updated
	setWorkloadHealth(&o, healthy, stateful.Status.ReadyReplicas, desired)
	return o
}

func projectDaemonSet(daemon *appsv1.DaemonSet) observation {
	o := workloadObservation("DaemonSet", &daemon.ObjectMeta)
	desired := daemon.Status.DesiredNumberScheduled
	healthy := daemon.Status.ObservedGeneration >= daemon.Generation && daemon.Status.UpdatedNumberScheduled >= desired && daemon.Status.NumberAvailable >= desired
	setWorkloadHealth(&o, healthy, daemon.Status.NumberAvailable, desired)
	return o
}

func projectApplication(application *unstructured.Unstructured) observation {
	o := baseObservation("Application", &metav1.ObjectMeta{Name: application.GetName(), Namespace: application.GetNamespace(), UID: application.GetUID()})
	o.app = Application{Namespace: o.namespace, Name: o.name, Identity: validDNSName(application.GetLabels()["app.paprika.io/identity"])}
	o.app.Project = validDNSName(projectedString(application.Object, "spec", "project"))
	o.app.Health = projectedString(application.Object, "status", "health")
	o.app.Phase = projectedString(application.Object, "status", "phase")
	if o.app.Health == "" {
		o.app.Health = "Unknown"
	}
	o.app.OutOfSync = positiveCount(projectedInt(application.Object, "status", "outOfSync"))
	o.app.SyncKnown = projectedBool(application.Object, "status", "synced") || projectedBool(application.Object, "status", "syncKnown") || o.app.OutOfSync > 0
	o.app.ResourceCount = projectedResourceCount(application.Object)
	o.app.SourceRevision = projectedString(application.Object, "status", "sourceRevision")
	if o.app.SourceRevision == "" {
		o.app.SourceRevision = projectedString(application.Object, "status", "revision")
	}
	return o
}

func projectedString(object map[string]any, fields ...string) string {
	value, _, err := unstructured.NestedString(object, fields...)
	if err != nil {
		return ""
	}
	return value
}

func projectedInt(object map[string]any, fields ...string) int64 {
	value, _, err := unstructured.NestedInt64(object, fields...)
	if err != nil {
		return 0
	}
	return value
}

func projectedBool(object map[string]any, fields ...string) bool {
	value, _, err := unstructured.NestedBool(object, fields...)
	return err == nil && value
}

func projectedResourceCount(object map[string]any) uint32 {
	if count, found, err := unstructured.NestedInt64(object, "status", "resourceCount"); err == nil && found {
		return positiveCount(count)
	}
	resources, _, err := unstructured.NestedSlice(object, "status", "resources")
	if err != nil {
		return 0
	}
	return positiveCount(int64(len(resources)))
}

func positiveCount(count int64) uint32 {
	if count <= 0 {
		return 0
	}
	if count > int64(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(count)
}

func baseObservation(kind string, metadata *metav1.ObjectMeta) observation {
	return observation{kind: kind, namespace: metadata.Namespace, name: metadata.Name, uid: metadata.UID}
}

func workloadObservation(kind string, metadata *metav1.ObjectMeta) observation {
	o := baseObservation(kind, metadata)
	name := metadata.Name
	for _, label := range []string{"app.paprika.io/name", "app.kubernetes.io/part-of", "app.kubernetes.io/name"} {
		if value := validDNSName(metadata.Labels[label]); value != "" {
			name = value
			break
		}
	}
	o.app = Application{Namespace: metadata.Namespace, Name: name, Identity: validDNSName(metadata.Labels["app.paprika.io/identity"]), Project: validDNSName(metadata.Labels["app.paprika.io/project"]), ResourceCount: 1}
	return o
}

func validDNSName(value string) string {
	if value == "" || len(validation.IsDNS1123Subdomain(value)) != 0 {
		return ""
	}
	return value
}

func setWorkloadHealth(o *observation, healthy bool, ready, desired int32) {
	o.app.Health, o.app.Phase = "Progressing", "Verifying"
	if healthy {
		o.app.Health, o.app.Phase = "Healthy", "Healthy"
		return
	}
	if ready == 0 && desired > 0 {
		o.app.Health, o.app.Phase = "Degraded", "Degraded"
	}
}

// compactObject runs before objects enter an informer cache. Besides bounding
// memory, stripping pod container/env data and Application sources ensures
// credentials embedded in arbitrary workload specs are never retained here.
func compactObject(obj any) (any, error) {
	switch typed := obj.(type) {
	case *corev1.Node:
		return &corev1.Node{
			ObjectMeta: compactMetadata(&typed.ObjectMeta),
			Spec:       corev1.NodeSpec{ProviderID: typed.Spec.ProviderID},
			Status: corev1.NodeStatus{
				Conditions:  compactNodeConditions(typed.Status.Conditions),
				NodeInfo:    corev1.NodeSystemInfo{KubeletVersion: typed.Status.NodeInfo.KubeletVersion},
				Allocatable: compactAllocatable(typed.Status.Allocatable),
			},
		}, nil
	case *corev1.Pod:
		return compactPod(typed), nil
	case *corev1.Namespace:
		return &corev1.Namespace{ObjectMeta: compactMetadata(&typed.ObjectMeta)}, nil
	case *appsv1.Deployment:
		status := typed.Status
		status.Conditions = compactDeploymentConditions(status.Conditions)
		return &appsv1.Deployment{ObjectMeta: compactMetadata(&typed.ObjectMeta), Spec: appsv1.DeploymentSpec{Replicas: typed.Spec.Replicas}, Status: status}, nil
	case *appsv1.StatefulSet:
		status := typed.Status
		status.Conditions = nil
		strategy := appsv1.StatefulSetUpdateStrategy{Type: typed.Spec.UpdateStrategy.Type}
		if typed.Spec.UpdateStrategy.RollingUpdate != nil {
			strategy.RollingUpdate = &appsv1.RollingUpdateStatefulSetStrategy{Partition: typed.Spec.UpdateStrategy.RollingUpdate.Partition}
		}
		return &appsv1.StatefulSet{ObjectMeta: compactMetadata(&typed.ObjectMeta), Spec: appsv1.StatefulSetSpec{Replicas: typed.Spec.Replicas, UpdateStrategy: strategy}, Status: status}, nil
	case *appsv1.DaemonSet:
		status := typed.Status
		status.Conditions = nil
		return &appsv1.DaemonSet{ObjectMeta: compactMetadata(&typed.ObjectMeta), Status: status}, nil
	case *unstructured.Unstructured:
		return compactDynamicObject(typed), nil
	default:
		return nil, fmt.Errorf("unsupported satellite watch object %T", obj)
	}
}

// compactDynamicObject narrows the dynamic-informer path, which carries both
// Paprika Applications and metrics.k8s.io NodeMetrics.
func compactDynamicObject(typed *unstructured.Unstructured) *unstructured.Unstructured {
	if isNodeMetricsValue(typed) {
		return compactNodeMetrics(typed)
	}
	o, _ := projectObject(typed)
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "pipelines.paprika.io/v1alpha1",
		"kind":       "Application",
		"metadata": map[string]any{
			"name": o.name, "namespace": o.namespace, "uid": string(o.uid),
			"resourceVersion": typed.GetResourceVersion(),
			"labels":          map[string]any{"app.paprika.io/identity": o.app.Identity},
		},
		"spec": map[string]any{"project": o.app.Project},
		"status": map[string]any{
			"health": o.app.Health, "phase": o.app.Phase,
			"outOfSync": int64(o.app.OutOfSync), "syncKnown": o.app.SyncKnown,
			"resourceCount": int64(o.app.ResourceCount), "sourceRevision": o.app.SourceRevision,
		},
	}}
}

// compactMetadataLabelKeys is the union of the labels Paprika reads. It is a
// package value because compaction runs on every watch event: assembling the
// list per object would allocate on the hot path for a set that never changes.
var compactMetadataLabelKeys = append([]string{
	"app.paprika.io/name",
	"app.paprika.io/identity",
	"app.paprika.io/project",
	"app.kubernetes.io/part-of",
	"app.kubernetes.io/name",
}, capacityLabelKeys...)

// compactMetadata keeps the labels Paprika reads and nothing else. Node-pool
// and topology labels are on the list because capacity accounting derives pools
// from them; an operator's own bookkeeping labels stay on the cluster.
func compactMetadata(metadata *metav1.ObjectMeta) metav1.ObjectMeta {
	labels := make(map[string]string, len(compactMetadataLabelKeys))
	for _, key := range compactMetadataLabelKeys {
		if value := metadata.Labels[key]; value != "" {
			labels[key] = value
		}
	}
	return metav1.ObjectMeta{Name: metadata.Name, Namespace: metadata.Namespace, UID: metadata.UID, ResourceVersion: metadata.ResourceVersion, Generation: metadata.Generation, Labels: labels}
}

// compactAllocatable retains only the two dimensions capacity accounting sums.
// The full ResourceList also carries ephemeral storage and hugepages, none of
// which a fleet capacity meter reports.
func compactAllocatable(allocatable corev1.ResourceList) corev1.ResourceList {
	compacted := corev1.ResourceList{}
	for _, name := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		if quantity, ok := allocatable[name]; ok {
			compacted[name] = quantity.DeepCopy()
		}
	}
	return compacted
}

func compactNodeConditions(conditions []corev1.NodeCondition) []corev1.NodeCondition {
	result := make([]corev1.NodeCondition, 0, 1)
	for _, condition := range conditions {
		if condition.Type == corev1.NodeReady {
			result = append(result, corev1.NodeCondition{Type: condition.Type, Status: condition.Status})
		}
	}
	return result
}

func compactDeploymentConditions(conditions []appsv1.DeploymentCondition) []appsv1.DeploymentCondition {
	result := make([]appsv1.DeploymentCondition, 0, len(conditions))
	for _, condition := range conditions {
		result = append(result, appsv1.DeploymentCondition{Type: condition.Type, Status: condition.Status})
	}
	return result
}
