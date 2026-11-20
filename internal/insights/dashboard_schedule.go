package insights

import (
	"context"
	"errors"
	"log/slog"
	"runtime/debug"
)

// dashboardMaxParallelism is the largest per-read parallelism a read can be given. The configured
// value is validated where it is set; the scheduler also clamps to this range so a bad value never
// starts an unbounded number of queries.
const dashboardMaxParallelism = 4

// dashboardMaxProviderParallelism is the per-provider limit before a read spans providers. It
// matches the gateway's per-provider bulkhead, so Insights never asks for more than the gateway admits.
const dashboardMaxProviderParallelism = 2

// errDashboardQueryPanicked is reported for a query whose worker panicked. The panic value is not
// reported, because it can carry provider detail that must not reach a signal.
var errDashboardQueryPanicked = errors.New("dashboard query panicked")

// dashboardSlotPool is a process-wide set of extra query slots. It is only ever tried without
// blocking: a read that cannot get an extra slot waits on its own slot instead of queueing behind
// other reads. A nil pool holds no slots.
type dashboardSlotPool struct {
	slots chan struct{}
}

func newDashboardSlotPool(size int) *dashboardSlotPool {
	return &dashboardSlotPool{slots: make(chan struct{}, max(size, 0))}
}

// tryAcquire takes a slot if one is free and reports whether it did. It never blocks.
func (p *dashboardSlotPool) tryAcquire() bool {
	if p == nil {
		return false
	}
	select {
	case p.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

// release returns a slot that tryAcquire took. The caller must hold one.
func (p *dashboardSlotPool) release() {
	if p != nil {
		<-p.slots
	}
}

// dashboardLimits bounds one read. perRead queries may run at once. One of them uses the read's own
// slot and the rest use extra slots from the process-wide pool. perProvider bounds the queries for one provider.
type dashboardLimits struct {
	perRead     int
	perProvider int
	extra       *dashboardSlotPool
}

// newDashboardLimits derives the per-provider limit from the per-read limit. A read that spans
// more than one provider keeps one slot free for the others, so a slow provider cannot take every
// slot. multiProvider reports whether the plan's queries name more than one provider.
func newDashboardLimits(perRead int, multiProvider bool, extra *dashboardSlotPool) dashboardLimits {
	perRead = min(max(perRead, 1), dashboardMaxParallelism)
	perProvider := min(perRead, dashboardMaxProviderParallelism)
	if multiProvider && perRead > 1 {
		perProvider = min(perProvider, perRead-1)
	}
	return dashboardLimits{perRead: perRead, perProvider: perProvider, extra: extra}
}

// dashboardTask is the outcome of one query. Started is false when the scheduler stopped before
// starting it, which happens only when the context ended. Panicked is set when its worker panicked.
type dashboardTask struct {
	Started  bool
	Panicked error
}

type dashboardDone struct {
	index    int
	provider string
	extra    bool
	panicked error
}

// runDashboardBounded runs run(i) for each query index in order, within limits. providerOf names
// the provider of each query. A query starts only when its read, its provider and, past the read's
// own first slot, a pool slot allow it. A query blocked by its provider does not hold back a later
// query for another provider; any other block stops the dispatch until a query finishes.
//
// Once ctx ends, no query starts. The call returns only after every started query has returned, so
// nothing is still writing to the caller's state. Each run(i) must observe ctx itself.
func runDashboardBounded(ctx context.Context, n int, providerOf func(int) string, limits dashboardLimits, run func(i int)) []dashboardTask {
	d := &dashboardDispatcher{
		ctx:        ctx,
		providerOf: providerOf,
		limits:     limits,
		run:        run,
		tasks:      make([]dashboardTask, n),
		done:       make(chan dashboardDone),
		byProvider: make(map[string]int),
	}
	pending := make([]int, n)
	for i := range pending {
		pending[i] = i
	}
	ctxDone := ctx.Done()
	for {
		if ctx.Err() == nil {
			pending = d.startReady(pending)
		}
		if d.inFlight == 0 && (len(pending) == 0 || ctx.Err() != nil) {
			return d.tasks
		}
		select {
		case finished := <-d.done:
			d.finish(finished)
		case <-ctxDone:
			// Keep waiting for started queries, which observe the same context. The
			// channel is cleared so a finished context does not spin the loop.
			ctxDone = nil
		}
	}
}

type dashboardDispatcher struct {
	ctx        context.Context
	providerOf func(int) string
	limits     dashboardLimits
	run        func(int)
	tasks      []dashboardTask
	done       chan dashboardDone
	inFlight   int
	ownBusy    bool
	byProvider map[string]int
}

// startReady starts the pending queries that may run now, in plan order, and returns the ones
// still pending. A query skipped for its provider stays pending and keeps its place.
func (d *dashboardDispatcher) startReady(pending []int) []int {
	var kept []int
	for k, index := range pending {
		provider := d.providerOf(index)
		if d.byProvider[provider] >= d.limits.perProvider {
			kept = append(kept, index)
			continue
		}
		if d.inFlight >= d.limits.perRead {
			return append(kept, pending[k:]...)
		}
		// The read's own slot is used whenever it is free. Otherwise the query needs an
		// extra slot, which is only ever tried, so a read never waits on another read.
		extra := d.ownBusy
		if extra && !d.limits.extra.tryAcquire() {
			return append(kept, pending[k:]...)
		}
		if !extra {
			d.ownBusy = true
		}
		d.launch(index, provider, extra)
	}
	return kept
}

func (d *dashboardDispatcher) launch(index int, provider string, extra bool) {
	d.tasks[index].Started = true
	d.inFlight++
	d.byProvider[provider]++
	go func() {
		var panicked error
		defer func() {
			if r := recover(); r != nil {
				// The caller reports only the generic error. The panic value and stack go to the log,
				// so a code bug is visible to operators and not mistaken for a provider failure.
				panicked = errDashboardQueryPanicked
				slog.Error("dashboard query panicked", "index", index, "panic", r, "stack", string(debug.Stack()))
			}
			d.done <- dashboardDone{index: index, provider: provider, extra: extra, panicked: panicked}
		}()
		d.run(index)
	}()
}

func (d *dashboardDispatcher) finish(finished dashboardDone) {
	d.inFlight--
	d.byProvider[finished.provider]--
	if finished.extra {
		d.limits.extra.release()
	} else {
		d.ownBusy = false
	}
	d.tasks[finished.index].Panicked = finished.panicked
}
