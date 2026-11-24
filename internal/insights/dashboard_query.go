package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/querystep"
)

// DashboardQueryBudget bounds one dashboard query end to end. It sits inside the
// API proxy and outside the gateway call, which is ordered by ObserveOperationTimeout.
const DashboardQueryBudget = 22 * time.Second

// DashboardQueryResponseBytes caps the encoded structured result of query-dashboard at 130 KiB. The
// Observe gateway reads at most this many bytes of the response, so the two must stay equal. The cap
// was 128 KiB until the per-widget and top-level attention and the omitted list were added; see
// docs/design/insights/dashboard-query.md, Compatibility, for the measured decision.
const DashboardQueryResponseBytes = 130 << 10

// dashboardResultCapText names the cap in KiB for the refusal message, derived from the constant so
// the message cannot drift from the cap it reports.
func dashboardResultCapText() string {
	return fmt.Sprintf("%d KiB", DashboardQueryResponseBytes>>10)
}

//nolint:tagliatelle // Observe MCP tool arguments use snake_case consistently.
type dashboardQueryRequest struct {
	ID            string            `json:"id"`
	Variables     map[string]string `json:"variables,omitempty"`
	WidgetIDs     []string          `json:"widget_ids,omitempty"`
	Start         string            `json:"start,omitempty"`
	End           string            `json:"end,omitempty"`
	HistoryPoints *int              `json:"history_points,omitempty"`
	MaxSeries     *int              `json:"max_series,omitempty"`
	MaxTraces     *int              `json:"max_traces,omitempty"`
}

// DashboardQueryResult executes persisted main and event annotation queries.
// Tooltip queries need a hovered observation and remain outside this scope.
type DashboardQueryResult struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Dashboard     DashboardQueryDocument   `json:"dashboard"`
	ObservedAt    string                   `json:"observedAt"`
	Range         DashboardQueryRange      `json:"range"`
	Variables     map[string]string        `json:"variables"`
	Widgets       []DashboardQueryWidget   `json:"widgets"`
	SavedQueries  []DashboardQueryDocument `json:"savedQueries"`
	Signals       []DashboardSignal        `json:"signals"`
	QueryCount    DashboardQueryCount      `json:"queryCount"`
	State         string                   `json:"state"`
	Attention     DashboardAttention       `json:"attention"`
	// comparisons and comparisonQueries plan the stats' earlier-window queries. They are not part of the wire form.
	comparisons       []dashboardComparisonPlan
	comparisonQueries []Query
	// variableSources is each declared variable's resolved source, index-aligned with the document's variables.
	variableSources []variableSourceOutcome
	// VariableDefinitions declares each dashboard variable with its label, default and static options, so an agent
	// can choose values without a get_dashboard read. Absent when the dashboard declares no variables.
	VariableDefinitions []DashboardQueryVariable `json:"variableDefinitions,omitempty"`
	// Warnings names inputs the call accepted but that may be wrong, such as an override outside declared options.
	// Absent when there are none. A warning never fails the call.
	Warnings []string `json:"warnings,omitempty"`
	// Omitted names, in the order applied, the optional detail dropped so the encoded result fits
	// DashboardQueryResponseBytes. Absent when nothing was dropped. See dashboardOmissionSteps.
	Omitted []string `json:"omitted,omitempty"`
}

type DashboardQueryDocument struct {
	ID    string `json:"id"`
	Title string `json:"title,omitempty"`
	ETag  string `json:"etag"`
}

type DashboardQueryRange struct {
	Start string `json:"start"`
	End   string `json:"end"`
	// StepSeconds is the step the shared policy chooses for the whole range, given the coarsest
	// provider minimum among the dashboard's metrics queries. A signal carries its own stepSeconds only
	// when it differs from this one.
	StepSeconds float64 `json:"stepSeconds"`
}

type DashboardQueryWidget struct {
	ID                     string                         `json:"id"`
	Title                  string                         `json:"title"`
	Type                   string                         `json:"type"`
	PluginID               string                         `json:"pluginId,omitempty"`
	DataKind               string                         `json:"dataKind,omitempty"`
	Unit                   string                         `json:"unit"`
	Decimals               *int                           `json:"decimals,omitempty"`
	Freshness              *DashboardObservationFreshness `json:"freshness,omitempty"`
	Threshold              *DashboardStatThreshold        `json:"threshold,omitempty"`
	SavedQueryID           string                         `json:"savedQueryId,omitempty"`
	AnnotationSavedQueryID string                         `json:"annotationSavedQueryId,omitempty"`
	thresholds             []dashboardReadThreshold
	SignalID               string                          `json:"signalId,omitempty"`
	Error                  *DashboardQueryError            `json:"error,omitempty"`
	AnnotationSignalID     string                          `json:"annotationSignalId,omitempty"`
	AnnotationError        *DashboardQueryError            `json:"annotationError,omitempty"`
	AnnotationColumns      *dashboardReadAnnotationColumns `json:"annotationColumns,omitempty"`
	// Sample reports the age of the widget's latest observation and whether a staleness
	// limit judges it. Every metric widget carries it, unless the result cap removes it. It
	// is the version-tolerant home of the staleness judgement; freshness is kept for clients
	// of the first contract.
	Sample *DashboardSample `json:"sample,omitempty"`
	// BandSeries names the series that set a multi-series band, and how many series the
	// visualization draws. It sits beside threshold so the band keeps its first-contract shape.
	BandSeries *DashboardBandSeries `json:"bandSeries,omitempty"`
	// Ranking is a record-table's ranking over its loaded rows, set only when the table declares rank.
	// Its worst row band sets threshold, so a ranked table counts toward attention. See DashboardRecordRanking.
	Ranking *DashboardRecordRanking `json:"ranking,omitempty"`
	// Attention is set only when this widget needs it: critical, warning, failed or stale.
	Attention string `json:"attention,omitempty"`
	// Breaches is set for time-series widgets with an author-declared warning or critical status.
	Breaches *DashboardBreaches `json:"breaches,omitempty"`
	// SLO is set for an slo-summary widget: its authored objective evaluated over the window.
	// It is a reading of the objective, not a health verdict, and it leaves threshold unchanged.
	SLO *DashboardSLO `json:"slo,omitempty"`
	// Comparison is a stat's change against its earlier window, when the stat declares one. See DashboardComparison.
	Comparison *DashboardComparison `json:"comparison,omitempty"`
	// seriesCap is how many leading series the visualization draws, for band widgets.
	seriesCap int
	// sloConfig is the validated objective of an slo-summary widget, set at planning.
	sloConfig *sloConfig
	// rankTable is a record-table's rank with the styles and thresholds it reads, set only when rank is declared.
	rankTable *dashboardRankedTable
}

// A configured visual band, not an inferred alert or service-health verdict.
// A stat is evaluated on its last valid observation, as displayed. Gauges, status
// views and heatmaps are evaluated per drawn series on its latest recorded sample;
// DashboardBandSeries names the series that set the band.
type DashboardStatThreshold struct {
	State    string   `json:"state"`
	Boundary *float64 `json:"boundary,omitempty"`
	Status   string   `json:"status,omitempty"`
	Color    string   `json:"color,omitempty"`
	Label    string   `json:"label,omitempty"`
}

// Freshness describes the latest valid returned sample relative to the query
// range end, not the underlying provider's scrape or ingestion health. Every metric
// widget reports its age. Only the widgets judgesStaleAfter names are judged against
// staleAfterSeconds; the others report the state no_threshold.
type DashboardObservationFreshness struct {
	ThresholdSeconds *int     `json:"thresholdSeconds,omitempty"`
	State            string   `json:"state"`
	LastTimestamp    *float64 `json:"lastTimestamp,omitempty"`
	AgeSeconds       *float64 `json:"ageSeconds,omitempty"`
}

type dashboardReadAnnotationColumns struct {
	Timestamp string `json:"timestamp"`
	End       string `json:"end,omitempty"`
	Label     string `json:"label"`
	Severity  string `json:"severity,omitempty"`
}

type DashboardQueryCount struct {
	Planned      int `json:"planned"`
	Executed     int `json:"executed"`
	Deduplicated int `json:"deduplicated"`
	// Cached counts the queries answered from the result cache without a provider request. They are not in Executed. Absent when none were.
	Cached int `json:"cached,omitempty"`
	// Comparison counts the earlier-window queries of stats that declare a comparison. Absent when none do.
	Comparison *DashboardComparisonCount `json:"comparison,omitempty"`
	// VariableOptions counts the variable source fetches: distinct fetches planned, and those executed. Absent when no
	// variable declares a source.
	VariableOptions *DashboardComparisonCount `json:"variableOptions,omitempty"`
}

type dashboardSavedSnapshot struct {
	Query SavedQuery
	ETag  string
}

func (s *Server) queryDashboard(w http.ResponseWriter, r *http.Request) {
	input, options, err := decodeDashboardQuery(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), DashboardQueryBudget)
	defer cancel()
	r = r.WithContext(ctx)
	document, etag, saved, selected, err := s.dashboardQuerySnapshot(&input)
	if err != nil {
		if errors.Is(err, errDashboardQuerySelection) {
			writeError(w, http.StatusBadRequest, err.Error())
		} else {
			storeError(w, err)
		}
		return
	}
	variables, err := dashboardVariableValues(document.Variables, input.Variables)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC()
	queryRange, start, end, err := dashboardQueryTimeRange(&input, &document, now)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result := DashboardQueryResult{
		SchemaVersion: 1, Dashboard: DashboardQueryDocument{ID: document.ID, Title: document.Title, ETag: etag},
		ObservedAt: now.Format(time.RFC3339Nano), Range: queryRange, Variables: variables,
		Widgets: make([]DashboardQueryWidget, 0, len(selected)), SavedQueries: []DashboardQueryDocument{}, Signals: []DashboardSignal{}, State: "empty",
	}
	result.VariableDefinitions = dashboardQueryVariables(document.Variables)
	result.Warnings = dashboardVariableWarnings(document.Variables, input.Variables)
	s.runDashboardPlan(r, &result, selected, saved, document.Variables, start, end, options)
	applyVariableSourceOptions(&result)
	result.Warnings = append(result.Warnings, dashboardSourceValueWarnings(document.Variables, input.Variables, result.variableSources)...)
	writeDashboardQueryResult(w, &result)
}

// runDashboardPlan plans the selected widgets and then executes their distinct
// queries within the read's parallelism limit, filling result in plan order.
// queryDashboard and the dry run of the validate endpoint both call it, so they
// share planning, provider resolution, admission and the caller's deadline;
// neither has its own path.
func (s *Server) runDashboardPlan(r *http.Request, result *DashboardQueryResult, selected []dashboardReadWidget, saved map[string]dashboardSavedSnapshot, definitions []dashboardReadVariable, start, end float64, options DashboardSummaryOptions) {
	cache := dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}
	minStep := func(providerID string) float64 {
		provider, err := s.dashboardQueryProvider(r, providerID, &cache)
		if err != nil {
			return 0 // Execution reports the cached provider failure as a signal.
		}
		return provider.public.MinStepSeconds
	}
	queries := planDashboardQueries(result, selected, saved, definitions, start, end, minStep, func(providerID, template string, slo bool) *DashboardQueryError {
		provider, err := s.dashboardQueryProvider(r, providerID, &cache)
		if err != nil {
			return nil // Execution reports the cached provider failure as a signal.
		}
		if slo && provider.public.Type != "prometheus" {
			return &DashboardQueryError{Code: "invalid_query", Message: "slo-summary widgets need a Prometheus provider."}
		}
		if err := validateSQLTemplate(provider.public.Type, template); err != nil {
			return &DashboardQueryError{Code: "invalid_query", Message: err.Error()}
		}
		return nil
	})
	if options.SkipComparisons {
		dropDashboardComparisons(result)
	}
	s.executeDashboardQueries(r, queries, options, result, &cache)
	outcomes, count := s.resolveVariableSources(r, dashboardVariableSourceBudget, definitions, result.Variables, saved, start, end, &cache, nil)
	result.variableSources, result.QueryCount.VariableOptions = outcomes, count
	appendVariableSavedQueries(result, definitions, saved)
	budgetDashboardBreaches(result)
	result.Attention = applyDashboardAttention(result)
}

// dashboardQueryValidator checks a planned query's provider and template. slo is set for
// slo-summary widgets, whose query is compiled from config and needs a Prometheus provider.
type dashboardQueryValidator func(providerID, template string, slo bool) *DashboardQueryError

// dashboardMinStep reports a provider's minimum metrics step by provider ID, zero when the provider
// is unknown or takes no step. The planner uses it so every query gets the step its provider can serve.
type dashboardMinStep func(providerID string) float64

// policyStepSeconds is the shared step policy for a span in seconds, with minStepSeconds as the floor.
// It is the step the UI and the gateway choose for the same range.
func policyStepSeconds(spanSeconds, minStepSeconds float64) float64 {
	step := querystep.For(time.Duration(spanSeconds*float64(time.Second)), querystep.DefaultTargetPoints, time.Duration(minStepSeconds*float64(time.Second)))
	return step.Seconds()
}

// dashboardWidgetStep is the query step for a widget. An slo-summary widget keeps its own step, which
// spans the range, so its range query returns only the window's start and end points. Every other
// widget takes the policy step for its provider's minimum.
func dashboardWidgetStep(widget *dashboardReadWidget, start, end, providerMinStep float64) float64 {
	if isSLOSummaryWidget(widget) {
		return sloStepSeconds(start, end)
	}
	return policyStepSeconds(end-start, providerMinStep)
}

func planDashboardQueries(result *DashboardQueryResult, selected []dashboardReadWidget, saved map[string]dashboardSavedSnapshot, definitions []dashboardReadVariable, start, end float64, minStep dashboardMinStep, validators ...dashboardQueryValidator) []Query {
	seenSaved := make(map[string]bool)
	queries := make([]Query, 0, len(selected))
	seenQueries := make(map[Query]string)
	seenComparisons := make(map[Query]int)
	coarsestMinStep := 0.0
	for i := range selected {
		widget := &selected[i]
		output := dashboardQueryWidgetOutput(widget)
		if widget.QueryRef != nil && !seenSaved[widget.QueryRef.ID] {
			if snapshot, found := saved[widget.QueryRef.ID]; found {
				result.SavedQueries = append(result.SavedQueries, DashboardQueryDocument{ID: widget.QueryRef.ID, ETag: snapshot.ETag})
				seenSaved[widget.QueryRef.ID] = true
			}
		}
		if widget.QueryRef != nil {
			output.SavedQueryID = widget.QueryRef.ID
		}
		query, resolutionError := resolveDashboardWidget(widget, saved, result.Variables, definitions)
		query.Start, query.End = start, end
		providerMinStep := minStep(query.ProviderID)
		query.Step = dashboardWidgetStep(widget, start, end, providerMinStep)
		coarsestMinStep = max(coarsestMinStep, providerMinStep)
		if resolutionError == nil {
			resolutionError = validatePlannedDashboardQuery(widget, &query, saved, validators)
		}

		if resolutionError != nil {
			output.Error = resolutionError
			result.State = "partial"
		} else if signalID, found := seenQueries[query]; found {
			output.SignalID = signalID
			result.QueryCount.Deduplicated++
		} else {
			output.SignalID = fmt.Sprintf("q%d", len(queries)+1)
			seenQueries[query] = output.SignalID
			queries = append(queries, query)
		}
		if resolutionError == nil {
			planDashboardComparison(result, len(result.Widgets), widget, &output, &query, seenComparisons)
		}
		planDashboardAnnotation(widget, &output, result, saved, seenSaved, seenQueries, &queries, definitions, start, end, minStep, validators)
		result.Widgets = append(result.Widgets, output)
	}
	result.QueryCount.Planned = len(queries)
	result.Range.StepSeconds = policyStepSeconds(end-start, coarsestMinStep)
	return queries
}

func dashboardQueryWidgetOutput(widget *dashboardReadWidget) DashboardQueryWidget {
	output := DashboardQueryWidget{ID: widget.ID, Title: widget.Title, Type: widget.Type, Unit: widget.Unit, Decimals: widget.Options.Decimals}
	if widget.Type == "plugin" {
		output.PluginID, output.DataKind = widget.PluginID, widget.DataKind
	}
	if dashboardWidgetKind(widget) == "metrics" {
		output.Sample = &DashboardSample{State: "unknown"}
		if judgesStaleAfter(widget.Type) && widget.Options.StaleAfterSeconds != nil {
			seconds := *widget.Options.StaleAfterSeconds
			output.Sample.Basis, output.Sample.StaleAfterSeconds = sampleBasisStaleAfter, &seconds
			// The freshness object. A stat's is the first contract's; a time series also gets one, added after the first contract.
			threshold := int(seconds)
			output.Freshness = &DashboardObservationFreshness{ThresholdSeconds: &threshold, State: "unknown"}
		}
	}
	dashboardWidgetBandOutput(&output, widget)
	if isSLOSummaryWidget(widget) {
		// An invalid config never reaches here: resolveSLOSummaryQuery refuses it at planning.
		if cfg, err := validateSLOSummaryConfig(widget.Config); err == nil {
			output.sloConfig = &cfg
		}
	}
	dashboardWidgetRankOutput(&output, widget)
	return output
}

func planDashboardAnnotation(widget *dashboardReadWidget, output *DashboardQueryWidget, result *DashboardQueryResult, saved map[string]dashboardSavedSnapshot, seenSaved map[string]bool, seenQueries map[Query]string, queries *[]Query, definitions []dashboardReadVariable, start, end float64, minStep dashboardMinStep, validators []dashboardQueryValidator) {
	source := widget.AnnotationSource
	if source == nil {
		return
	}
	output.AnnotationSavedQueryID = source.QueryRef.ID
	output.AnnotationColumns = &dashboardReadAnnotationColumns{Timestamp: source.TimestampColumn, End: source.EndColumn, Label: source.LabelColumn, Severity: source.SeverityColumn}
	if !seenSaved[source.QueryRef.ID] {
		if snapshot, found := saved[source.QueryRef.ID]; found {
			result.SavedQueries = append(result.SavedQueries, DashboardQueryDocument{ID: source.QueryRef.ID, ETag: snapshot.ETag})
			seenSaved[source.QueryRef.ID] = true
		}
	}
	eventWidget := &dashboardReadWidget{Type: "plugin", DataKind: "records", QueryRef: &source.QueryRef}
	eventQuery, eventError := resolveDashboardWidget(eventWidget, saved, result.Variables, definitions)
	eventQuery.Start, eventQuery.End = start, end
	eventQuery.Step = dashboardWidgetStep(eventWidget, start, end, minStep(eventQuery.ProviderID))
	if eventError == nil {
		eventError = validatePlannedDashboardQuery(eventWidget, &eventQuery, saved, validators)
	}
	if eventError != nil {
		output.AnnotationError = eventError
		result.State = "partial"
	} else if signalID, found := seenQueries[eventQuery]; found {
		output.AnnotationSignalID = signalID
		result.QueryCount.Deduplicated++
	} else {
		output.AnnotationSignalID = fmt.Sprintf("q%d", len(*queries)+1)
		seenQueries[eventQuery] = output.AnnotationSignalID
		*queries = append(*queries, eventQuery)
	}
}

func validatePlannedDashboardQuery(widget *dashboardReadWidget, query *Query, saved map[string]dashboardSavedSnapshot, validators []dashboardQueryValidator) *DashboardQueryError {
	if len(validators) > 0 {
		template := widget.Query
		if widget.QueryRef != nil {
			template = saved[widget.QueryRef.ID].Query.Query
		}
		if failure := validators[0](query.ProviderID, template, isSLOSummaryWidget(widget)); failure != nil {
			return failure
		}
	}
	if validateQuery(query) != nil {
		return &DashboardQueryError{Code: "invalid_query", Message: "The resolved widget query is invalid."}
	}
	if isSLOSummaryWidget(widget) && len(query.Query) > sloMaxQueryLength {
		return &DashboardQueryError{Code: "invalid_query", Message: "The slo-summary query is longer than 8192 characters after variables are expanded."}
	}
	return nil
}

func writeDashboardQueryResult(w http.ResponseWriter, result *DashboardQueryResult) {
	encoded, err := encodeDashboardQueryResult(result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "dashboard signals could not be encoded")
		return
	}
	if len(encoded) > DashboardQueryResponseBytes {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("dashboard result exceeds %s even without optional detail; select fewer widgets, series or history points", dashboardResultCapText()))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(encoded); err != nil {
		return // The client disconnected after headers; no replacement response is possible.
	}
}

func decodeDashboardQuery(w http.ResponseWriter, r *http.Request) (dashboardQueryRequest, DashboardSummaryOptions, error) {
	var input dashboardQueryRequest
	options := DashboardSummaryOptions{MaxSeries: 3, MaxTraces: 3}
	var raw json.RawMessage
	if err := decodeBody(w, r, &raw, 32<<10); err != nil {
		return input, options, errors.New("invalid dashboard query request; body must be one JSON object up to 32 KiB")
	}
	fields, err := requireObjectShape(raw, []string{"id"}, []string{"variables", "widget_ids", "start", "end", "history_points", "max_series", "max_traces"})
	if err != nil || json.Unmarshal(raw, &input) != nil || !validID.MatchString(input.ID) {
		return input, options, errors.New("invalid dashboard query fields")
	}
	if validationErr := validateDashboardQuerySelections(fields, input.WidgetIDs); validationErr != nil {
		return input, options, validationErr
	}
	if !validDashboardRequestedTimeRange(&input, fields) {
		return input, options, errors.New("start and end must both be provided as RFC3339 timestamps")
	}
	options, err = dashboardQueryOptions(&input)
	return input, options, err
}

func validDashboardRequestedTimeRange(input *dashboardQueryRequest, fields map[string]json.RawMessage) bool {
	if fields["start"] == nil && fields["end"] == nil {
		return true
	}
	return input.Start != "" && input.End != ""
}

func dashboardQueryOptions(input *dashboardQueryRequest) (DashboardSummaryOptions, error) {
	options := DashboardSummaryOptions{HistoryPoints: dashboardQueryOption(input.HistoryPoints, 0), MaxSeries: dashboardQueryOption(input.MaxSeries, 3), MaxTraces: dashboardQueryOption(input.MaxTraces, 3)}
	if options.HistoryPoints < 0 || options.HistoryPoints == 1 || options.HistoryPoints > 32 || options.MaxSeries < 1 || options.MaxSeries > 8 || options.MaxTraces < 1 || options.MaxTraces > 10 {
		return options, errors.New("history_points must be 0 or 2–32, max_series 1–8, and max_traces 1–10")
	}
	return options, nil
}

func dashboardQueryOption(value *int, fallback int) int {
	if value != nil {
		return *value
	}
	return fallback
}

func validateDashboardQuerySelections(fields map[string]json.RawMessage, widgetIDs []string) error {
	if variables, present := fields["variables"]; present {
		if err := validateDashboardQueryVariables(variables); err != nil {
			return err
		}
	}
	if _, present := fields["widget_ids"]; !present {
		return nil
	}
	if len(widgetIDs) < 1 || len(widgetIDs) > 48 {
		return errors.New("widget_ids must select between 1 and 48 unique widgets")
	}
	seen := make(map[string]bool, len(widgetIDs))
	for _, id := range widgetIDs {
		if !validID.MatchString(id) || seen[id] {
			return errors.New("widget_ids must select unique valid widget IDs")
		}
		seen[id] = true
	}
	return nil
}

func validateDashboardQueryVariables(variables json.RawMessage) error {
	var values map[string]json.RawMessage
	if json.Unmarshal(variables, &values) != nil || len(values) > 20 {
		return errors.New("variables must contain at most 20 string values")
	}
	for _, value := range values {
		if len(value) == 0 || value[0] != '"' {
			return errors.New("dashboard variable values must be strings")
		}
	}
	return nil
}

var errDashboardQuerySelection = errors.New("widget_ids must name widgets in the saved dashboard")

// Dashboard and referenced saved-query versions form one snapshot. No lock is
// retained while provider I/O runs, so the UI can continue editing documents.
func (s *Server) dashboardQuerySnapshot(input *dashboardQueryRequest) (snapshot dashboardReadDocument, version string, references map[string]dashboardSavedSnapshot, widgets []dashboardReadWidget, snapshotErr error) {
	s.mutations.Lock()
	defer s.mutations.Unlock()
	var document dashboardReadDocument
	raw, etag, err := s.store.Get(input.ID)
	if err != nil {
		return document, "", nil, nil, err
	}
	if decodeErr := json.Unmarshal(raw, &document); decodeErr != nil {
		return document, "", nil, nil, fmt.Errorf("decode saved dashboard snapshot: %w", decodeErr)
	}
	selected, err := selectDashboardQueryWidgets(document.Widgets, input.WidgetIDs)
	if err != nil {
		return document, "", nil, nil, err
	}
	saved, err := s.dashboardSavedQuerySnapshot(selected, document.Variables)
	return document, etag, saved, selected, err
}

func selectDashboardQueryWidgets(widgets []dashboardReadWidget, widgetIDs []string) ([]dashboardReadWidget, error) {
	selected := make([]dashboardReadWidget, 0, len(widgets))
	wanted := make(map[string]bool, len(widgetIDs))
	for _, id := range widgetIDs {
		wanted[id] = true
	}
	for i := range widgets {
		widget := &widgets[i]
		if len(widgetIDs) == 0 || wanted[widget.ID] {
			selected = append(selected, *widget)
			delete(wanted, widget.ID)
		}
	}
	if len(wanted) > 0 || len(selected) > 48 {
		return nil, errDashboardQuerySelection
	}
	return selected, nil
}

// dashboardSavedQuerySnapshot loads the saved queries the selected widgets, their annotations and the
// variable sources of the document refer to. A missing saved query is left out, so its use reports it.
func (s *Server) dashboardSavedQuerySnapshot(selected []dashboardReadWidget, variables []dashboardReadVariable) (map[string]dashboardSavedSnapshot, error) {
	saved := make(map[string]dashboardSavedSnapshot)
	for _, ref := range dashboardSavedQueryRefs(selected, variables) {
		if ref == nil {
			continue
		}
		if _, exists := saved[ref.ID]; exists {
			continue
		}
		raw, version, err := s.savedQueries.get(ref.ID)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		query, err := validateSavedQuery(ref.ID, raw)
		if err != nil {
			return nil, err
		}
		saved[query.ID] = dashboardSavedSnapshot{Query: query, ETag: version}
	}
	return saved, nil
}

// dashboardSavedQueryRefs lists the references of the selected widgets, their annotations and the variable sources.
// A nil reference is a widget without one.
func dashboardSavedQueryRefs(selected []dashboardReadWidget, variables []dashboardReadVariable) []*dashboardReadReference {
	var refs []*dashboardReadReference
	for i := range selected {
		widget := &selected[i]
		refs = append(refs, widget.QueryRef)
		if widget.AnnotationSource != nil {
			refs = append(refs, &widget.AnnotationSource.QueryRef)
		}
	}
	for i := range variables {
		if source := variables[i].Source; source != nil {
			refs = append(refs, source.QueryRef)
		}
	}
	return refs
}

// appendVariableSavedQueries lists the saved query of each variable source once, after the widgets' queries,
// so a caller can pin the versions a result read.
func appendVariableSavedQueries(result *DashboardQueryResult, definitions []dashboardReadVariable, saved map[string]dashboardSavedSnapshot) {
	for i := range definitions {
		source := definitions[i].Source
		if source == nil || source.QueryRef == nil {
			continue
		}
		snapshot, ok := saved[source.QueryRef.ID]
		if !ok || slices.ContainsFunc(result.SavedQueries, func(listed DashboardQueryDocument) bool { return listed.ID == source.QueryRef.ID }) {
			continue
		}
		result.SavedQueries = append(result.SavedQueries, DashboardQueryDocument{ID: source.QueryRef.ID, ETag: snapshot.ETag})
	}
}

func dashboardQueryTimeRange(input *dashboardQueryRequest, document *dashboardReadDocument, now time.Time) (window DashboardQueryRange, fromSeconds, toSeconds float64, rangeErr error) {
	var start, end time.Time
	var err error
	from, to := input.Start, input.End
	if from == "" && document.CustomTimeRange != nil {
		from, to = document.CustomTimeRange.From, document.CustomTimeRange.To
	}
	if from != "" {
		start, err = time.Parse(time.RFC3339Nano, from)
		if err == nil {
			end, err = time.Parse(time.RFC3339Nano, to)
		}
	} else {
		durations := map[string]time.Duration{"15m": 15 * time.Minute, "30m": 30 * time.Minute, "1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}
		duration, exists := durations[document.TimeRange]
		if !exists {
			err = errors.New("invalid saved dashboard range")
		}
		// The end is aligned to the grain of this range, so every viewer and query tool that reads the
		// same dashboard in the same grain asks for the same window.
		end = querystep.AlignEnd(now, duration)
		start = end.Add(-duration)
	}
	start, end = start.UTC().Truncate(time.Millisecond), end.UTC().Truncate(time.Millisecond)
	startSeconds, endSeconds := float64(start.UnixMilli())/1000, float64(end.UnixMilli())/1000
	// The range step is replaced once the planner knows its providers; this value only has to pass validation.
	step := policyStepSeconds(endSeconds-startSeconds, 0)
	if err != nil || validateQueryRange(&Query{Kind: "metrics", Start: startSeconds, End: endSeconds, Step: step}) != nil {
		return DashboardQueryRange{}, 0, 0, errors.New("time range must use RFC3339 timestamps after the Unix epoch, increasing by at most 31 days")
	}
	return DashboardQueryRange{Start: start.Format(time.RFC3339Nano), End: end.Format(time.RFC3339Nano), StepSeconds: step}, startSeconds, endSeconds, nil
}

// executeDashboardQueries runs the planned queries within the read's limits and fills result.Signals in
// plan order. Each outcome is merged under one lock. The merge does not depend on order: an outcome only
// touches the widgets bound to its own signal, the counts add up, and the state only moves to partial or
// ok. A query whose worker panics becomes an error signal and never fails its siblings.
func (s *Server) executeDashboardQueries(r *http.Request, queries []Query, options DashboardSummaryOptions, result *DashboardQueryResult, caches ...*dashboardQueryProviders) {
	cache := &dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}
	if len(caches) > 0 {
		cache = caches[0]
	}
	result.Signals = make([]DashboardSignal, len(queries))
	var merge sync.Mutex
	run := func(index int) {
		if s.dashboardFault != nil {
			s.dashboardFault("main", &queries[index])
		}
		signal, executed, columns, raw := s.executeDashboardQuery(r, &queries[index], options, cache)
		merge.Lock()
		defer merge.Unlock()
		applyDashboardQueryOutcome(result, index, &queries[index], options, cache, &signal, executed, columns, raw)
	}
	limits := newDashboardLimits(s.dashboardParallelism, dashboardQueriesSpanProviders(queries), s.dashboardExtra)
	tasks := runDashboardBounded(r.Context(), len(queries), func(i int) string { return queries[i].ProviderID }, limits, run)
	for index := range tasks {
		switch {
		case tasks[index].Panicked != nil:
			// The worker is gone and reported no outcome, so the panic becomes this signal's error. Its
			// raw result is never used. The panic value is not reported, because it can carry provider detail.
			merge.Lock()
			applyDashboardQueryOutcome(result, index, &queries[index], options, cache, &DashboardSignal{State: "error", Error: classifyQueryFailure(tasks[index].Panicked)}, false, nil, nil)
			merge.Unlock()
		case !tasks[index].Started:
			// The context ended before this query started. Running it now reports the context error
			// without provider I/O, which is what the serial path did for the remaining queries.
			run(index)
		}
	}
	s.executeDashboardComparisons(r, options, result, cache, limits)
}

// applyDashboardSignalStep discloses a metrics signal's step only where it differs from the range's, so a
// dashboard whose providers share one minimum keeps the compact result it had. A query that was never
// dispatched and failed carries none: its planned step came from a provider that could not be resolved.
func applyDashboardSignalStep(result *DashboardQueryResult, query *Query, executed bool, signal *DashboardSignal) {
	if query.Kind != "metrics" || query.Step == result.Range.StepSeconds || (!executed && signal.Error != nil) {
		return
	}
	step := query.Step
	signal.StepSeconds = &step
}

// applyDashboardQueryOutcome merges one query's outcome into result at its plan position. The caller holds
// the merge lock.
func applyDashboardQueryOutcome(result *DashboardQueryResult, index int, query *Query, options DashboardSummaryOptions, cache *dashboardQueryProviders, signal *DashboardSignal, executed bool, columns []dataframe.Column, raw *QueryResult) {
	signal.ID = fmt.Sprintf("q%d", index+1)
	captureDashboardComparisons(result, signal.ID, raw)
	signal.Kind = query.Kind
	applyDashboardSignalStep(result, query, executed, signal)
	// Do not disclose a provider selected by a saved query unless this
	// caller was authorized to resolve it. A denied provider still has a
	// signal kind and a sanitized execution error.
	if cache.hasClient(query.ProviderID) {
		signal.ProviderID = query.ProviderID
	}
	for i := range result.Widgets {
		widget := &result.Widgets[i]
		applyDashboardSignal(widget, signal, raw, query.End, options.MaxSeries)
		applyDashboardAnnotation(widget, signal, columns, result)
	}
	if executed {
		result.QueryCount.Executed++
	}
	if signal.Cached {
		result.QueryCount.Cached++
	}
	if signal.Error != nil || signal.State == "partial" {
		result.State = "partial"
	} else if signal.State == "ok" && result.State != "partial" {
		result.State = "ok"
	}
	result.Signals[index] = *signal
}

// dashboardQueriesSpanProviders reports whether the planned queries name more than one provider.
func dashboardQueriesSpanProviders(queries []Query) bool {
	for i := range queries {
		if queries[i].ProviderID != queries[0].ProviderID {
			return true
		}
	}
	return false
}

func dashboardPrimaryObservation(signal *DashboardSignal, requireValue bool) *Point {
	if signal.Error != nil || signal.PrimarySeries == nil {
		return nil
	}
	for index := range signal.Series {
		series := &signal.Series[index]
		if series.Index != *signal.PrimarySeries || series.Last == nil {
			continue
		}
		if requireValue && series.Last.Value == nil {
			continue
		}
		return series.Last
	}
	return nil
}

func applyDashboardAnnotation(widget *DashboardQueryWidget, signal *DashboardSignal, columns []dataframe.Column, result *DashboardQueryResult) {
	if widget.AnnotationSignalID != signal.ID || widget.AnnotationColumns == nil {
		return
	}
	failure := signal.Error
	if failure == nil {
		failure = validateAnnotationColumns(columns, widget.AnnotationColumns)
	}
	if failure != nil {
		widget.AnnotationError = failure
		result.State = "partial"
	}
}

// dashboardQueryProviders holds the providers one read resolved. Queries of a read run concurrently, so the
// maps are guarded by mu. Resolution itself runs outside mu.
type dashboardQueryProviders struct {
	mu      sync.Mutex
	clients map[string]*providerClient
	errors  map[string]error
}

// hasClient reports whether the provider with this ID resolved for the read.
func (c *dashboardQueryProviders) hasClient(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.clients[id] != nil
}

func (s *Server) dashboardQueryProvider(r *http.Request, id string, cache *dashboardQueryProviders) (*providerClient, error) {
	if err := r.Context().Err(); err != nil {
		return nil, fmt.Errorf("dashboard query context: %w", err)
	}
	cache.mu.Lock()
	cachedErr, known := cache.errors[id]
	cachedClient, resolved := cache.clients[id]
	cache.mu.Unlock()
	if known {
		return nil, cachedErr
	}
	if resolved {
		return cachedClient, nil
	}
	// Planning resolves every provider before execution, so this is normally a cache hit. Two queries
	// that miss together may both resolve the same provider; the results are the same and the last write wins.
	provider, err := s.resolveProvider(r, id)
	if err != nil {
		if r.Context().Err() != nil {
			err = fmt.Errorf("dashboard provider lookup: %w", r.Context().Err())
		}
		cache.mu.Lock()
		cache.errors[id] = err
		cache.mu.Unlock()
	} else {
		cache.mu.Lock()
		cache.clients[id] = provider
		cache.mu.Unlock()
	}
	return provider, err
}

// executeDashboardQuery returns the compact signal, the raw result when the provider
// answered (nil otherwise) and the record columns. The raw result is used once, by
// the widgets bound to this signal, and then dropped.
func (s *Server) executeDashboardQuery(r *http.Request, query *Query, options DashboardSummaryOptions, cache *dashboardQueryProviders) (DashboardSignal, bool, []dataframe.Column, *QueryResult) {
	provider, err := s.dashboardQueryProvider(r, query.ProviderID, cache)
	if err != nil {
		return DashboardSignal{State: "error", Error: classifyQueryFailure(err)}, false, nil, nil
	}
	if !provider.public.supports(query.Kind) {
		return DashboardSignal{State: "error", Error: &DashboardQueryError{Code: "incompatible_provider", Message: "The provider does not support this widget's data kind."}}, false, nil, nil
	}
	raw, executed, err := s.runProviderQuery(r.Context(), provider, query)
	latency := dashboardSignalLatency(executed, raw.Diagnostics)
	if err != nil {
		return DashboardSignal{State: "error", LatencyMs: latency, Error: classifyQueryFailure(err)}, executed, nil, nil
	}
	// Compact before beginning another query; never retain all raw results.
	var columns []dataframe.Column
	if raw.Records != nil {
		columns = raw.Records.Columns
	}
	signal := summarizeDashboardResult(&raw, options)
	signal.LatencyMs = latency
	signal.Cached = raw.Diagnostics.servedFromCache()
	return signal, executed, columns, &raw
}

// dashboardSignalLatency is the receipt's total: the time from asking for Insights admission to the gateway's
// answer. It includes the admission wait and gateway queueing. It is nil when the query was not admitted,
// because no gateway work then happened. A cache hit or join was not admitted either, but its receipt still
// records how long the answer took to come back, so its latency is kept.
func dashboardSignalLatency(admitted bool, diagnostics *QueryDiagnostics) *int64 {
	if diagnostics == nil || (!admitted && !diagnostics.servedFromCache()) {
		return nil
	}
	latency := max(int64(math.Round(diagnostics.TotalMs)), 0)
	return &latency
}

func validateAnnotationColumns(columns []dataframe.Column, mapping *dashboardReadAnnotationColumns) *DashboardQueryError {
	for _, required := range []struct {
		name      string
		timestamp bool
	}{{mapping.Timestamp, true}, {mapping.End, true}, {mapping.Label, false}, {mapping.Severity, false}} {
		if required.name == "" {
			continue
		}
		found := annotationColumnIndex(columns, required.name)
		if found < 0 {
			return &DashboardQueryError{Code: "invalid_annotation_columns", Message: "The event query does not return a configured column."}
		}
		kind := columns[found].Type
		if !validAnnotationColumnType(kind, required.timestamp) {
			return &DashboardQueryError{Code: "invalid_annotation_columns", Message: "The event query returned an unsupported column type."}
		}
		if found >= 12 {
			return &DashboardQueryError{Code: "annotation_columns_truncated", Message: "Move event columns into the first 12 query columns for compact dashboard output."}
		}
	}
	return nil
}

func annotationColumnIndex(columns []dataframe.Column, name string) int {
	for index := range columns {
		if columns[index].Key == name {
			return index
		}
	}
	return -1
}

func validAnnotationColumnType(kind string, timestamp bool) bool {
	return kind == "string" || (timestamp && (kind == "number" || kind == "timestamp"))
}
