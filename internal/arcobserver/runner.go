package arcobserver

import (
	"context"
	"errors"
	"time"

	"github.com/go-logr/logr"
)

type Runner struct {
	Config    Config
	Collector Collector
	Publisher Publisher
	Log       logr.Logger
}

// Only the leader observes; polling cannot create informer/RBAC requirements.
func (*Runner) NeedLeaderElection() bool { return true }

func (r *Runner) Start(ctx context.Context) error {
	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(r.ObserveOnce(ctx), ErrDenied) {
			// No identity fallback or repeated credential attempt after denial.
			r.Log.Info("ARC observation stopped after authorization denial")
			<-ctx.Done()
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// Reads for all configured pools share one eight-second budget. Publications
// have individual three-second budgets; no round overlaps another. Missing
// samples are never synthesized or renewed and expire at the receiver.
func (r *Runner) ObserveOnce(ctx context.Context) error {
	readCtx, cancel := context.WithTimeout(ctx, ReadDeadline)
	type sample struct {
		source      Source
		observation Observation
	}
	samples := make([]sample, 0, len(r.Config.Sources))
	for _, source := range r.Config.Sources {
		snapshot, err := r.Collector.Collect(readCtx, source)
		if errors.Is(err, ErrDenied) {
			cancel()
			return ErrDenied
		}
		if err != nil {
			r.Log.Info("ARC observation skipped", "pool", source.PoolName, "reason", "read_incomplete")
			continue
		}
		observation, err := Project(source, snapshot, time.Now().UTC())
		if err != nil {
			r.Log.Info("ARC observation skipped", "pool", source.PoolName, "reason", "projection_incomplete")
			continue
		}
		samples = append(samples, sample{source, observation})
	}
	cancel()
	for _, sample := range samples {
		if ctx.Err() != nil {
			return nil
		}
		// Publication never moves observedAt forward after collection.
		if time.Since(sample.observation.ObservedAt) > 30*time.Second {
			continue
		}
		publishCtx, done := context.WithTimeout(ctx, PublishDeadline)
		err := r.Publisher.Publish(publishCtx, sample.source, sample.observation)
		done()
		if errors.Is(err, ErrDenied) {
			return ErrDenied
		}
		if err != nil {
			r.Log.Info("ARC observation skipped", "pool", sample.source.PoolName, "reason", "publication_failed")
		}
	}
	return nil
}
