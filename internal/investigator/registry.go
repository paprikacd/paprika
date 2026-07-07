// Package investigator implements a pluggable framework for issue investigation.
//
// The plug-in lifecycle is three layers:
//   - DataSource: contributes structured evidence (manifests, events, logs, metrics, …).
//   - Detector:   inspects an Input and emits zero-or-more Findings.
//   - Narrator:   synthesises Findings + evidence into a human-readable Report.
//
// Adding a new capability (e.g. a Prometheus adapter or an LLM narrator) is a
// matter of writing a struct that implements one of the three interfaces and
// calling one Register* method on a Registry. Optional plugins live in
// subdirectories and self-register via init() when a gate env-var is set.
package investigator

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Severity ranks findings so callers can sort critical-first.
type Severity int32

const (
	SeverityUnspecified Severity = 0
	SeverityCritical    Severity = 1
	SeverityWarning     Severity = 2
	SeverityInfo        Severity = 3
)

// String renders the severity enum as a lowercase label.
func (s Severity) String() string {
	switch s {
	case SeverityCritical:
		return "critical"
	case SeverityWarning:
		return "warning"
	case SeverityInfo:
		return "info"
	default:
		return "unspecified"
	}
}

// ResourceRef identifies the resource under investigation.
type ResourceRef struct {
	ApplicationNamespace string
	ApplicationName      string
	Kind                 string
	Name                 string
	Namespace            string
}

// Evidence is a single observable data point cited by a Finding.
type Evidence struct {
	Source    string
	Timestamp string
	Summary   string
}

// Finding is the structured observation produced by a Detector.
type Finding struct {
	ID          string
	Severity    Severity
	Title       string
	Description string
	Evidence    []Evidence
	Playbook    []string
}

// Input is the per-request shape passed to each Detector.
type Input struct {
	Ref          ResourceRef
	App          *pipelinesv1alpha1.Application
	LiveManifest *unstructured.Unstructured
	Diff         string
	Events       []KubernetesEvent
	Logs         []string
}

// KubernetesEvent mirrors the wire shape used elsewhere in the API; redacted of
// timestamps here so detectors can match on type/reason/count only.
type KubernetesEvent struct {
	Type            string
	Reason          string
	Message         string
	LastTimestamp   string
	Count           int32
	ObjectKind      string
	ObjectName      string
	ObjectNamespace string
}

// Report is what a Narrator produces.
type Report struct {
	Summary  string
	Narrator string
}

// DataSource contributes evidence.
type DataSource interface {
	Name() string
	Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error)
}

// Detector inspects an Input and emits Findings.
type Detector interface {
	ID() string
	Severity() Severity
	Detect(ctx context.Context, in Input) ([]Finding, error)
}

// Narrator synthesises Findings into a Report.
type Narrator interface {
	Name() string
	Narrate(ctx context.Context, findings []Finding, evidence []Evidence) (Report, error)
}

// Response is what the engine returns after running a Registry.
type Response struct {
	Findings      []Finding
	Summary       string
	Narrator      string
	GeneratedAtMS int64
}

// Registry holds the active plugin set.
type Registry struct {
	mu        sync.RWMutex
	sources   []DataSource
	detectors []Detector
	narrators []Narrator
}

// NewRegistry returns an empty Registry. Plugins register via the Register*
// methods (directly, or from init() in plugin subpackages).
func NewRegistry() *Registry { return &Registry{} }

func (r *Registry) RegisterSource(s DataSource) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sources = append(r.sources, s)
}
func (r *Registry) RegisterDetector(d Detector) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.detectors = append(r.detectors, d)
}
func (r *Registry) RegisterNarrator(n Narrator) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.narrators = append(r.narrators, n)
}

func (r *Registry) Sources() []DataSource {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]DataSource(nil), r.sources...)
}
func (r *Registry) Detectors() []Detector {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]Detector(nil), r.detectors...)
}
func (r *Registry) Narrators() []Narrator {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]Narrator(nil), r.narrators...)
}

// Investigate runs all sources in parallel, then all detectors in parallel,
// then the first successful narrator. Returns a deterministic Response.
//
// Errors from individual plugins are swallowed; only catastrophic failures
// (e.g. ctx cancelled) bubble up.
func (r *Registry) Investigate(ctx context.Context, in Input) (*Response, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Collect evidence from sources.
	var evidence []Evidence
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, src := range r.Sources() {
		src := src
		wg.Add(1)
		go func() {
			defer wg.Done()
			ev, _ := src.Collect(ctx, in.Ref)
			if len(ev) > 0 {
				mu.Lock()
				evidence = append(evidence, ev...)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	// Run detectors.
	var findings []Finding
	for _, det := range r.Detectors() {
		det := det
		wg.Add(1)
		go func() {
			defer wg.Done()
			fs, _ := det.Detect(ctx, in)
			if len(fs) > 0 {
				mu.Lock()
				findings = append(findings, fs...)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	// Sort critical → info, then by ID for stability.
	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].Severity != findings[j].Severity {
			return findings[i].Severity < findings[j].Severity
		}
		return findings[i].ID < findings[j].ID
	})

	// First narrator wins.
	var summary, narrator string
	for _, narr := range r.Narrators() {
		rep, err := narr.Narrate(ctx, findings, evidence)
		if err != nil {
			continue
		}
		summary = rep.Summary
		narrator = narr.Name()
		break
	}

	return &Response{
		Findings: findings,
		Summary:  summary,
		Narrator: narrator,
	}, nil
}

// Compile-time guard: keeps the unused import happy if Evidence types shrink.
var _ = fmt.Sprintf
