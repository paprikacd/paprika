package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// variableValueLimit is the value count a source keeps when it declares no limit.
const variableValueLimit = 100

// variableValueMaxUnits is the longest value, in UTF-16 units, that a dashboard can hold.
const variableValueMaxUnits = 1024

// variableRangeBucketSeconds rounds a read's range outward to whole minutes, so that reads a few seconds
// apart share one resolved source. It matches the console's cache key.
const variableRangeBucketSeconds = 60

// variableSourceOutcome is how one declared variable resolved for a read. sourced is false for a variable
// without a source, which leaves every other field empty.
type variableSourceOutcome struct {
	state         string
	values        []string
	truncated     bool
	needsVariable string
	failure       *DashboardQueryError
	sourced       bool
}

// variableBucket returns the range in Unix seconds, rounded outward to the bucket. The end is always
// after the start, so a sub-minute range still resolves to one bucket.
func variableBucket(start, end float64) (bucketStart, bucketEnd int64) {
	bucketStart = int64(math.Floor(start/variableRangeBucketSeconds)) * variableRangeBucketSeconds
	bucketEnd = int64(math.Floor(end/variableRangeBucketSeconds)) * variableRangeBucketSeconds
	if bucketEnd <= bucketStart {
		bucketEnd = bucketStart + variableRangeBucketSeconds
	}
	return bucketStart, bucketEnd
}

// normalizeVariableValues removes duplicates, keeping the first occurrence, drops values that cannot be a
// dashboard value, and keeps at most limit. truncated reports that a value was dropped or the list was cut.
// It mirrors normalizeVariableValues in the console.
func normalizeVariableValues(raw []string, limit int) ([]string, bool) {
	seen := make(map[string]bool, len(raw))
	unique := 0
	fitting := make([]string, 0, len(raw))
	for _, value := range raw {
		if seen[value] {
			continue
		}
		seen[value] = true
		unique++
		if stringUnits(value) <= variableValueMaxUnits {
			fitting = append(fitting, value)
		}
	}
	truncated := len(fitting) != unique || len(fitting) > limit
	if len(fitting) > limit {
		fitting = fitting[:limit]
	}
	return fitting, truncated
}

// variableValuesFromResult extracts the distinct non-empty values of one records column or one series label.
// Trace results cannot supply values. Values are capped at variableValueLimit, as the console caps them.
func variableValuesFromResult(result *QueryResult, field string) (values []string, truncated bool, failure *DashboardQueryError) {
	if len(result.Traces) > 0 || len(result.Spans) > 0 {
		return nil, false, &DashboardQueryError{Code: "incompatible_saved_query", Message: "Trace results cannot supply variable values."}
	}
	var raw []string
	truncated = result.Truncated
	switch {
	case result.Records != nil:
		truncated = truncated || result.Records.Truncated
		raw, failure = recordValues(result.Records, field)
	case len(result.Series) > 0:
		raw, failure = seriesValues(result.Series, field)
	}
	if failure != nil {
		return nil, false, failure
	}
	var capped bool
	values, capped = normalizeVariableValues(raw, variableValueLimit)
	return values, truncated || capped, nil
}

// recordValues returns the non-empty text of one records column.
func recordValues(frame *dataframe.Frame, field string) ([]string, *DashboardQueryError) {
	index := slices.IndexFunc(frame.Columns, func(column dataframe.Column) bool { return column.Key == field })
	if index < 0 {
		return nil, invalidSourceField("The saved query does not return the source field.")
	}
	var raw []string
	for _, row := range frame.Rows {
		if index >= len(row) {
			continue
		}
		if text, ok := recordText(row[index]); ok && text != "" {
			raw = append(raw, text)
		}
	}
	return raw, nil
}

// recordText is a cell as the console reads it: a string, or a finite number written as String(n) would write it.
func recordText(cell any) (string, bool) {
	switch value := cell.(type) {
	case string:
		return value, true
	case float64:
		if !finite(value) {
			return "", false
		}
		// json.Marshal matches the console's String(n) for the numbers a dashboard can hold.
		encoded, err := json.Marshal(value)
		return string(encoded), err == nil
	}
	return "", false
}

// seriesValues returns the non-empty values of one series label.
func seriesValues(series []Series, field string) ([]string, *DashboardQueryError) {
	var raw []string
	labelled := false
	for _, item := range series {
		value, ok := item.Labels[field]
		if !ok {
			continue
		}
		labelled = true
		if value != "" {
			raw = append(raw, value)
		}
	}
	if !labelled {
		return nil, invalidSourceField("The saved query's series have no label for the source field.")
	}
	return raw, nil
}

func invalidSourceField(message string) *DashboardQueryError {
	return &DashboardQueryError{Code: "invalid_source_field", Message: message}
}

// variableSourceDependencies names the variables a source reads: the placeholders of its selector and the
// variable bindings of its saved query. Each name appears once, in first-seen order.
func variableSourceDependencies(source *dashboardReadVariableSource) []string {
	var names []string
	if source.Selector != nil {
		names = append(names, variableSourcePlaceholders(*source.Selector)...)
	}
	if source.QueryRef != nil {
		for _, binding := range source.QueryRef.Bindings {
			if binding.Source == "variable" {
				names = append(names, binding.Variable)
			}
		}
	}
	seen := make(map[string]bool, len(names))
	distinct := names[:0]
	for _, name := range names {
		if !seen[name] {
			seen[name] = true
			distinct = append(distinct, name)
		}
	}
	return distinct
}

// variableSourcePlaceholders returns the names inside each {{name}} of a template.
func variableSourcePlaceholders(template string) []string {
	var names []string
	for remaining := template; ; {
		start := strings.Index(remaining, "{{")
		if start < 0 {
			return names
		}
		end := strings.Index(remaining[start+2:], "}}")
		if end < 0 {
			return names
		}
		names = append(names, remaining[start+2:start+2+end])
		remaining = remaining[start+2+end+2:]
	}
}

// variableSourceJob is one distinct fetch. Sources that resolve to the same fetch share one job.
type variableSourceJob struct {
	providerID string
	run        func(ctx context.Context) (values []string, truncated, executed bool, failure *DashboardQueryError)
	values     []string
	truncated  bool
	failure    *DashboardQueryError
	notRun     bool
}

// preparedVariableSource is a source whose fetch is ready to run, with the key that identifies it.
type preparedVariableSource struct {
	key string
	job *variableSourceJob
}

// variableSourceEnv is what preparing a source reads: the read's request, document variables and values,
// saved query snapshots, provider cache and range bucket.
type variableSourceEnv struct {
	request     *http.Request
	definitions []dashboardReadVariable
	values      map[string]string
	typed       map[string]any
	types       map[string]string
	saved       map[string]dashboardSavedSnapshot
	cache       *dashboardQueryProviders
	bucketStart int64
	bucketEnd   int64
}

// resolveVariableSources resolves every sourced variable against the current values and range. Each variable
// is resolved in declaration order: a missing parent gives needs_variable, and a request that fails gives a
// failure. Distinct fetches run once, within the read's limits, and all of them share budget. only, when set,
// names the variables to resolve; others get no outcome. The second result counts the fetches, and is nil
// when no variable has a source.
func (s *Server) resolveVariableSources(r *http.Request, budget time.Duration, definitions []dashboardReadVariable, values map[string]string, saved map[string]dashboardSavedSnapshot, start, end float64, cache *dashboardQueryProviders, only map[string]bool) ([]variableSourceOutcome, *DashboardComparisonCount) {
	outcomes := make([]variableSourceOutcome, len(definitions))
	ctx, cancel := context.WithTimeout(r.Context(), budget)
	defer cancel()
	bucketStart, bucketEnd := variableBucket(start, end)
	env := newVariableSourceEnv(r.WithContext(ctx), definitions, values, saved, cache, bucketStart, bucketEnd)
	jobs, jobOf, count, sourced := s.planVariableSources(&env, only, outcomes)
	if !sourced {
		return outcomes, nil
	}
	s.runVariableSourceJobs(ctx, jobs, &count)
	for i := range definitions {
		if jobOf[i] >= 0 {
			outcomes[i] = outcomeFromVariableJob(&definitions[i], jobs[jobOf[i]])
		}
	}
	return outcomes, &count
}

func newVariableSourceEnv(request *http.Request, definitions []dashboardReadVariable, values map[string]string, saved map[string]dashboardSavedSnapshot, cache *dashboardQueryProviders, bucketStart, bucketEnd int64) variableSourceEnv {
	types := make(map[string]string, len(definitions))
	for _, definition := range definitions {
		types[definition.Name] = "string"
	}
	typed := make(map[string]any, len(values))
	for name, value := range values {
		typed[name] = value
	}
	return variableSourceEnv{request: request, definitions: definitions, values: values, typed: typed, types: types, saved: saved, cache: cache, bucketStart: bucketStart, bucketEnd: bucketEnd}
}

// planVariableSources resolves the sources that need no fetch and collects the distinct fetches of the rest.
// jobOf maps each variable to its job, or -1. sourced reports whether any variable has a source.
func (s *Server) planVariableSources(env *variableSourceEnv, only map[string]bool, outcomes []variableSourceOutcome) (jobs []*variableSourceJob, jobOf []int, count DashboardComparisonCount, sourced bool) {
	jobOf = make([]int, len(env.definitions))
	index := make(map[string]int)
	for i := range env.definitions {
		jobOf[i] = -1
		definition := &env.definitions[i]
		if definition.Source == nil || (only != nil && !only[definition.Name]) {
			continue
		}
		sourced = true
		outcomes[i].sourced = true
		used, missing := variableSourceInputs(definition.Source, env.values)
		if missing != "" {
			outcomes[i] = variableSourceOutcome{state: "needs_variable", needsVariable: missing, sourced: true}
			continue
		}
		prepared, failure := s.prepareVariableSource(env, definition.Source, used)
		if failure != nil {
			outcomes[i] = variableSourceOutcome{state: "failed", failure: failure, sourced: true}
			continue
		}
		position, known := index[prepared.key]
		if !known {
			position = len(jobs)
			index[prepared.key] = position
			jobs = append(jobs, prepared.job)
			count.Planned++
		}
		jobOf[i] = position
	}
	return jobs, jobOf, count, sourced
}

// variableSourceInputs returns the values a source reads, or the first parent it needs and does not have.
func variableSourceInputs(source *dashboardReadVariableSource, values map[string]string) (used map[string]string, missing string) {
	used = make(map[string]string)
	for _, name := range variableSourceDependencies(source) {
		value, ok := values[name]
		if !ok {
			return nil, name
		}
		used[name] = value
	}
	return used, ""
}

// runVariableSourceJobs runs each distinct fetch within the read's limits and the budget ctx. A fetch the budget
// ends before it starts is marked not_run. Executed counts the fetches that were admitted.
func (s *Server) runVariableSourceJobs(ctx context.Context, jobs []*variableSourceJob, count *DashboardComparisonCount) {
	if len(jobs) == 0 {
		return
	}
	var merge sync.Mutex
	run := func(k int) {
		fetched, truncated, executed, failure := jobs[k].run(ctx)
		merge.Lock()
		defer merge.Unlock()
		if executed {
			count.Executed++
		}
		jobs[k].values, jobs[k].truncated, jobs[k].failure = fetched, truncated, failure
	}
	multiProvider := false
	for _, job := range jobs {
		if job.providerID != jobs[0].providerID {
			multiProvider = true
			break
		}
	}
	limits := newDashboardLimits(s.dashboardParallelism, multiProvider, s.dashboardExtra)
	tasks := runDashboardBounded(ctx, len(jobs), func(k int) string { return jobs[k].providerID }, limits, run)
	for k := range tasks {
		switch {
		case tasks[k].Panicked != nil:
			jobs[k].failure = classifyQueryFailure(tasks[k].Panicked)
		case !tasks[k].Started:
			jobs[k].notRun = true
		}
	}
}

// outcomeFromVariableJob turns a finished fetch into the variable's outcome, capped at the source's limit.
func outcomeFromVariableJob(definition *dashboardReadVariable, job *variableSourceJob) variableSourceOutcome {
	outcome := variableSourceOutcome{sourced: true}
	switch {
	case job.notRun:
		outcome.state = "not_run"
	case job.failure != nil:
		outcome.state, outcome.failure = "failed", job.failure
	default:
		limit := variableValueLimit
		if definition.Source.Limit != nil {
			limit = *definition.Source.Limit
		}
		capped, cut := normalizeVariableValues(job.values, limit)
		outcome.values, outcome.truncated, outcome.state = capped, job.truncated || cut, "ready"
		if len(capped) == 0 {
			outcome.state = "empty"
		}
	}
	return outcome
}

// prepareVariableSource builds the fetch of one source for the current values. It resolves the provider and
// the template but does no provider I/O. A failure here is the variable's outcome and is never retried.
func (s *Server) prepareVariableSource(env *variableSourceEnv, source *dashboardReadVariableSource, used map[string]string) (preparedVariableSource, *DashboardQueryError) {
	switch source.Type {
	case "labelValues":
		return s.prepareLabelValues(env, source, used)
	case "savedQuery":
		return s.prepareSavedQuery(env, source, used)
	}
	return preparedVariableSource{}, &DashboardQueryError{Code: "invalid_source", Message: "The variable source type is not supported."}
}

func (s *Server) prepareLabelValues(env *variableSourceEnv, source *dashboardReadVariableSource, used map[string]string) (preparedVariableSource, *DashboardQueryError) {
	provider, err := s.dashboardQueryProvider(env.request, source.ProviderID, env.cache)
	if err != nil {
		return preparedVariableSource{}, classifyQueryFailure(err)
	}
	if provider.public.Type != "prometheus" && provider.public.Type != "tempo" {
		return preparedVariableSource{}, &DashboardQueryError{Code: "incompatible_provider", Message: "Label values need a Prometheus or Tempo provider."}
	}
	selector, failure := variableSelector(source.Selector, env, provider.public.Type)
	if failure != nil {
		return preparedVariableSource{}, failure
	}
	start, end, label := env.bucketStart, env.bucketEnd, source.Label
	return preparedVariableSource{
		key: variableSourceKey("labelValues", source.ProviderID, label, selector, used, start, end),
		job: &variableSourceJob{providerID: source.ProviderID, run: func(ctx context.Context) ([]string, bool, bool, *DashboardQueryError) {
			release, err := s.acquireQuery(ctx)
			if err != nil {
				return nil, false, false, classifyQueryFailure(err)
			}
			defer release()
			result, err := provider.metadata(ctx, &metadataQuery{Kind: "values", Label: label, Selector: selector, Start: start, End: end})
			if err != nil {
				return nil, false, true, classifyQueryFailure(err)
			}
			return result.Values, result.Truncated, true, nil
		}},
	}, nil
}

// variableSelector expands a source's selector for the current values. An empty selector needs no expansion.
func variableSelector(selector *string, env *variableSourceEnv, providerType string) (string, *DashboardQueryError) {
	if selector == nil {
		return "", nil
	}
	expanded, err := interpolateDashboardLiterals(*selector, env.types, env.typed)
	if err != nil {
		return "", &DashboardQueryError{Code: "invalid_query", Message: "The selector cannot be resolved for the current variable values."}
	}
	if expanded != "" && providerType != "prometheus" {
		return "", &DashboardQueryError{Code: "incompatible_provider", Message: "A series selector needs a Prometheus provider."}
	}
	return expanded, nil
}

func (s *Server) prepareSavedQuery(env *variableSourceEnv, source *dashboardReadVariableSource, used map[string]string) (preparedVariableSource, *DashboardQueryError) {
	if source.QueryRef == nil {
		return preparedVariableSource{}, &DashboardQueryError{Code: "missing_saved_query", Message: "The referenced saved query is unavailable."}
	}
	snapshot, ok := env.saved[source.QueryRef.ID]
	if !ok {
		return preparedVariableSource{}, &DashboardQueryError{Code: "missing_saved_query", Message: "The referenced saved query is unavailable."}
	}
	provider, err := s.dashboardQueryProvider(env.request, snapshot.Query.ProviderID, env.cache)
	if err != nil {
		return preparedVariableSource{}, classifyQueryFailure(err)
	}
	if !provider.public.supports(snapshot.Query.Kind) {
		return preparedVariableSource{}, &DashboardQueryError{Code: "incompatible_provider", Message: "The provider does not support this variable's data kind."}
	}
	expression, err := resolveDashboardSavedQuery(&snapshot.Query, *source.QueryRef, used)
	if err != nil {
		return preparedVariableSource{}, &DashboardQueryError{Code: "invalid_bindings", Message: "Saved query parameters or bindings are missing or invalid."}
	}
	if templateErr := validateSQLTemplate(provider.public.Type, expression); templateErr != nil {
		return preparedVariableSource{}, &DashboardQueryError{Code: "invalid_query", Message: templateErr.Error()}
	}
	query := Query{ProviderID: snapshot.Query.ProviderID, Kind: snapshot.Query.Kind, Query: expression, Start: float64(env.bucketStart), End: float64(env.bucketEnd)}
	if query.Kind == "metrics" {
		query.Step = policyStepSeconds(float64(env.bucketEnd-env.bucketStart), provider.public.MinStepSeconds)
	}
	if queryErr := validateQuery(&query); queryErr != nil {
		return preparedVariableSource{}, &DashboardQueryError{Code: "invalid_query", Message: queryErr.Error()}
	}
	field := source.Field
	return preparedVariableSource{
		key: variableSourceKey("savedQuery", snapshot.Query.ID, query.ProviderID, expression, field, used, env.bucketStart, env.bucketEnd),
		job: &variableSourceJob{providerID: query.ProviderID, run: s.savedQueryVariableRun(provider, &query, field)},
	}, nil
}

// savedQueryVariableRun runs a saved query for a variable and reads its field. The admitted flag is the
// admission, not provider I/O, as in runProviderQuery.
func (s *Server) savedQueryVariableRun(provider *providerClient, query *Query, field string) func(ctx context.Context) ([]string, bool, bool, *DashboardQueryError) {
	return func(ctx context.Context) ([]string, bool, bool, *DashboardQueryError) {
		raw, executed, err := s.runProviderQuery(ctx, provider, query)
		if err != nil {
			return nil, false, executed, classifyQueryFailure(err)
		}
		values, truncated, failure := variableValuesFromResult(&raw, field)
		if failure != nil {
			return nil, false, executed, failure
		}
		return values, truncated, executed, nil
	}
}

// dashboardVariableSourceBytes caps the encoded value text query_dashboard reports for all sourced variables of
// one result. Values past it are counted in valuesOmitted.
const dashboardVariableSourceBytes = 16 << 10

// applyVariableSourceOptions fills each sourced variable's sourceOptions. Values share the byte budget in
// declaration order. currentValue is computed on the full list, before the budget.
func applyVariableSourceOptions(result *DashboardQueryResult) {
	budget := dashboardVariableSourceBytes
	for i := range result.VariableDefinitions {
		if i >= len(result.variableSources) || !result.variableSources[i].sourced {
			continue
		}
		outcome := &result.variableSources[i]
		definition := &result.VariableDefinitions[i]
		options := &DashboardVariableSourceOptions{State: outcome.state, Truncated: outcome.truncated, NeedsVariable: outcome.needsVariable, Error: outcome.failure}
		if outcome.state == "ready" || outcome.state == "empty" {
			if current, ok := result.Variables[definition.Name]; ok {
				options.CurrentValue = currentValueText(outcome.values, outcome.truncated, current)
			}
			budget = appendValuesWithinBudget(options, outcome.values, budget)
		}
		definition.SourceOptions = options
	}
}

// appendValuesWithinBudget appends values to options while they fit in budget, and returns the budget left. The
// values that do not fit are counted in valuesOmitted.
func appendValuesWithinBudget(options *DashboardVariableSourceOptions, values []string, budget int) int {
	for j, value := range values {
		cost := encodedStringBytes(value) + 1 // The comma that separates it from the previous value.
		if cost > budget {
			options.ValuesOmitted = len(values) - j
			return budget
		}
		budget -= cost
		options.Values = append(options.Values, value)
	}
	return budget
}

// currentValueText says whether a current value is among a resolved list. A value absent from a truncated list
// is unknown, because the list may hold it past the cut.
func currentValueText(values []string, truncated bool, current string) string {
	if slices.Contains(values, current) {
		return "in_values"
	}
	if truncated {
		return "unknown"
	}
	return "not_in_values"
}

// dashboardSourceValueWarnings names an override of a sourced variable that its source did not return. Only a
// complete list is checked: a truncated list may hold the value past the cut. An empty override is named by
// dashboardVariableWarnings, so it is not named again here.
func dashboardSourceValueWarnings(definitions []dashboardReadVariable, overrides map[string]string, outcomes []variableSourceOutcome) []string {
	var warnings []string
	for i := range definitions {
		definition := &definitions[i]
		value, overridden := overrides[definition.Name]
		if !overridden || value == "" || definition.Source == nil || i >= len(outcomes) {
			continue
		}
		outcome := &outcomes[i]
		if outcome.state != "ready" || outcome.truncated || slices.Contains(outcome.values, value) {
			continue
		}
		warnings = append(warnings, fmt.Sprintf("%s=%s is not one of the values its source returned", definition.Name, warningValue(value)))
	}
	return warnings
}

// variableSourceKey identifies one fetch. Sources that share a key share one fetch.
func variableSourceKey(parts ...any) string {
	encoded, err := json.Marshal(parts)
	if err != nil {
		return fmt.Sprint(parts...) // Unreachable for strings, numbers and string maps; fmt keeps the key distinct.
	}
	return string(encoded)
}
