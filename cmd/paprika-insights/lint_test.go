package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const cleanDocument = `{"schemaVersion":1,"id":"clean","title":"Clean","timeRange":"1h","refreshInterval":30,"widgets":[{"id":"a","title":"A","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4}}]}`

const overlappingDocument = `{"schemaVersion":1,"id":"overlap","title":"Overlap","timeRange":"1h","refreshInterval":30,"widgets":[{"id":"a","title":"A","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4}},{"id":"b","title":"B","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":{"x":4,"y":0,"w":6,"h":4}}]}`

// warningDocument is schema-valid and has one warning, which must not fail a run.
const warningDocument = `{"schemaVersion":1,"id":"warn","title":"Warn","timeRange":"1h","refreshInterval":30,"widgets":[{"id":"a","title":"A","type":"stat","providerId":"prometheus","query":"up","unit":"%","layout":{"x":0,"y":0,"w":4,"h":2},"options":{"showStatBar":true,"min":0,"max":100,"showSparkline":true}}]}`

func writeLintFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runLintCommand(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := runLint(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestLintExitCodes(t *testing.T) {
	dir := t.TempDir()
	clean := filepath.Join(dir, "clean")
	overlap := filepath.Join(dir, "overlap")
	warn := filepath.Join(dir, "warn")
	for _, sub := range []string{clean, overlap, warn} {
		if err := os.Mkdir(sub, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeLintFile(t, clean, "clean.json", cleanDocument)
	writeLintFile(t, overlap, "overlap.json", overlappingDocument)
	writeLintFile(t, warn, "warn.json", warningDocument)
	empty := filepath.Join(dir, "empty")
	if err := os.Mkdir(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	broken := writeLintFile(t, dir, "broken.json", `{"schemaVersion":`)
	notJSON := writeLintFile(t, dir, "notes.json", `hello`)

	cases := []struct {
		name string
		args []string
		code int
	}{
		{"clean documents pass", []string{clean}, 0},
		{"warnings alone pass", []string{warn}, 0},
		{"an error-level finding fails", []string{overlap}, 1},
		{"an error among clean files fails", []string{clean, overlap}, 1},
		{"no arguments is a usage error", nil, 2},
		{"a missing path is a usage error", []string{filepath.Join(dir, "nope")}, 2},
		{"an empty directory is a usage error", []string{empty}, 2},
		{"malformed JSON is a usage error", []string{broken}, 2},
		{"a file that is not a document is a usage error", []string{notJSON}, 2},
		{"the served examples pass", []string{"--served-schema-examples"}, 0},
		{"an unknown flag is a usage error", []string{"--nope", clean}, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code, _, _ := runLintCommand(t, tc.args...); code != tc.code {
				t.Fatalf("exit = %d, want %d", code, tc.code)
			}
		})
	}
}

func TestLintPrintsFindingsAndASummary(t *testing.T) {
	dir := t.TempDir()
	path := writeLintFile(t, dir, "overlap.json", overlappingDocument)
	code, stdout, _ := runLintCommand(t, path)
	if code != 1 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout, `error layout.overlap at /widgets/1/layout: "B" (b) overlaps "A" (a)`) {
		t.Fatalf("stdout = %q", stdout)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	// The overlap also leaves cells above widget b, so a hole warning follows the error.
	if got := lines[len(lines)-1]; got != "paprika-insights lint: 1 documents, 1 errors, 1 warnings, 0 info" {
		t.Fatalf("summary = %q", got)
	}
}

func TestLintCountsWarningsWithoutFailing(t *testing.T) {
	dir := t.TempDir()
	path := writeLintFile(t, dir, "warn.json", warningDocument)
	code, stdout, _ := runLintCommand(t, path)
	if code != 0 {
		t.Fatalf("exit = %d, stdout %q", code, stdout)
	}
	if !strings.Contains(stdout, "warning stat.density") || !strings.Contains(stdout, "warning stat.compact-bar") {
		t.Fatalf("stdout = %q", stdout)
	}
	// The stat is compact with a bar and a sparkline, so both stat rules fire.
	if !strings.Contains(stdout, "paprika-insights lint: 1 documents, 0 errors, 2 warnings, 0 info") {
		t.Fatalf("stdout = %q", stdout)
	}
}

// A repository-examples catalog is checked through its sample and live dashboards.
func TestLintReadsCatalogSampleAndLiveDashboards(t *testing.T) {
	dir := t.TempDir()
	catalog := `[{"id":"example-entry","sample":{"dashboards":[` + overlappingDocument + `]},"live":{"dashboards":[` + cleanDocument + `]}}]`
	path := writeLintFile(t, dir, "catalog.json", catalog)
	code, stdout, _ := runLintCommand(t, path)
	if code != 1 {
		t.Fatalf("exit = %d, stdout %q", code, stdout)
	}
	if !strings.Contains(stdout, "catalog.json[example-entry sample 0]: error layout.overlap") {
		t.Fatalf("stdout = %q", stdout)
	}
	if !strings.Contains(stdout, "2 documents") {
		t.Fatalf("stdout = %q", stdout)
	}
}

// The report is the same on every run, sample before live.
func TestLintReportIsDeterministic(t *testing.T) {
	dir := t.TempDir()
	catalog := `[{"id":"e","sample":{"dashboards":[` + warningDocument + `]},"live":{"dashboards":[` + warningDocument + `]}}]`
	path := writeLintFile(t, dir, "catalog.json", catalog)
	_, first, _ := runLintCommand(t, path)
	for range 5 {
		if _, again, _ := runLintCommand(t, path); again != first {
			t.Fatalf("report changed between runs:\n%s\n%s", first, again)
		}
	}
}
