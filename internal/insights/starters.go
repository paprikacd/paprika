package insights

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"slices"
	"strings"
)

// starterFiles holds the first-party starter dashboards. Each file is a complete
// dashboard document whose id matches its file name without the .json extension.
//
//go:embed starters/*.json
var starterFiles embed.FS

// Starter is a first-party dashboard offered as a starting point. ID is the
// document's id, which is also its file name without the .json extension.
type Starter struct {
	ID       string
	Document Dashboard
}

// Starters returns the starter dashboards in file-name order. The documents are
// embedded in the binary, so only a broken build can make this fail. Each
// starter passes the save-time schema and lint rules; starters_test.go checks that.
func Starters() ([]Starter, error) {
	entries, err := fs.ReadDir(starterFiles, "starters")
	if err != nil {
		return nil, fmt.Errorf("read starters: %w", err)
	}
	starters := make([]Starter, 0, len(entries))
	for _, entry := range entries {
		data, err := starterFiles.ReadFile("starters/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read starter %s: %w", entry.Name(), err)
		}
		starters = append(starters, Starter{ID: strings.TrimSuffix(entry.Name(), ".json"), Document: data})
	}
	return starters, nil
}

// StarterSummary describes a starter in the picker without its document. Variables
// and Providers list what a viewer must supply: the dashboard variables a query
// reads, and the data kinds (metrics, records or traces) a provider must offer.
// Tiles is the widget layout, so the picker can draw a thumbnail.
type StarterSummary struct {
	ID          string        `json:"id"`
	Title       string        `json:"title"`
	Description string        `json:"description"`
	WidgetCount int           `json:"widgetCount"`
	Variables   []string      `json:"variables"`
	Providers   []string      `json:"providers"`
	Tiles       []StarterTile `json:"tiles"`
}

// StarterTile is one widget's grid rectangle and type.
type StarterTile struct {
	Type string `json:"type"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// starterBundleKind is the portable bundle kind that the browser's import review
// reads. A starter bundle is one dashboard and no saved queries.
const starterBundleKind = "PaprikaDashboardLibrary"

// starterBundle is the portable bundle a starter is served as. The browser runs it
// through the same import review as a file, so nothing is written by the endpoint.
type starterBundle struct {
	Kind          string            `json:"kind"`
	SchemaVersion int               `json:"schemaVersion"`
	Dashboards    []json.RawMessage `json:"dashboards"`
}

// starterShape is the part of a starter document the summary reads.
type starterShape struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Variables   []struct {
		Name string `json:"name"`
	} `json:"variables"`
	Widgets []struct {
		Type     string `json:"type"`
		DataKind string `json:"dataKind"`
		Layout   struct {
			X int `json:"x"`
			Y int `json:"y"`
			W int `json:"w"`
			H int `json:"h"`
		} `json:"layout"`
	} `json:"widgets"`
}

// summarizeStarter reads one embedded starter. Its document is known to pass the
// save-time schema, so an unreadable shape is a build fault.
func summarizeStarter(starter Starter) (StarterSummary, error) {
	var shape starterShape
	if err := json.Unmarshal(starter.Document, &shape); err != nil {
		return StarterSummary{}, fmt.Errorf("starter %s: %w", starter.ID, err)
	}
	summary := StarterSummary{
		ID:          starter.ID,
		Title:       shape.Title,
		Description: shape.Description,
		WidgetCount: len(shape.Widgets),
		Variables:   make([]string, 0, len(shape.Variables)),
		Providers:   []string{},
		Tiles:       make([]StarterTile, 0, len(shape.Widgets)),
	}
	for _, variable := range shape.Variables {
		summary.Variables = append(summary.Variables, variable.Name)
	}
	for _, widget := range shape.Widgets {
		kind := widget.DataKind
		if kind == "" {
			kind = "metrics"
		}
		if !slices.Contains(summary.Providers, kind) {
			summary.Providers = append(summary.Providers, kind)
		}
		summary.Tiles = append(summary.Tiles, StarterTile{Type: widget.Type, X: widget.Layout.X, Y: widget.Layout.Y, W: widget.Layout.W, H: widget.Layout.H})
	}
	slices.Sort(summary.Providers)
	return summary, nil
}

// findStarter returns the embedded starter with the given id.
func findStarter(id string) (Starter, bool, error) {
	starters, err := Starters()
	if err != nil {
		return Starter{}, false, err
	}
	index := slices.IndexFunc(starters, func(starter Starter) bool { return starter.ID == id })
	if index < 0 {
		return Starter{}, false, nil
	}
	return starters[index], true, nil
}

// starterDocument returns the document of a starter, or nil when it is absent.
// The schema examples use it, so a missing starter drops the example, not the response.
func starterDocument(id string) json.RawMessage {
	starter, found, err := findStarter(id)
	if err != nil || !found {
		return nil
	}
	return starter.Document
}

// listStarters serves GET /api/starters. Starters are read-only first-party
// documents, so reading them needs the same authentication as reading dashboards.
func (s *Server) listStarters(w http.ResponseWriter, r *http.Request) {
	starters, err := Starters()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "starters are unavailable")
		return
	}
	summaries := make([]StarterSummary, 0, len(starters))
	for _, starter := range starters {
		summary, err := summarizeStarter(starter)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "starters are unavailable")
			return
		}
		summaries = append(summaries, summary)
	}
	writeCollectionJSON(w, r, map[string]any{"starters": summaries})
}

// getStarter serves GET /api/starters/{id} as a portable bundle. The bundle is a
// starting point for the import review; this endpoint never writes a dashboard.
func (s *Server) getStarter(w http.ResponseWriter, r *http.Request) {
	starter, found, err := findStarter(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "starters are unavailable")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "starter not found")
		return
	}
	writeCollectionJSON(w, r, starterBundle{
		Kind:          starterBundleKind,
		SchemaVersion: 1,
		Dashboards:    []json.RawMessage{starter.Document},
	})
}
