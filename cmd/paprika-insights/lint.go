package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// maxLintFileBytes bounds one input file. A saved document is at most 256 KiB,
// and a catalog holds many documents, so 16 MiB is generous and still bounded.
const maxLintFileBytes = 16 << 20

// Exit codes. A CI step fails only on exitFindings; exitUsage covers inputs
// that could not be read, so an empty or broken input never passes silently.
const (
	exitClean    = 0
	exitFindings = 1
	exitUsage    = 2
)

// lintInput is one dashboard document to check, named for the report.
type lintInput struct {
	name     string
	document insights.Dashboard
}

// runLint implements `paprika-insights lint`. It checks dashboard documents with
// the same schema and lint findings a save reports, prints each finding, and
// returns the exit code. Inputs are JSON files or directories of them. A file
// may hold one document, an array of documents, or a repository-examples
// catalog, whose sample and live dashboards are checked.
func runLint(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("lint", flag.ContinueOnError)
	flags.SetOutput(stderr)
	served := flags.Bool("served-schema-examples", false, "also check the dashboard and widget examples the schema endpoint serves")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	errOut := &lineWriter{w: stderr}
	if len(flags.Args()) == 0 && !*served {
		errOut.linef("usage: paprika-insights lint [--served-schema-examples] PATH...")
		return exitUsage
	}
	inputs, err := gatherLintInputs(flags.Args(), *served)
	if err != nil {
		errOut.linef("paprika-insights lint: %v", err)
		return exitUsage
	}
	if len(inputs) == 0 {
		errOut.linef("paprika-insights lint: no dashboard documents found")
		return exitUsage
	}
	return reportLint(inputs, stdout)
}

// gatherLintInputs reads every path and, when asked, the served examples.
func gatherLintInputs(paths []string, served bool) ([]lintInput, error) {
	var inputs []lintInput
	for _, path := range paths {
		found, err := collectLintInputs(path)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, found...)
	}
	if !served {
		return inputs, nil
	}
	for i, example := range insights.DashboardSchemaExamples() {
		inputs = append(inputs, lintInput{name: fmt.Sprintf("served dashboard example %d", i), document: example})
	}
	widgets, err := insights.WidgetSchemaExamples()
	if err != nil {
		return nil, fmt.Errorf("served widget examples: %w", err)
	}
	for i, example := range widgets {
		inputs = append(inputs, lintInput{name: fmt.Sprintf("served widget example %d", i), document: example})
	}
	return inputs, nil
}

// lineWriter writes lines and remembers the first write error, so a closed
// pipe is reported once through the exit code rather than per line.
type lineWriter struct {
	w   io.Writer
	err error
}

func (l *lineWriter) linef(format string, args ...any) {
	if l.err != nil {
		return
	}
	_, l.err = fmt.Fprintf(l.w, format+"\n", args...)
}

// reportLint checks each input and prints its findings, then a summary line.
// The exit code is exitUsage when the report cannot be written.
func reportLint(inputs []lintInput, stdout io.Writer) int {
	out := &lineWriter{w: stdout}
	var errorCount, warningCount, infoCount int
	for _, input := range inputs {
		for _, finding := range insights.CheckDocument(input.document) {
			switch finding.GetSeverity() {
			case insightsv1.Severity_SEVERITY_ERROR:
				errorCount++
			case insightsv1.Severity_SEVERITY_WARNING:
				warningCount++
			case insightsv1.Severity_SEVERITY_UNSPECIFIED, insightsv1.Severity_SEVERITY_INFO:
				infoCount++
			}
			out.linef("%s", formatLintFinding(input.name, finding))
		}
	}
	out.linef("paprika-insights lint: %d documents, %d errors, %d warnings, %d info", len(inputs), errorCount, warningCount, infoCount)
	if out.err != nil {
		return exitUsage
	}
	if errorCount > 0 {
		return exitFindings
	}
	return exitClean
}

// formatLintFinding renders one finding on one line. Producer text is escaped
// with checkwire.Printable, so a submitted key cannot start a new line.
func formatLintFinding(name string, finding *insightsv1.CheckFinding) string {
	pointer := finding.GetPointer()
	if pointer == "" {
		pointer = "(document)"
	}
	severity := strings.TrimPrefix(strings.ToLower(finding.GetSeverity().String()), "severity_")
	return fmt.Sprintf("%s: %s %s at %s: %s", checkwire.Printable(name), severity, checkwire.Printable(finding.GetRuleId()), checkwire.Printable(pointer), checkwire.Printable(finding.GetMessage()))
}

// collectLintInputs reads one path. A directory contributes its JSON files, in
// name order, and a file contributes its documents.
func collectLintInputs(path string) ([]lintInput, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if !info.IsDir() {
		return readLintFile(path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("read directory %s: %w", path, err)
	}
	var inputs []lintInput
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		found, err := readLintFile(filepath.Join(path, entry.Name()))
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, found...)
	}
	return inputs, nil
}

// readLintFile decodes one JSON file into documents. The JSON is decoded only
// far enough to tell a document, a document array and a catalog apart.
func readLintFile(path string) ([]lintInput, error) {
	data, err := readBoundedFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(data)
	if !json.Valid(trimmed) {
		return nil, fmt.Errorf("%s: not valid JSON", path)
	}
	switch {
	case bytes.HasPrefix(trimmed, []byte("[")):
		var elements []json.RawMessage
		if err := json.Unmarshal(trimmed, &elements); err != nil {
			return nil, fmt.Errorf("%s: not a JSON array: %w", path, err)
		}
		return documentsFromArray(path, elements)
	case bytes.HasPrefix(trimmed, []byte("{")):
		return []lintInput{{name: path, document: insights.Dashboard(trimmed)}}, nil
	default:
		return nil, fmt.Errorf("%s: not a JSON document or array", path)
	}
}

// documentsFromArray treats each element as a catalog entry when it has sample
// or live dashboards, and as a document otherwise.
func documentsFromArray(path string, elements []json.RawMessage) ([]lintInput, error) {
	var inputs []lintInput
	for i, element := range elements {
		var catalog struct {
			ID     string `json:"id"`
			Sample *struct {
				Dashboards []json.RawMessage `json:"dashboards"`
			} `json:"sample"`
			Live *struct {
				Dashboards []json.RawMessage `json:"dashboards"`
			} `json:"live"`
		}
		if err := json.Unmarshal(element, &catalog); err != nil {
			return nil, fmt.Errorf("%s[%d]: %w", path, i, err)
		}
		if catalog.Sample == nil && catalog.Live == nil {
			inputs = append(inputs, lintInput{name: fmt.Sprintf("%s[%d]", path, i), document: insights.Dashboard(element)})
			continue
		}
		// Sample before live, in a fixed order, so the report is the same on every run.
		for _, part := range []struct {
			name       string
			dashboards []json.RawMessage
		}{{"sample", dashboardsOf(catalog.Sample)}, {"live", dashboardsOf(catalog.Live)}} {
			for j, dashboard := range part.dashboards {
				inputs = append(inputs, lintInput{name: fmt.Sprintf("%s[%s %s %d]", path, catalog.ID, part.name, j), document: insights.Dashboard(dashboard)})
			}
		}
	}
	return inputs, nil
}

func dashboardsOf(part *struct {
	Dashboards []json.RawMessage `json:"dashboards"`
}) []json.RawMessage {
	if part == nil {
		return nil
	}
	return part.Dashboards
}

// readBoundedFile reads a file no larger than maxLintFileBytes.
func readBoundedFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if info.Size() > maxLintFileBytes {
		return nil, errors.New(path + ": file exceeds the lint size limit")
	}
	data, err := os.ReadFile(path) //nolint:gosec // The operator names the files to lint on the command line.
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}
