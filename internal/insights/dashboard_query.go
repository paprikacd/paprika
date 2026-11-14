package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
)

const dashboardQueryBudget = 22 * time.Second

// DashboardQueryResponseBytes caps the encoded structured result of query-dashboard at 130 KiB. The
// Observe gateway reads at most this many bytes of the response, so the two must stay equal. The cap
// was 128 KiB until the per-widget and top-level attention and the omitted list were added; see
// docs/design/insights/dashboard-query.md, Compatibility, for the measured decision.
const DashboardQueryResponseBytes = 130 << 10

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
	Start       string  `json:"start"`
	End         string  `json:"end"`
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
	// Attention is set only when this widget needs it: critical, warning, failed or stale.
	Attention string `json:"attention,omitempty"`
	// Breaches is set for time-series widgets with an author-declared warning or critical status.
	Breaches *DashboardBreaches `json:"breaches,omitempty"`
	// seriesCap is how many leading series the visualization draws, for band widgets.
	seriesCap int
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
	ctx, cancel := context.WithTimeout(r.Context(), dashboardQueryBudget)
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
	s.runDashboardPlan(r, &result, selected, saved, document.Variables, start, end, options)
	writeDashboardQueryResult(w, &result)
}

// runDashboardPlan plans the selected widgets and then executes their distinct
// queries one at a time, in order, filling result. queryDashboard and the dry run
// of the validate endpoint both call it, so they share planning, provider
// resolution, admission and the caller's deadline; neither has its own path.
func (s *Server) runDashboardPlan(r *http.Request, result *DashboardQueryResult, selected []dashboardReadWidget, saved map[string]dashboardSavedSnapshot, definitions []dashboardReadVariable, start, end float64, options DashboardSummaryOptions) {
	cache := dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}
	queries := planDashboardQueries(result, selected, saved, definitions, start, end, func(providerID, template string) *DashboardQueryError {
		provider, err := s.dashboardQueryProvider(r, providerID, &cache)
		if err != nil {
			return nil // Execution reports the cached provider failure as a signal.
		}
		if err := validateSQLTemplate(provider.public.Type, template); err != nil {
			return &DashboardQueryError{Code: "invalid_query", Message: err.Error()}
		}
		return nil
	})
	s.executeDashboardQueries(r, queries, options, result, &cache)
	budgetDashboardBreaches(result)
	result.Attention = applyDashboardAttention(result)
}

func planDashboardQueries(result *DashboardQueryResult, selected []dashboardReadWidget, saved map[string]dashboardSavedSnapshot, definitions []dashboardReadVariable, start, end float64, validators ...func(string, string) *DashboardQueryError) []Query {
	seenSaved := make(map[string]bool)
	queries := make([]Query, 0, len(selected))
	seenQueries := make(map[Query]string)
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
		query.Start, query.End, query.Step = start, end, result.Range.StepSeconds
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
		planDashboardAnnotation(widget, &output, result, saved, seenSaved, seenQueries, &queries, definitions, start, end, validators)
		result.Widgets = append(result.Widgets, output)
	}
	result.QueryCount.Planned = len(queries)
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
			// The freshness object. A stat's is the first contract's; a time series also gets one, which this release added.
			threshold := int(seconds)
			output.Freshness = &DashboardObservationFreshness{ThresholdSeconds: &threshold, State: "unknown"}
		}
	}
	dashboardWidgetBandOutput(&output, widget)
	return output
}

func planDashboardAnnotation(widget *dashboardReadWidget, output *DashboardQueryWidget, result *DashboardQueryResult, saved map[string]dashboardSavedSnapshot, seenSaved map[string]bool, seenQueries map[Query]string, queries *[]Query, definitions []dashboardReadVariable, start, end float64, validators []func(string, string) *DashboardQueryError) {
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
	eventQuery.Start, eventQuery.End, eventQuery.Step = start, end, result.Range.StepSeconds
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

func validatePlannedDashboardQuery(widget *dashboardReadWidget, query *Query, saved map[string]dashboardSavedSnapshot, validators []func(string, string) *DashboardQueryError) *DashboardQueryError {
	if len(validators) > 0 {
		template := widget.Query
		if widget.QueryRef != nil {
			template = saved[widget.QueryRef.ID].Query.Query
		}
		if failure := validators[0](query.ProviderID, template); failure != nil {
			return failure
		}
	}
	if validateQuery(query) != nil {
		return &DashboardQueryError{Code: "invalid_query", Message: "The resolved widget query is invalid."}
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
		writeError(w, http.StatusRequestEntityTooLarge, "dashboard result exceeds 130 KiB even without optional detail; select fewer widgets, series or history points")
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
	saved, err := s.dashboardSavedQuerySnapshot(selected)
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

func (s *Server) dashboardSavedQuerySnapshot(selected []dashboardReadWidget) (map[string]dashboardSavedSnapshot, error) {
	saved := make(map[string]dashboardSavedSnapshot)
	for i := range selected {
		widget := &selected[i]
		refs := []*dashboardReadReference{widget.QueryRef}
		if widget.AnnotationSource != nil {
			refs = append(refs, &widget.AnnotationSource.QueryRef)
		}
		for _, ref := range refs {
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
	}
	return saved, nil
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
		end = now.Truncate(time.Second)
		start = end.Add(-duration)
	}
	start, end = start.UTC().Truncate(time.Millisecond), end.UTC().Truncate(time.Millisecond)
	startSeconds, endSeconds := float64(start.UnixMilli())/1000, float64(end.UnixMilli())/1000
	step := math.Max(1, math.Ceil((endSeconds-startSeconds)/300))
	if err != nil || validateQueryRange(&Query{Kind: "metrics", Start: startSeconds, End: endSeconds, Step: step}) != nil {
		return DashboardQueryRange{}, 0, 0, errors.New("time range must use RFC3339 timestamps after the Unix epoch, increasing by at most 31 days")
	}
	return DashboardQueryRange{Start: start.Format(time.RFC3339Nano), End: end.Format(time.RFC3339Nano), StepSeconds: step}, startSeconds, endSeconds, nil
}

func (s *Server) executeDashboardQueries(r *http.Request, queries []Query, options DashboardSummaryOptions, result *DashboardQueryResult, caches ...*dashboardQueryProviders) {
	cache := &dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}
	if len(caches) > 0 {
		cache = caches[0]
	}
	for index := range queries {
		query := &queries[index]
		signal, executed, columns, raw := s.executeDashboardQuery(r, query, options, cache)
		signal.ID = fmt.Sprintf("q%d", index+1)
		signal.Kind = query.Kind
		// Do not disclose a provider selected by a saved query unless this
		// caller was authorized to resolve it. A denied provider still has a
		// signal kind and a sanitized execution error.
		if cache.clients[query.ProviderID] != nil {
			signal.ProviderID = query.ProviderID
		}
		for i := range result.Widgets {
			widget := &result.Widgets[i]
			applyDashboardSignal(widget, &signal, raw, query.End)
			applyDashboardAnnotation(widget, &signal, columns, result)
		}
		if executed {
			result.QueryCount.Executed++
		}
		if signal.Error != nil || signal.State == "partial" {
			result.State = "partial"
		} else if signal.State == "ok" && result.State != "partial" {
			result.State = "ok"
		}
		result.Signals = append(result.Signals, signal)
	}
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

type dashboardQueryProviders struct {
	clients map[string]*providerClient
	errors  map[string]error
}

func (s *Server) dashboardQueryProvider(r *http.Request, id string, cache *dashboardQueryProviders) (*providerClient, error) {
	if err := r.Context().Err(); err != nil {
		return nil, fmt.Errorf("dashboard query context: %w", err)
	}
	if err, known := cache.errors[id]; known {
		return nil, err
	}
	if provider, known := cache.clients[id]; known {
		return provider, nil
	}
	provider, err := s.resolveProvider(r, id)
	if err != nil {
		if r.Context().Err() != nil {
			err = fmt.Errorf("dashboard provider lookup: %w", r.Context().Err())
		}
		cache.errors[id] = err
	} else {
		cache.clients[id] = provider
	}
	return provider, err
}

// executeDashboardQuery returns the compact signal, the raw result when the provider
// answered (nil otherwise) and the record columns. The raw result is used once, by
// the widgets bound to this signal, and then dropped.
func (s *Server) executeDashboardQuery(r *http.Request, query *Query, options DashboardSummaryOptions, cache *dashboardQueryProviders) (DashboardSignal, bool, []dataframe.Column, *QueryResult) {
	provider, err := s.dashboardQueryProvider(r, query.ProviderID, cache)
	if err != nil {
		return DashboardSignal{State: "error", Error: dashboardProviderError(err)}, false, nil, nil
	}
	if !provider.public.supports(query.Kind) {
		return DashboardSignal{State: "error", Error: &DashboardQueryError{Code: "incompatible_provider", Message: "The provider does not support this widget's data kind."}}, false, nil, nil
	}
	raw, executed, err := s.runProviderQuery(r.Context(), provider, query)
	if err != nil {
		return DashboardSignal{State: "error", Error: dashboardProviderError(err)}, executed, nil, nil
	}
	// Compact before beginning another query; never retain all raw results.
	var columns []dataframe.Column
	if raw.Records != nil {
		columns = raw.Records.Columns
	}
	return summarizeDashboardResult(&raw, options), executed, columns, &raw
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

func dashboardProviderError(err error) *DashboardQueryError {
	switch {
	case errors.Is(err, context.Canceled):
		return &DashboardQueryError{Code: "canceled", Message: "Dashboard query execution was canceled."}
	case errors.Is(err, context.DeadlineExceeded):
		return &DashboardQueryError{Code: "timeout", Message: "The provider query exceeded its time budget."}
	case errors.Is(err, errQueryCapacity):
		return &DashboardQueryError{Code: "rate_limited", Message: "Query capacity is currently exhausted; retry shortly."}
	case errors.Is(err, ErrNotFound):
		return &DashboardQueryError{Code: "provider_not_found", Message: "The query provider is unavailable."}
	}
	var upstream *observeError
	if errors.As(err, &upstream) {
		switch upstream.status {
		case http.StatusForbidden, http.StatusUnauthorized:
			return &DashboardQueryError{Code: "forbidden", Message: "The caller cannot access the query provider."}
		case http.StatusTooManyRequests:
			return &DashboardQueryError{Code: "rate_limited", Message: "Query capacity is currently exhausted; retry shortly."}
		case http.StatusRequestTimeout, http.StatusGatewayTimeout:
			return &DashboardQueryError{Code: "timeout", Message: "The provider query exceeded its time budget."}
		case http.StatusBadRequest:
			return &DashboardQueryError{Code: "invalid_query", Message: "The provider rejected the resolved query."}
		}
	}
	// A direct provider's HTTP status is not carried in the code. The same
	// capacity and budget statuses are still marked transient for the dry run.
	return &DashboardQueryError{Code: "provider_error", Message: "The provider query could not be completed.", transient: directProviderTransient(err)}
}

// directProviderTransient reports whether a direct provider answered with a
// capacity, budget or gateway status, which a retry can clear. Prometheus answers
// 503 when a query times out or is aborted, so that is a retryable condition too.
func directProviderTransient(err error) bool {
	var direct *providerHTTPError
	if !errors.As(err, &direct) {
		return false
	}
	switch direct.status {
	case http.StatusTooManyRequests, http.StatusRequestTimeout, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}
