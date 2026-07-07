package investigator

import (
	"context"
	"strings"
	"testing"
)

// happyDetector always returns a fixed finding — used to verify the registry
// fan-out + sort by severity.
type happyDetector struct {
	id string
	sev Severity
	title string
}

func (d *happyDetector) ID() string { return d.id }
func (d *happyDetector) Severity() Severity { return d.sev }
func (d *happyDetector) Detect(ctx context.Context, in Input) ([]Finding, error) {
	return []Finding{{ID: d.id, Severity: d.sev, Title: d.title}}, nil
}

type happySource struct {
	name string
	ev   []Evidence
}
func (s *happySource) Name() string { return s.name }
func (s *happySource) Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error) {
	return s.ev, nil
}

type firstWinsNarrator struct {
	out Report
}
func (n *firstWinsNarrator) Name() string { return "first" }
func (n *firstWinsNarrator) Narrate(ctx context.Context, fs []Finding, ev []Evidence) (Report, error) {
	return n.out, nil
}

type errorNarrator struct{}
func (n *errorNarrator) Name() string { return "errors" }
func (n *errorNarrator) Narrate(ctx context.Context, fs []Finding, ev []Evidence) (Report, error) {
	return Report{}, errNarratorFail
}

var errNarratorFail = narratorFailErr("synthetic failure")

type narratorFailErr string

func (e narratorFailErr) Error() string { return string(e) }

func TestRegistry_Investigate_FansOutAndSorts(t *testing.T) {
	r := NewRegistry()
	r.RegisterSource(&happySource{name: "s1", ev: []Evidence{{Source: "s1", Summary: "x"}}})
	r.RegisterSource(&happySource{name: "s2", ev: []Evidence{{Source: "s2", Summary: "y"}}})
	r.RegisterDetector(&happyDetector{id: "info", sev: SeverityInfo, title: "i"})
	r.RegisterDetector(&happyDetector{id: "critical", sev: SeverityCritical, title: "c"})
	r.RegisterDetector(&happyDetector{id: "warning", sev: SeverityWarning, title: "w"})
	r.RegisterNarrator(&firstWinsNarrator{out: Report{Summary: "ok"}})

	resp, err := r.Investigate(context.Background(), Input{})
	if err != nil {
		t.Fatalf("Investigate: %v", err)
	}
	if len(resp.Findings) != 3 {
		t.Fatalf("want 3 findings, got %d", len(resp.Findings))
	}
	// Sorted: Critical, Warning, Info — and within same severity by ID.
	if resp.Findings[0].ID != "critical" || resp.Findings[1].ID != "warning" || resp.Findings[2].ID != "info" {
		t.Fatalf("order wrong: %+v", []string{resp.Findings[0].ID, resp.Findings[1].ID, resp.Findings[2].ID})
	}
	if resp.Summary != "ok" || resp.Narrator != "first" {
		t.Fatalf("narrator not propagated: %+v", resp)
	}
}

func TestRegistry_Investigate_NarratorFallsThroughOnError(t *testing.T) {
	r := NewRegistry()
	r.RegisterNarrator(&errorNarrator{})
	r.RegisterNarrator(&firstWinsNarrator{out: Report{Summary: "fallback"}})

	resp, err := r.Investigate(context.Background(), Input{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Narrator != "first" {
		t.Fatalf("expected fallback narrator, got %q", resp.Narrator)
	}
	if resp.Summary != "fallback" {
		t.Fatalf("expected fallback summary, got %q", resp.Summary)
	}
}

func TestDeterministicNarrator(t *testing.T) {
	n := &DeterministicNarrator{}
	if n.Name() != "deterministic" {
		t.Fatalf("Name: %s", n.Name())
	}
	// Empty findings → "All clear".
	rep, err := n.Narrate(context.Background(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Summary != "All clear" {
		t.Fatalf("got %q", rep.Summary)
	}
	// Mixed findings → counts.
	rep, err = n.Narrate(context.Background(), []Finding{
		{Severity: SeverityCritical},
		{Severity: SeverityCritical},
		{Severity: SeverityWarning},
		{Severity: SeverityInfo},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rep.Summary, "2 critical") || !strings.Contains(rep.Summary, "1 warning") || !strings.Contains(rep.Summary, "1 info") {
		t.Fatalf("missing counts: %q", rep.Summary)
	}
}
