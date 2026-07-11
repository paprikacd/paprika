package fleet

import (
	"errors"
	"reflect"
	"sync/atomic"

	"k8s.io/apimachinery/pkg/types"
)

// Snapshot is an immutable-by-contract view of the fleet. Callers build a
// mutable value with NewSnapshot; Index.Install publishes a deep clone.
type Snapshot struct {
	Generation   uint64
	Applications map[types.NamespacedName]ApplicationSummary
	Projects     map[ProjectKey]ProjectSummary
	ByProject    map[ProjectKey]IDSet
	ByNamespace  map[string]IDSet
	ByCluster    map[ClusterKey]IDSet
	ByStage      map[string]IDSet
	ByHealth     map[Health]IDSet
	BySync       map[SyncState]IDSet
	ByRelease    map[ReleaseState]IDSet
	ByRollout    map[RolloutState]IDSet
	BySourceType map[SourceType]IDSet
	Trigrams     map[string]IDSet

	searchDocuments map[types.NamespacedName]searchDocument
}

// Index atomically publishes immutable snapshots and independent readiness
// health. Readers always observe one complete snapshot pointer.
type Index struct {
	snapshot atomic.Pointer[Snapshot]
	health   atomic.Pointer[HealthState]
}

// ownedSnapshot is an opaque proof that every mutable path into a Snapshot is
// owned by this package. External callers must use defensive Install.
type ownedSnapshot struct {
	snapshot *Snapshot
	sealed   bool
}

// NewSnapshot returns an empty mutable snapshot builder with all maps ready
// for population.
func NewSnapshot(generation uint64) *Snapshot {
	return &Snapshot{
		Generation:      generation,
		Applications:    make(map[types.NamespacedName]ApplicationSummary),
		Projects:        make(map[ProjectKey]ProjectSummary),
		ByProject:       make(map[ProjectKey]IDSet),
		ByNamespace:     make(map[string]IDSet),
		ByCluster:       make(map[ClusterKey]IDSet),
		ByStage:         make(map[string]IDSet),
		ByHealth:        make(map[Health]IDSet),
		BySync:          make(map[SyncState]IDSet),
		ByRelease:       make(map[ReleaseState]IDSet),
		ByRollout:       make(map[RolloutState]IDSet),
		BySourceType:    make(map[SourceType]IDSet),
		Trigrams:        make(map[string]IDSet),
		searchDocuments: make(map[types.NamespacedName]searchDocument),
	}
}

// NewIndex returns an index with no serving snapshot and unavailable health.
func NewIndex() *Index {
	index := &Index{}
	index.health.Store(&HealthState{Reason: initialUnavailableReason})
	return index
}

// Install deep-clones builder, prepares its private search cache, and publishes
// the clone atomically. A successful install publishes the snapshot before it
// marks health ready, so readiness never advertises an absent snapshot.
func (i *Index) Install(builder *Snapshot) error {
	if builder == nil {
		return errors.New("fleet snapshot builder must not be nil")
	}
	if err := validateSnapshot(builder); err != nil {
		return err
	}

	snapshot := cloneSnapshot(builder)
	snapshot.rebuildSearchIndex()
	i.snapshot.Store(snapshot)
	return i.SetHealth(HealthState{Ready: true})
}

// installOwned publishes an already sealed package-owned snapshot without the
// full defensive clone performed by Install. It intentionally leaves health
// untouched; delta publication must preserve degraded/readiness state.
func (i *Index) installOwned(owned ownedSnapshot) error {
	if owned.snapshot == nil || !owned.sealed {
		return errors.New("owned fleet snapshot must be sealed")
	}
	i.snapshot.Store(owned.snapshot)
	return nil
}

// LoadSnapshot returns the currently serving snapshot regardless of degraded
// health. The pointer is loaded exactly once and is immutable by contract.
func (i *Index) LoadSnapshot() (*Snapshot, error) {
	snapshot := i.snapshot.Load()
	if snapshot == nil {
		return nil, &ErrUnavailable{Reason: initialUnavailableReason}
	}
	return snapshot, nil
}

func validateSnapshot(builder *Snapshot) error {
	if err := validateRecordIdentities(builder); err != nil {
		return err
	}
	if snapshotIndexesContainUnknownApplication(builder) {
		return errors.New("fleet snapshot index contains an unknown application")
	}
	return nil
}

func validateRecordIdentities(builder *Snapshot) error {
	for id := range builder.Applications {
		if id != builder.Applications[id].Identity {
			return errors.New("fleet snapshot application identity is inconsistent")
		}
	}
	for key := range builder.Projects {
		if key != builder.Projects[key].Identity {
			return errors.New("fleet snapshot project identity is inconsistent")
		}
	}
	return nil
}

func snapshotIndexesContainUnknownApplication(builder *Snapshot) bool {
	return indexContainsUnknownApplication(builder.Applications, builder.ByProject) ||
		indexContainsUnknownApplication(builder.Applications, builder.ByNamespace) ||
		indexContainsUnknownApplication(builder.Applications, builder.ByCluster) ||
		indexContainsUnknownApplication(builder.Applications, builder.ByStage) ||
		indexContainsUnknownApplication(builder.Applications, builder.ByHealth) ||
		indexContainsUnknownApplication(builder.Applications, builder.BySync) ||
		indexContainsUnknownApplication(builder.Applications, builder.ByRelease) ||
		indexContainsUnknownApplication(builder.Applications, builder.ByRollout) ||
		indexContainsUnknownApplication(builder.Applications, builder.BySourceType)
}

func indexContainsUnknownApplication[K comparable](
	applications map[types.NamespacedName]ApplicationSummary,
	index map[K]IDSet,
) bool {
	for _, ids := range index {
		for id := range ids {
			if _, ok := applications[id]; !ok {
				return true
			}
		}
	}
	return false
}

func cloneSnapshot(source *Snapshot) *Snapshot {
	clone := &Snapshot{
		Generation:      source.Generation,
		Applications:    cloneApplications(source.Applications),
		Projects:        cloneMap(source.Projects),
		ByProject:       cloneIDSetIndex(source.ByProject),
		ByNamespace:     cloneIDSetIndex(source.ByNamespace),
		ByCluster:       cloneIDSetIndex(source.ByCluster),
		ByStage:         cloneIDSetIndex(source.ByStage),
		ByHealth:        cloneIDSetIndex(source.ByHealth),
		BySync:          cloneIDSetIndex(source.BySync),
		ByRelease:       cloneIDSetIndex(source.ByRelease),
		ByRollout:       cloneIDSetIndex(source.ByRollout),
		BySourceType:    cloneIDSetIndex(source.BySourceType),
		Trigrams:        make(map[string]IDSet),
		searchDocuments: make(map[types.NamespacedName]searchDocument),
	}
	return clone
}

func cloneApplications(
	source map[types.NamespacedName]ApplicationSummary,
) map[types.NamespacedName]ApplicationSummary {
	if source == nil {
		return nil
	}

	clone := make(map[types.NamespacedName]ApplicationSummary, len(source))
	for id := range source {
		application := source[id]
		if application.Targets != nil {
			application.Targets = append([]StageTargetSummary(nil), application.Targets...)
		}
		clone[id] = application
	}
	return clone
}

func cloneMap[K comparable, V any](source map[K]V) map[K]V {
	if source == nil {
		return nil
	}

	clone := make(map[K]V, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func cloneIDSetIndex[K comparable](source map[K]IDSet) map[K]IDSet {
	if source == nil {
		return nil
	}

	clone := make(map[K]IDSet, len(source))
	for key, set := range source {
		clone[key] = set.Clone()
	}
	return clone
}

// snapshotEditor performs package-owned copy-on-write edits. Top-level maps are
// shallow-copied only if touched, and only changed nested IDSets/postings are
// cloned. The base snapshot remains immutable and safe for concurrent readers.
type snapshotEditor struct {
	next *Snapshot

	changed bool

	applicationsCloned bool
	projectsCloned     bool
	searchDocsCloned   bool
	trigramsCloned     bool

	byProjectCloned    bool
	byNamespaceCloned  bool
	byClusterCloned    bool
	byStageCloned      bool
	byHealthCloned     bool
	bySyncCloned       bool
	byReleaseCloned    bool
	byRolloutCloned    bool
	bySourceTypeCloned bool

	projectSets    map[ProjectKey]struct{}
	namespaceSets  map[string]struct{}
	clusterSets    map[ClusterKey]struct{}
	stageSets      map[string]struct{}
	healthSets     map[Health]struct{}
	syncSets       map[SyncState]struct{}
	releaseSets    map[ReleaseState]struct{}
	rolloutSets    map[RolloutState]struct{}
	sourceTypeSets map[SourceType]struct{}
	trigramSets    map[string]struct{}

	touchedApplications map[types.NamespacedName]struct{}
	touchedProjects     map[ProjectKey]struct{}
}

func newSnapshotEditor(base *Snapshot) *snapshotEditor {
	next := *base
	return &snapshotEditor{
		next:                &next,
		projectSets:         make(map[ProjectKey]struct{}),
		namespaceSets:       make(map[string]struct{}),
		clusterSets:         make(map[ClusterKey]struct{}),
		stageSets:           make(map[string]struct{}),
		healthSets:          make(map[Health]struct{}),
		syncSets:            make(map[SyncState]struct{}),
		releaseSets:         make(map[ReleaseState]struct{}),
		rolloutSets:         make(map[RolloutState]struct{}),
		sourceTypeSets:      make(map[SourceType]struct{}),
		trigramSets:         make(map[string]struct{}),
		touchedApplications: make(map[types.NamespacedName]struct{}),
		touchedProjects:     make(map[ProjectKey]struct{}),
	}
}

func (e *snapshotEditor) upsertApplication(summary *ApplicationSummary) bool {
	id := summary.Identity
	old, existed := e.next.Applications[id]
	replacement := *summary
	if replacement.Targets != nil {
		replacement.Targets = append([]StageTargetSummary(nil), replacement.Targets...)
	}
	if existed && reflect.DeepEqual(old, replacement) {
		return false
	}

	e.ensureApplications()
	var oldSummary *ApplicationSummary
	if existed {
		oldSummary = &old
	}
	e.updateApplicationIndexes(id, oldSummary, &replacement)
	e.next.Applications[id] = replacement
	e.touchedApplications[id] = struct{}{}
	if !existed {
		e.addSearchDocument(id)
	}
	e.changed = true
	return true
}

func (e *snapshotEditor) deleteApplication(id types.NamespacedName) bool {
	old, existed := e.next.Applications[id]
	if !existed {
		return false
	}
	e.ensureApplications()
	e.updateApplicationIndexes(id, &old, nil)
	delete(e.next.Applications, id)
	e.touchedApplications[id] = struct{}{}
	e.deleteSearchDocument(id)
	e.changed = true
	return true
}

func (e *snapshotEditor) upsertProject(summary ProjectSummary) bool {
	if old, ok := e.next.Projects[summary.Identity]; ok && old == summary {
		return false
	}
	e.ensureProjects()
	e.next.Projects[summary.Identity] = summary
	e.touchedProjects[summary.Identity] = struct{}{}
	e.changed = true
	return true
}

func (e *snapshotEditor) deleteProject(key ProjectKey) bool {
	if _, ok := e.next.Projects[key]; !ok {
		return false
	}
	e.ensureProjects()
	delete(e.next.Projects, key)
	e.touchedProjects[key] = struct{}{}
	e.changed = true
	return true
}

func (e *snapshotEditor) seal(generation uint64) (ownedSnapshot, error) {
	if err := e.validateTouched(); err != nil {
		return ownedSnapshot{}, err
	}
	e.next.Generation = generation
	return ownedSnapshot{snapshot: e.next, sealed: true}, nil
}

func sealFullyValidatedSnapshot(snapshot *Snapshot) (ownedSnapshot, error) {
	if snapshot == nil {
		return ownedSnapshot{}, errors.New("fleet snapshot must not be nil")
	}
	if err := validateSnapshot(snapshot); err != nil {
		return ownedSnapshot{}, err
	}
	return ownedSnapshot{snapshot: snapshot, sealed: true}, nil
}

func (e *snapshotEditor) validateTouched() error {
	if err := e.validateTouchedIdentities(); err != nil {
		return err
	}
	if e.touchedGroupingIndexIsInvalid() || e.touchedStateIndexIsInvalid() ||
		e.touchedDeliveryIndexIsInvalid() || e.touchedSearchIndexIsInvalid() {
		return errors.New("fleet snapshot touched index contains an unknown application")
	}
	return nil
}

func (e *snapshotEditor) validateTouchedIdentities() error {
	for id := range e.touchedApplications {
		if summary, ok := e.next.Applications[id]; ok && summary.Identity != id {
			return errors.New("fleet snapshot application identity is inconsistent")
		}
	}
	for key := range e.touchedProjects {
		if summary, ok := e.next.Projects[key]; ok && summary.Identity != key {
			return errors.New("fleet snapshot project identity is inconsistent")
		}
	}
	return nil
}

func (e *snapshotEditor) touchedGroupingIndexIsInvalid() bool {
	return touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByProject, e.projectSets) ||
		touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByNamespace, e.namespaceSets) ||
		touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByCluster, e.clusterSets) ||
		touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByStage, e.stageSets)
}

func (e *snapshotEditor) touchedStateIndexIsInvalid() bool {
	return touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByHealth, e.healthSets) ||
		touchedIndexContainsUnknownApplication(e.next.Applications, e.next.BySync, e.syncSets)
}

func (e *snapshotEditor) touchedDeliveryIndexIsInvalid() bool {
	return touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByRelease, e.releaseSets) ||
		touchedIndexContainsUnknownApplication(e.next.Applications, e.next.ByRollout, e.rolloutSets) ||
		touchedIndexContainsUnknownApplication(e.next.Applications, e.next.BySourceType, e.sourceTypeSets)
}

func (e *snapshotEditor) touchedSearchIndexIsInvalid() bool {
	return touchedIndexContainsUnknownApplication(e.next.Applications, e.next.Trigrams, e.trigramSets)
}

func touchedIndexContainsUnknownApplication[K comparable](
	applications map[types.NamespacedName]ApplicationSummary,
	index map[K]IDSet,
	touched map[K]struct{},
) bool {
	for key := range touched {
		for id := range index[key] {
			if _, ok := applications[id]; !ok {
				return true
			}
		}
	}
	return false
}

func (e *snapshotEditor) ensureApplications() {
	if e.applicationsCloned {
		return
	}
	e.next.Applications = cloneMap(e.next.Applications)
	if e.next.Applications == nil {
		e.next.Applications = make(map[types.NamespacedName]ApplicationSummary)
	}
	e.applicationsCloned = true
}

func (e *snapshotEditor) ensureProjects() {
	if e.projectsCloned {
		return
	}
	e.next.Projects = cloneMap(e.next.Projects)
	if e.next.Projects == nil {
		e.next.Projects = make(map[ProjectKey]ProjectSummary)
	}
	e.projectsCloned = true
}

type applicationIndexKeys struct {
	projects    map[ProjectKey]struct{}
	namespaces  map[string]struct{}
	clusters    map[ClusterKey]struct{}
	stages      map[string]struct{}
	health      map[Health]struct{}
	sync        map[SyncState]struct{}
	release     map[ReleaseState]struct{}
	rollout     map[RolloutState]struct{}
	sourceTypes map[SourceType]struct{}
}

func indexKeysForApplication(summary *ApplicationSummary) applicationIndexKeys {
	keys := applicationIndexKeys{
		projects:    map[ProjectKey]struct{}{summary.Project: {}},
		namespaces:  map[string]struct{}{summary.Identity.Namespace: {}},
		clusters:    make(map[ClusterKey]struct{}),
		stages:      make(map[string]struct{}),
		health:      map[Health]struct{}{summary.Health: {}},
		sync:        map[SyncState]struct{}{summary.Sync: {}},
		release:     map[ReleaseState]struct{}{summary.ReleaseState: {}},
		rollout:     map[RolloutState]struct{}{summary.RolloutState: {}},
		sourceTypes: map[SourceType]struct{}{summary.SourceType: {}},
	}
	for i := range summary.Targets {
		if summary.Targets[i].Cluster != (ClusterKey{}) {
			keys.clusters[summary.Targets[i].Cluster] = struct{}{}
		}
		if summary.Targets[i].Stage != "" {
			keys.stages[summary.Targets[i].Stage] = struct{}{}
		}
	}
	return keys
}

func (e *snapshotEditor) updateApplicationIndexes(
	id types.NamespacedName,
	old *ApplicationSummary,
	replacement *ApplicationSummary,
) {
	var oldKeys, newKeys applicationIndexKeys
	if old != nil {
		oldKeys = indexKeysForApplication(old)
	}
	if replacement != nil {
		newKeys = indexKeysForApplication(replacement)
	}

	syncIDSetIndex(&e.next.ByProject, &e.byProjectCloned, e.projectSets, id, oldKeys.projects, newKeys.projects)
	syncIDSetIndex(&e.next.ByNamespace, &e.byNamespaceCloned, e.namespaceSets, id, oldKeys.namespaces, newKeys.namespaces)
	syncIDSetIndex(&e.next.ByCluster, &e.byClusterCloned, e.clusterSets, id, oldKeys.clusters, newKeys.clusters)
	syncIDSetIndex(&e.next.ByStage, &e.byStageCloned, e.stageSets, id, oldKeys.stages, newKeys.stages)
	syncIDSetIndex(&e.next.ByHealth, &e.byHealthCloned, e.healthSets, id, oldKeys.health, newKeys.health)
	syncIDSetIndex(&e.next.BySync, &e.bySyncCloned, e.syncSets, id, oldKeys.sync, newKeys.sync)
	syncIDSetIndex(&e.next.ByRelease, &e.byReleaseCloned, e.releaseSets, id, oldKeys.release, newKeys.release)
	syncIDSetIndex(&e.next.ByRollout, &e.byRolloutCloned, e.rolloutSets, id, oldKeys.rollout, newKeys.rollout)
	syncIDSetIndex(&e.next.BySourceType, &e.bySourceTypeCloned, e.sourceTypeSets, id, oldKeys.sourceTypes, newKeys.sourceTypes)
}

//nolint:gocritic // the map header pointer is required to replace the top-level map on first write.
func syncIDSetIndex[K comparable](
	index *map[K]IDSet,
	topCloned *bool,
	touched map[K]struct{},
	id types.NamespacedName,
	oldKeys, newKeys map[K]struct{},
) {
	for key := range oldKeys {
		if _, retained := newKeys[key]; !retained {
			mutateIDSetIndex(index, topCloned, touched, key, id, false)
		}
	}
	for key := range newKeys {
		if _, alreadyPresent := oldKeys[key]; !alreadyPresent {
			mutateIDSetIndex(index, topCloned, touched, key, id, true)
		}
	}
}

//nolint:gocritic // the map header pointer is required to replace the top-level map on first write.
func mutateIDSetIndex[K comparable](
	index *map[K]IDSet,
	topCloned *bool,
	touched map[K]struct{},
	key K,
	id types.NamespacedName,
	add bool,
) {
	if !*topCloned {
		*index = cloneMap(*index)
		if *index == nil {
			*index = make(map[K]IDSet)
		}
		*topCloned = true
	}
	set := (*index)[key]
	if _, ok := touched[key]; !ok {
		set = set.Clone()
		touched[key] = struct{}{}
	}
	if add {
		if set == nil {
			set = make(IDSet)
		}
		set[id] = struct{}{}
		(*index)[key] = set
		return
	}
	delete(set, id)
	if len(set) == 0 {
		delete(*index, key)
		return
	}
	(*index)[key] = set
}

func (e *snapshotEditor) addSearchDocument(id types.NamespacedName) {
	document := searchDocument{normalizedName: normalizeText(id.Name), trigrams: trigramSet(normalizeText(id.Name))}
	e.ensureSearchDocuments()
	e.next.searchDocuments[id] = document
	for trigram := range document.trigrams {
		mutateIDSetIndex(&e.next.Trigrams, &e.trigramsCloned, e.trigramSets, trigram, id, true)
	}
}

func (e *snapshotEditor) deleteSearchDocument(id types.NamespacedName) {
	document, ok := e.next.searchDocuments[id]
	if !ok {
		normalized := normalizeText(id.Name)
		document = searchDocument{trigrams: trigramSet(normalized)}
	}
	e.ensureSearchDocuments()
	delete(e.next.searchDocuments, id)
	for trigram := range document.trigrams {
		mutateIDSetIndex(&e.next.Trigrams, &e.trigramsCloned, e.trigramSets, trigram, id, false)
	}
}

func (e *snapshotEditor) ensureSearchDocuments() {
	if e.searchDocsCloned {
		return
	}
	e.next.searchDocuments = cloneMap(e.next.searchDocuments)
	if e.next.searchDocuments == nil {
		e.next.searchDocuments = make(map[types.NamespacedName]searchDocument)
	}
	e.searchDocsCloned = true
}

func addApplicationMutable(snapshot *Snapshot, projected *ApplicationSummary) {
	summary := *projected
	if summary.Targets != nil {
		summary.Targets = append([]StageTargetSummary(nil), summary.Targets...)
	}
	snapshot.Applications[summary.Identity] = summary
	keys := indexKeysForApplication(&summary)
	addMutableIndexKeys(snapshot.ByProject, keys.projects, summary.Identity)
	addMutableIndexKeys(snapshot.ByNamespace, keys.namespaces, summary.Identity)
	addMutableIndexKeys(snapshot.ByCluster, keys.clusters, summary.Identity)
	addMutableIndexKeys(snapshot.ByStage, keys.stages, summary.Identity)
	addMutableIndexKeys(snapshot.ByHealth, keys.health, summary.Identity)
	addMutableIndexKeys(snapshot.BySync, keys.sync, summary.Identity)
	addMutableIndexKeys(snapshot.ByRelease, keys.release, summary.Identity)
	addMutableIndexKeys(snapshot.ByRollout, keys.rollout, summary.Identity)
	addMutableIndexKeys(snapshot.BySourceType, keys.sourceTypes, summary.Identity)
}

func addMutableIndexKeys[K comparable](index map[K]IDSet, keys map[K]struct{}, id types.NamespacedName) {
	for key := range keys {
		set := index[key]
		if set == nil {
			set = make(IDSet)
			index[key] = set
		}
		set[id] = struct{}{}
	}
}
