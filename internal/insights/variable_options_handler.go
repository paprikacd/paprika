package insights

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

// dashboardVariableSourceBudget bounds the variable source fetches of one read. They run after the widgets,
// so they never delay a widget, and a source that cannot start in time is reported not_run.
const dashboardVariableSourceBudget = 6 * time.Second

// maxVariableOptionNames bounds the variables one variable-options request names.
const maxVariableOptionNames = 20

// maxVariableOptionsBytes bounds the variable-options request body.
const maxVariableOptionsBytes = 32 << 10

// variableOptionsRequest is the body of POST /api/dashboards/{id}/variable-options. Every field is optional:
// without variables the defaults apply, without names every sourced variable resolves, and without a range
// the dashboard's own range applies.
type variableOptionsRequest struct {
	Variables map[string]variablevalue.Value `json:"variables"`
	Names     []string                       `json:"names"`
	Start     string                         `json:"start"`
	End       string                         `json:"end"`
}

// dashboardVariableOptions resolves the query-backed choices of a dashboard's sourced variables for the given
// values and range. It serves API clients; the console resolves the same sources itself.
func (s *Server) dashboardVariableOptions(w http.ResponseWriter, r *http.Request) {
	var request variableOptionsRequest
	if err := decodeBody(w, r, &request, maxVariableOptionsBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid variable options request; body must be one JSON object up to 32 KiB")
		return
	}
	if len(request.Names) > maxVariableOptionNames {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("names must name at most %d variables", maxVariableOptionNames))
		return
	}
	input := dashboardQueryRequest{ID: r.PathValue("id")}
	document, etag, saved, _, err := s.dashboardQuerySnapshot(&input)
	if err != nil {
		storeError(w, err)
		return
	}
	values, err := dashboardVariableValues(document.Variables, request.Variables)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_, start, end, err := dashboardQueryTimeRange(&dashboardQueryRequest{Start: request.Start, End: request.End}, &document, time.Now().UTC())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	only, err := sourcedVariableFilter(document.Variables, request.Names)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), DashboardQueryBudget)
	defer cancel()
	cache := &dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}
	outcomes, _ := s.resolveVariableSources(r.WithContext(ctx), dashboardVariableSourceBudget, document.Variables, values, saved, start, end, cache, only)
	bucketStart, bucketEnd := variableBucket(start, end)
	response := &insightsv1.VariableOptionsResponse{
		DashboardEtag: etag,
		RangeStart:    time.Unix(bucketStart, 0).UTC().Format(time.RFC3339),
		RangeEnd:      time.Unix(bucketEnd, 0).UTC().Format(time.RFC3339),
	}
	for i, definition := range document.Variables {
		if !outcomes[i].sourced {
			continue
		}
		current, hasCurrent := values[definition.Name]
		response.Variables = append(response.Variables, variableOptionsMessage(definition.Name, &outcomes[i], current, hasCurrent))
	}
	body, err := checkwire.Marshal(response)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not encode variable options")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body) //nolint:errcheck // The response has started; a failed connection cannot be recovered.
}

// sourcedVariableFilter returns the set of variables to resolve when a request names some, or nil for all.
// Every name must be a declared variable with a source.
func sourcedVariableFilter(definitions []dashboardReadVariable, names []string) (map[string]bool, error) {
	if len(names) == 0 {
		return nil, nil
	}
	only := make(map[string]bool, len(names))
	for _, name := range names {
		index := slices.IndexFunc(definitions, func(definition dashboardReadVariable) bool { return definition.Name == name })
		if index < 0 || definitions[index].Source == nil {
			return nil, errors.New("names must name dashboard variables that declare a source")
		}
		only[name] = true
	}
	return only, nil
}

// variableOptionsMessage is one sourced variable's response entry. The current value is reported only for a
// resolved variable; it is kept in the list, and marked, when it is absent from a complete list.
func variableOptionsMessage(name string, outcome *variableSourceOutcome, current variablevalue.Value, hasCurrent bool) *insightsv1.VariableOptions {
	message := &insightsv1.VariableOptions{
		Name:          name,
		State:         variableOptionsStateOf(outcome.state),
		Values:        outcome.values,
		Truncated:     outcome.truncated,
		CurrentValue:  insightsv1.CurrentValue_CURRENT_VALUE_NONE,
		NeedsVariable: outcome.needsVariable,
	}
	if outcome.failure != nil {
		message.ErrorCode = outcome.failure.Code
	}
	if hasCurrent && (outcome.state == "ready" || outcome.state == "empty") {
		state, missing := currentValueReport(outcome.values, outcome.truncated, current)
		message.CurrentValue = currentValueOf(state)
		message.MissingValues = missing
		if current.List {
			message.CurrentValues = current.Items
		}
	}
	return message
}

func variableOptionsStateOf(state string) insightsv1.VariableOptionsState {
	switch state {
	case "ready":
		return insightsv1.VariableOptionsState_VARIABLE_OPTIONS_STATE_READY
	case "empty":
		return insightsv1.VariableOptionsState_VARIABLE_OPTIONS_STATE_EMPTY
	case "failed":
		return insightsv1.VariableOptionsState_VARIABLE_OPTIONS_STATE_FAILED
	case "needs_variable":
		return insightsv1.VariableOptionsState_VARIABLE_OPTIONS_STATE_NEEDS_VARIABLE
	case "not_run":
		return insightsv1.VariableOptionsState_VARIABLE_OPTIONS_STATE_NOT_RUN
	}
	return insightsv1.VariableOptionsState_VARIABLE_OPTIONS_STATE_UNSPECIFIED
}

// currentValueOf maps the state word of currentValueReport to the proto enum.
func currentValueOf(state string) insightsv1.CurrentValue {
	switch state {
	case "in_values":
		return insightsv1.CurrentValue_CURRENT_VALUE_IN_VALUES
	case "not_in_values":
		return insightsv1.CurrentValue_CURRENT_VALUE_NOT_IN_VALUES
	case "unknown":
		return insightsv1.CurrentValue_CURRENT_VALUE_UNKNOWN
	}
	return insightsv1.CurrentValue_CURRENT_VALUE_NONE
}
