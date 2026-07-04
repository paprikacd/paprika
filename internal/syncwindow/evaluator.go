package syncwindow

import (
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/robfig/cron/v3"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Evaluator decides whether a sync is currently allowed by the configured windows.
type Evaluator interface {
	IsSyncAllowed(windows []paprikav1.SyncWindow, stage string, now time.Time, manual bool) Result
}

// Result is the outcome of a sync-window evaluation.
type Result struct {
	Allowed        bool
	Reason         string
	NextTransition *time.Time
}

// NewEvaluator creates a default cron-based evaluator.
func NewEvaluator() *CronEvaluator {
	return &CronEvaluator{
		parser: cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow),
	}
}

type CronEvaluator struct {
	parser cron.Parser
}

//nolint:cyclop // window evaluation semantics are inherently branchy.
func (e *CronEvaluator) IsSyncAllowed(windows []paprikav1.SyncWindow, stage string, now time.Time, manual bool) Result {
	if manual {
		return Result{Allowed: true, Reason: "Manual sync override"}
	}
	if len(windows) == 0 {
		return Result{Allowed: true, Reason: "No sync windows configured"}
	}

	var parsed []parsedWindow
	for i := range windows {
		w := &windows[i]
		if len(w.Stages) > 0 && !slices.Contains(w.Stages, stage) {
			continue
		}
		pw, err := e.parse(w)
		if err != nil {
			return Result{Allowed: false, Reason: fmt.Sprintf("invalid sync window %q: %v", w.Schedule, err)}
		}
		parsed = append(parsed, pw)
	}

	if len(parsed) == 0 {
		return Result{Allowed: true, Reason: "No sync windows apply to stage"}
	}

	hasAllow := false
	for _, w := range parsed {
		if w.kind == paprikav1.SyncWindowAllow {
			hasAllow = true
			break
		}
	}

	// Block windows always take precedence over allow windows.
	for _, w := range parsed {
		if w.kind != paprikav1.SyncWindowBlock {
			continue
		}
		active, _, end := w.activeAt(now)
		if active {
			return Result{
				Allowed:        false,
				Reason:         fmt.Sprintf("blocked by window %s until %s", w.scheduleExpr, end.UTC().Format(time.RFC3339)),
				NextTransition: &end,
			}
		}
	}

	var nextAllow *time.Time
	for _, w := range parsed {
		if w.kind != paprikav1.SyncWindowAllow {
			continue
		}
		active, start, _ := w.activeAt(now)
		if active {
			return Result{Allowed: true, Reason: "within allow window " + w.scheduleExpr}
		}
		if nextAllow == nil || start.Before(*nextAllow) {
			nextAllow = &start
		}
	}

	if hasAllow {
		reason := "outside allow window"
		if nextAllow != nil {
			reason = "outside allow window; next allow at " + nextAllow.UTC().Format(time.RFC3339)
		}
		return Result{Allowed: false, Reason: reason, NextTransition: nextAllow}
	}

	return Result{Allowed: true, Reason: "No blocking window active"}
}

type parsedWindow struct {
	kind         paprikav1.SyncWindowKind
	schedule     cron.Schedule
	duration     time.Duration
	scheduleExpr string
}

func (e *CronEvaluator) parse(w *paprikav1.SyncWindow) (parsedWindow, error) {
	loc := time.UTC
	if w.Timezone != "" {
		var err error
		loc, err = time.LoadLocation(w.Timezone)
		if err != nil {
			return parsedWindow{}, fmt.Errorf("timezone %q: %w", w.Timezone, err)
		}
	}

	// robfig/cron v3 binds the schedule to a location via the CRON_TZ= prefix.
	spec := fmt.Sprintf("CRON_TZ=%s %s", loc.String(), w.Schedule)
	schedule, err := e.parser.Parse(spec)
	if err != nil {
		return parsedWindow{}, fmt.Errorf("schedule %q: %w", w.Schedule, err)
	}

	d, err := time.ParseDuration(w.Duration)
	if err != nil {
		return parsedWindow{}, fmt.Errorf("duration %q: %w", w.Duration, err)
	}
	if d <= 0 {
		return parsedWindow{}, errors.New("duration must be positive")
	}

	return parsedWindow{
		kind:         w.Kind,
		schedule:     schedule,
		duration:     d,
		scheduleExpr: w.Schedule,
	}, nil
}

func (w parsedWindow) activeAt(now time.Time) (active bool, start, end time.Time) {
	loc := time.UTC
	if s, ok := w.schedule.(interface{ Location() *time.Location }); ok {
		loc = s.Location()
	}
	if loc == time.Local {
		loc = now.Location()
	}
	t := now.In(loc)

	lookback := 24*time.Hour + w.duration
	candidate := w.schedule.Next(t.Add(-lookback))
	for !candidate.After(t) {
		windowEnd := candidate.Add(w.duration)
		if !t.Before(candidate) && t.Before(windowEnd) {
			return true, candidate, windowEnd
		}
		next := w.schedule.Next(candidate)
		if !next.After(candidate) {
			break
		}
		candidate = next
	}

	nextStart := w.schedule.Next(t)
	return false, nextStart, nextStart.Add(w.duration)
}
