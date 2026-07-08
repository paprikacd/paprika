package investigator

import "context"

// DeterministicNarrator composes a one-line summary from the Findings slice.
// Always succeeds; the engine relies on it as the fallback narrator.
type DeterministicNarrator struct{}

// Name returns the narrator's identifier.
func (n *DeterministicNarrator) Name() string { return "deterministic" }

// Narrate returns either "All clear" or "{N} critical, {M} warning, {K} info".
func (n *DeterministicNarrator) Narrate(_ context.Context, findings []Finding, _ []Evidence) (Report, error) {
	if len(findings) == 0 {
		return Report{Summary: "All clear", Narrator: n.Name()}, nil
	}
	var crit, warn, info int
	for _, f := range findings {
		switch f.Severity {
		case SeverityUnspecified:
			continue
		case SeverityCritical:
			crit++
		case SeverityWarning:
			warn++
		case SeverityInfo:
			info++
		}
	}
	var s string
	switch {
	case crit > 0:
		s = "%d critical, %d warning, %d info — investigate critical issues first"
	case warn > 0:
		s = "%d warning, %d info"
	default:
		s = "%d informational finding(s)"
	}
	s = sprintfCount(s, crit, warn, info)
	return Report{Summary: s, Narrator: n.Name()}, nil
}

// sprintfCount is a tiny fmt.Sprintf shim that avoids importing fmt on the
// hot path of detection-render hot loops. Keeps determinism while the engine
// otherwise imports nothing else from "fmt".
func sprintfCount(format string, a, b, c int) string {
	// Single-pass substitution: replace each "%d" with its arg's decimal.
	out := []byte{}
	ai, bi, ci := 0, 0, 0
	arg := func(idx int) string {
		var v int
		switch idx {
		case 0:
			v, ai = a, ai+1
		case 1:
			v, bi = b, bi+1
		case 2:
			v, ci = c, ci+1
		}
		return itoa(v)
	}
	at := 0
	for i := 0; i < len(format)-1; i++ {
		if format[i] == '%' && format[i+1] == 'd' {
			out = append(out, []byte(arg(at))...)
			at++
			i++
			continue
		}
		out = append(out, format[i])
	}
	if format != "" {
		out = append(out, format[len(format)-1])
	}
	return string(out)
}
