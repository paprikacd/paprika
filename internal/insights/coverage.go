package insights

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// A dashboard's covers member says which applications it is for. The
// application-dashboards lookup returns the dashboards that cover one
// application, most specific first.

const (
	maxCoveredApplications     = 16
	maxCoverageNameLength      = 253
	maxCoverageNamespaceLength = 63
	maxApplicationDashboards   = 8
)

var coverageNamePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

const coverageMessage = "covers must list one to 16 applications with lowercase namespace and name values, map declared variables to namespace or name, and name a widget for summaryWidget"

// coverageApplication is one covers entry. A nil member matches any value.
type coverageApplication struct {
	Namespace *string `json:"namespace"`
	Name      *string `json:"name"`
}

// coverageCovers is the covers member of a stored document.
type coverageCovers struct {
	Applications  []coverageApplication `json:"applications"`
	Variables     map[string]string     `json:"variables"`
	SummaryWidget string                `json:"summaryWidget"`
}

// coverageVariable is the part of a declared variable the lookup reads.
type coverageVariable struct {
	Name    string   `json:"name"`
	Options []string `json:"options"`
}

// coverageStored is the part of a stored document the lookup reads.
type coverageStored struct {
	ID        string             `json:"id"`
	Title     string             `json:"title"`
	Folder    string             `json:"folder"`
	Variables []coverageVariable `json:"variables"`
	Covers    *coverageCovers    `json:"covers"`
}

func validCoverageName(value string, limit int) bool {
	return len(value) <= limit && coverageNamePattern.MatchString(value)
}

// validateDashboardCovers checks the covers member. root is the whole document,
// so the variable mapping and the summary widget are checked against the
// declared variables and the widgets.
func validateDashboardCovers(raw json.RawMessage, root map[string]json.RawMessage) error {
	fields, err := requireObjectShape(raw, []string{"applications"}, []string{"variables", "summaryWidget"})
	if err != nil {
		return err
	}
	if err := validateCoverageApplications(fields["applications"]); err != nil {
		return in("applications", err)
	}
	if raw, ok := fields["variables"]; ok {
		if err := validateCoverageVariables(raw, root); err != nil {
			return in("variables", err)
		}
	}
	if raw, ok := fields["summaryWidget"]; ok {
		return validateCoverageSummary(raw, root)
	}
	return nil
}

// validateCoverageApplications checks the bounded applications array. Its errors are relative to the array.
func validateCoverageApplications(raw json.RawMessage) error {
	applications, total, err := boundedArray(raw, maxCoveredApplications+1)
	if err != nil || len(applications) == 0 || total > maxCoveredApplications {
		return errors.New(coverageMessage)
	}
	for i, item := range applications {
		if err := validateCoverageApplication(item); err != nil {
			return in(strconv.Itoa(i), err)
		}
	}
	return nil
}

// validateCoverageApplication accepts an object whose namespace and name, when
// present, are lowercase names. An omitted member matches any value.
func validateCoverageApplication(item json.RawMessage) error {
	fields, err := requireObjectShape(item, nil, []string{"namespace", "name"})
	if err != nil {
		return err
	}
	for _, member := range []struct {
		name  string
		limit int
	}{{"namespace", maxCoverageNamespaceLength}, {"name", maxCoverageNameLength}} {
		raw, ok := fields[member.name]
		if !ok {
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || !validCoverageName(value, member.limit) {
			return fieldErr(member.name, coverageMessage)
		}
	}
	return nil
}

// validateCoverageVariables checks that each key is a declared variable and each
// value says which application part it takes.
func validateCoverageVariables(raw json.RawMessage, root map[string]json.RawMessage) error {
	var mapping map[string]string
	if json.Unmarshal(raw, &mapping) != nil || mapping == nil {
		return errors.New(coverageMessage)
	}
	declared := declaredVariableNames(root)
	for _, key := range slices.Sorted(maps.Keys(mapping)) {
		if !declared[key] {
			return fieldErr(key, "Map only declared dashboard variables")
		}
		if value := mapping[key]; value != "namespace" && value != "name" {
			return fieldErr(key, `Map a variable to "namespace" or "name"`)
		}
	}
	return nil
}

// validateCoverageSummary checks that summaryWidget names a widget on the dashboard.
func validateCoverageSummary(raw json.RawMessage, root map[string]json.RawMessage) error {
	var id string
	if json.Unmarshal(raw, &id) != nil || !validID.MatchString(id) || !slices.Contains(widgetIDs(root), id) {
		return fieldErr("summaryWidget", "summaryWidget must name a widget on this dashboard")
	}
	return nil
}

func declaredVariableNames(root map[string]json.RawMessage) map[string]bool {
	names := map[string]bool{}
	var variables []struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(root["variables"], &variables) == nil {
		for _, variable := range variables {
			names[variable.Name] = true
		}
	}
	return names
}

func widgetIDs(root map[string]json.RawMessage) []string {
	var widgets []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(root["widgets"], &widgets) != nil {
		return nil
	}
	ids := make([]string, 0, len(widgets))
	for _, widget := range widgets {
		ids = append(ids, widget.ID)
	}
	return ids
}

// coverageSpecificity returns the best score of the entries that match namespace and name, and false when none match.
func coverageSpecificity(applications []coverageApplication, namespace, name string) (uint32, bool) {
	var best uint32
	found := false
	for _, application := range applications {
		if score, ok := applicationScore(application, namespace, name); ok && (!found || score > best) {
			best, found = score, true
		}
	}
	return best, found
}

// applicationScore scores one entry: 1 for a namespace it names, 2 for a name it names.
func applicationScore(application coverageApplication, namespace, name string) (uint32, bool) {
	var score uint32
	if application.Namespace != nil {
		if *application.Namespace != namespace {
			return 0, false
		}
		score++
	}
	if application.Name != nil {
		if *application.Name != name {
			return 0, false
		}
		score += 2
	}
	return score, true
}

// coverageValues maps each declared variable to the application part its mapping names. A value
// outside the variable's options is left out: it would be ignored when the link opens.
func coverageValues(variables []coverageVariable, mapping map[string]string, namespace, name string) map[string]string {
	values := map[string]string{}
	for _, variable := range variables {
		part, mapped := mapping[variable.Name]
		if !mapped {
			continue
		}
		value := namespace
		if part == "name" {
			value = name
		}
		if variable.Options != nil && !slices.Contains(variable.Options, value) {
			continue
		}
		values[variable.Name] = value
	}
	return values
}

// coverageMatch reports the lookup entry for a stored document that covers
// namespace and name. Its specificity is the best matching covers entry: 3 for a
// namespace and name, 2 for a name, 1 for a namespace, 0 for an entry that
// matches every application.
func coverageMatch(document []byte, namespace, name string) (*insightsv1.ApplicationDashboard, bool) {
	var doc coverageStored
	if json.Unmarshal(document, &doc) != nil || doc.Covers == nil {
		return nil, false
	}
	specificity, ok := coverageSpecificity(doc.Covers.Applications, namespace, name)
	if !ok {
		return nil, false
	}
	return &insightsv1.ApplicationDashboard{
		Id:              doc.ID,
		Title:           doc.Title,
		Folder:          doc.Folder,
		Variables:       coverageValues(doc.Variables, doc.Covers.Variables, namespace, name),
		SummaryWidgetId: doc.Covers.SummaryWidget,
		Specificity:     specificity,
	}, true
}

// listApplicationDashboards answers GET /api/application-dashboards. Both query
// parameters name an application, and both are required.
func (s *Server) listApplicationDashboards(w http.ResponseWriter, r *http.Request) {
	namespace := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if !validCoverageName(namespace, maxCoverageNamespaceLength) || !validCoverageName(name, maxCoverageNameLength) {
		writeError(w, http.StatusBadRequest, "namespace and name must be application names")
		return
	}
	matches := []*insightsv1.ApplicationDashboard{}
	for _, document := range s.store.List() {
		if match, ok := coverageMatch(document, namespace, name); ok {
			matches = append(matches, match)
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.Specificity != b.Specificity {
			return a.Specificity > b.Specificity
		}
		if a.Title != b.Title {
			return a.Title < b.Title
		}
		return a.Id < b.Id
	})
	truncated := len(matches) > maxApplicationDashboards
	if truncated {
		matches = matches[:maxApplicationDashboards]
	}
	data, err := checkwire.Marshal(&insightsv1.ApplicationDashboardList{Dashboards: matches, Truncated: truncated})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "application dashboards failed")
		return
	}
	writeCollectionJSON(w, r, json.RawMessage(data))
}
