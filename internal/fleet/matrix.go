package fleet

import (
	"fmt"
	"math"
	"sort"

	"k8s.io/apimachinery/pkg/types"
)

// FleetMatrixQuery is the complete provider-neutral matrix query. Both axes
// must be concrete and distinct; ResourceCount is the default size metric.
type FleetMatrixQuery struct {
	Filter      ApplicationFilter
	Search      string
	RowGroup    GroupDimension
	ColumnGroup GroupDimension
	SizeMetric  SizeMetric
}

// FleetMatrixHeader identifies one deterministic row or column bucket.
// Project and named Cluster dimensions use Object. Scalar dimensions and
// in-cluster or unmanaged-inline Cluster sentinels use Value.
type FleetMatrixHeader struct {
	StableID string
	Label    string
	Object   types.NamespacedName
	Value    string
}

// FleetMatrixCell is one sparse aggregate. ApplicationCount is unique within
// the cell; TargetCount counts exact StageTargetSummary projections.
type FleetMatrixCell struct {
	RowID                string
	ColumnID             string
	ApplicationCount     uint64
	TargetCount          uint64
	Health               []HealthBucket
	ResourceWeight       uint64
	RequestRateWeight    float64
	UsedResourceFallback bool
}

// FleetMatrix is one authorized result over one immutable snapshot
// generation. Total retains Application-level filter semantics even when an
// Application has no exact target matching active Stage and Cluster filters.
type FleetMatrix struct {
	Rows       []FleetMatrixHeader
	Columns    []FleetMatrixHeader
	Cells      []FleetMatrixCell
	Total      uint64
	Generation uint64
}

// ErrInvalidMatrixAxes reports caller-controlled row/column axis errors.
// Keeping this typed lets the API layer map it to InvalidArgument without
// inspecting error strings.
type ErrInvalidMatrixAxes struct {
	Row    GroupDimension
	Column GroupDimension
}

func (e *ErrInvalidMatrixAxes) Error() string {
	if e != nil && e.Row == e.Column {
		return fmt.Sprintf("fleet matrix axes must differ: %d", e.Row)
	}
	return "fleet matrix axes must be concrete group dimensions"
}

type matrixAxisKey struct {
	dimension GroupDimension
	object    types.NamespacedName
	value     string
	canonical string
	order     uint8
}

type matrixCellKey struct {
	row    matrixAxisKey
	column matrixAxisKey
}

type matrixCellAccumulator struct {
	applicationCount uint64
	targetCount      uint64
	health           map[Health]uint64
	resourceWeight   uint64
	requestRate      float64
	requestComplete  bool
}

// QueryMatrix authorizes, searches, and filters before aggregation. If either
// axis is Stage or Cluster, every selected real target is projected exactly
// once and supplies both axis keys; this cannot create a Cartesian product.
//
//nolint:gocritic // Fleet queries are immutable value objects at this public API seam.
func (s *Snapshot) QueryMatrix(
	scope QueryScope,
	query FleetMatrixQuery,
	weights WeightReader,
) (FleetMatrix, error) {
	if err := validateMatrixAxes(query.RowGroup, query.ColumnGroup); err != nil {
		return FleetMatrix{}, err
	}
	sizeMetric, err := normalizeSizeMetric(query.SizeMetric)
	if err != nil {
		return FleetMatrix{}, err
	}
	filter := query.Filter.Normalized()
	if validationErr := validateApplicationFilter(&filter); validationErr != nil {
		return FleetMatrix{}, validationErr
	}

	filtered, err := s.FilterApplications(scope, filter, query.Search)
	if err != nil {
		return FleetMatrix{}, err
	}

	rowLabels := make(map[matrixAxisKey]string)
	columnLabels := make(map[matrixAxisKey]string)
	cells := make(map[matrixCellKey]*matrixCellAccumulator)
	selector := newTargetFilterSelector(&filter)
	targetMode := isTargetMatrixDimension(query.RowGroup) || isTargetMatrixDimension(query.ColumnGroup)

	for _, id := range sortedIDs(filtered.IDs) {
		application := s.Applications[id]
		targets := uniqueStageTargets(application.Targets)
		if targetMode {
			s.aggregateMatrixTargets(
				&application, targets, selector, &query, sizeMetric, weights,
				rowLabels, columnLabels, cells,
			)
			continue
		}
		s.aggregateMatrixApplication(
			&application, targets, selector, &query, sizeMetric, weights,
			rowLabels, columnLabels, cells,
		)
	}

	return buildFleetMatrix(
		rowLabels, columnLabels, cells, sizeMetric,
		uint64(len(filtered.IDs)), s.Generation,
	), nil
}

func validateMatrixAxes(row, column GroupDimension) error {
	if row < GroupDimensionProject || row > GroupDimensionHealth ||
		column < GroupDimensionProject || column > GroupDimensionHealth ||
		row == column {
		return &ErrInvalidMatrixAxes{Row: row, Column: column}
	}
	return nil
}

func isTargetMatrixDimension(dimension GroupDimension) bool {
	return dimension == GroupDimensionStage || dimension == GroupDimensionCluster
}

func (s *Snapshot) aggregateMatrixTargets(
	application *ApplicationSummary,
	targets []StageTargetSummary,
	selector targetFilterSelector,
	query *FleetMatrixQuery,
	sizeMetric SizeMetric,
	weights WeightReader,
	rowLabels, columnLabels map[matrixAxisKey]string,
	cells map[matrixCellKey]*matrixCellAccumulator,
) {
	seenApplicationCells := make(map[matrixCellKey]struct{})
	for i := range targets {
		target := &targets[i]
		if !selector.matches(target) {
			continue
		}
		row, rowLabel := s.matrixAxis(query.RowGroup, application, target, true)
		column, columnLabel := s.matrixAxis(query.ColumnGroup, application, target, true)
		rememberMatrixLabel(rowLabels, &row, rowLabel)
		rememberMatrixLabel(columnLabels, &column, columnLabel)

		key := matrixCellKey{row: row, column: column}
		cell := matrixAccumulator(cells, &key)
		if _, seen := seenApplicationCells[key]; !seen {
			cell.applicationCount++
			seenApplicationCells[key] = struct{}{}
		}
		cell.targetCount++
		cell.health[normalizedAggregateHealth(target.Health)]++
		cell.resourceWeight += uint64(application.ResourceCount)
		addMatrixTargetWeight(cell, application, target, sizeMetric, weights)
	}
}

func (s *Snapshot) aggregateMatrixApplication(
	application *ApplicationSummary,
	targets []StageTargetSummary,
	selector targetFilterSelector,
	query *FleetMatrixQuery,
	sizeMetric SizeMetric,
	weights WeightReader,
	rowLabels, columnLabels map[matrixAxisKey]string,
	cells map[matrixCellKey]*matrixCellAccumulator,
) {
	row, rowLabel := s.matrixAxis(query.RowGroup, application, nil, false)
	column, columnLabel := s.matrixAxis(query.ColumnGroup, application, nil, false)
	rememberMatrixLabel(rowLabels, &row, rowLabel)
	rememberMatrixLabel(columnLabels, &column, columnLabel)

	key := matrixCellKey{row: row, column: column}
	cell := matrixAccumulator(cells, &key)
	cell.applicationCount++
	cell.targetCount += uint64(len(targets))
	cell.health[normalizedAggregateHealth(application.Health)]++
	cell.resourceWeight += uint64(application.ResourceCount)
	if sizeMetric != SizeMetricRequestRate {
		return
	}

	selected := selectedMapTargets(targets, currentStageTarget(application, targets), selector)
	if len(selected) == 0 {
		cell.requestComplete = false
		return
	}
	for i := range selected {
		addMatrixTargetWeight(cell, application, &selected[i], sizeMetric, weights)
	}
}

func (s *Snapshot) matrixAxis(
	dimension GroupDimension,
	application *ApplicationSummary,
	target *StageTargetSummary,
	targetMode bool,
) (key matrixAxisKey, label string) {
	axisApplication := application
	if targetMode && dimension == GroupDimensionHealth && target != nil {
		projected := *application
		projected.Health = normalizedAggregateHealth(target.Health)
		axisApplication = &projected
	}
	group := s.mapKey(dimension, axisApplication, target)
	return matrixAxisKey{
		dimension: group.dimension,
		object:    group.object,
		value:     group.value,
		canonical: group.canonical,
		order:     group.order,
	}, group.label
}

func rememberMatrixLabel(labels map[matrixAxisKey]string, key *matrixAxisKey, candidate string) {
	current, exists := labels[*key]
	if !exists || current == "" || (candidate != "" && candidate < current) {
		labels[*key] = candidate
	}
}

func matrixAccumulator(
	cells map[matrixCellKey]*matrixCellAccumulator,
	key *matrixCellKey,
) *matrixCellAccumulator {
	if current := cells[*key]; current != nil {
		return current
	}
	created := &matrixCellAccumulator{
		health:          make(map[Health]uint64),
		requestComplete: true,
	}
	cells[*key] = created
	return created
}

func addMatrixTargetWeight(
	cell *matrixCellAccumulator,
	application *ApplicationSummary,
	target *StageTargetSummary,
	sizeMetric SizeMetric,
	weights WeightReader,
) {
	if sizeMetric != SizeMetricRequestRate {
		return
	}
	if weights == nil {
		cell.requestComplete = false
		return
	}
	value, ok := weights.RequestRate(targetWeightKey(application, target))
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		cell.requestComplete = false
		return
	}
	updated, ok := checkedAddWeight(cell.requestRate, value)
	if !ok {
		cell.requestComplete = false
		return
	}
	cell.requestRate = updated
}

func buildFleetMatrix(
	rowLabels, columnLabels map[matrixAxisKey]string,
	cells map[matrixCellKey]*matrixCellAccumulator,
	sizeMetric SizeMetric,
	total, generation uint64,
) FleetMatrix {
	rowKeys := sortedMatrixAxes(rowLabels)
	columnKeys := sortedMatrixAxes(columnLabels)
	result := FleetMatrix{
		Rows:       matrixHeaders(rowKeys, rowLabels),
		Columns:    matrixHeaders(columnKeys, columnLabels),
		Cells:      make([]FleetMatrixCell, 0, len(cells)),
		Total:      total,
		Generation: generation,
	}

	cellKeys := make([]matrixCellKey, 0, len(cells))
	for key := range cells {
		cellKeys = append(cellKeys, key)
	}
	sort.Slice(cellKeys, func(i, j int) bool {
		if matrixAxisLess(&cellKeys[i].row, &cellKeys[j].row) {
			return true
		}
		if matrixAxisLess(&cellKeys[j].row, &cellKeys[i].row) {
			return false
		}
		return matrixAxisLess(&cellKeys[i].column, &cellKeys[j].column)
	})

	for index := range cellKeys {
		key := &cellKeys[index]
		aggregate := cells[*key]
		cell := FleetMatrixCell{
			RowID:            matrixAxisStableID(&key.row),
			ColumnID:         matrixAxisStableID(&key.column),
			ApplicationCount: aggregate.applicationCount,
			TargetCount:      aggregate.targetCount,
			Health:           orderedHealthBuckets(aggregate.health),
			ResourceWeight:   aggregate.resourceWeight,
		}
		if sizeMetric == SizeMetricRequestRate {
			cell.UsedResourceFallback = !aggregate.requestComplete
			if aggregate.requestComplete {
				cell.RequestRateWeight = aggregate.requestRate
			}
		}
		result.Cells = append(result.Cells, cell)
	}
	return result
}

func sortedMatrixAxes(labels map[matrixAxisKey]string) []matrixAxisKey {
	keys := make([]matrixAxisKey, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return matrixAxisLess(&keys[i], &keys[j]) })
	return keys
}

func matrixAxisLess(left, right *matrixAxisKey) bool {
	return mapGroupKeyLess(
		&mapGroupKey{dimension: left.dimension, object: left.object, value: left.value, canonical: left.canonical, order: left.order},
		&mapGroupKey{dimension: right.dimension, object: right.object, value: right.value, canonical: right.canonical, order: right.order},
	)
}

func matrixAxisStableID(key *matrixAxisKey) string {
	return mapGroupStableID(&mapGroupKey{dimension: key.dimension, canonical: key.canonical})
}

func matrixHeaders(keys []matrixAxisKey, labels map[matrixAxisKey]string) []FleetMatrixHeader {
	headers := make([]FleetMatrixHeader, 0, len(keys))
	for index := range keys {
		key := &keys[index]
		headers = append(headers, FleetMatrixHeader{
			StableID: matrixAxisStableID(key),
			Label:    labels[*key],
			Object:   key.object,
			Value:    key.value,
		})
	}
	return headers
}
