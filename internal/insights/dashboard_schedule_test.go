package insights

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// gatedQueries runs as scheduler tasks that each report their start and then wait for their own gate.
// A test sees exactly which queries the scheduler started, and releases them one at a time.
type gatedQueries struct {
	started chan int
	gates   []chan struct{}
}

func newGatedQueries(n int) *gatedQueries {
	g := &gatedQueries{started: make(chan int, n), gates: make([]chan struct{}, n)}
	for i := range g.gates {
		g.gates[i] = make(chan struct{})
	}
	return g
}

func (g *gatedQueries) run(i int) {
	g.started <- i
	<-g.gates[i]
}

func (g *gatedQueries) release(i int) { close(g.gates[i]) }

func (g *gatedQueries) releaseAll() {
	for i := range g.gates {
		select {
		case <-g.gates[i]:
		default:
			close(g.gates[i])
		}
	}
}

// awaitStarts receives want starts and returns their indices as a set. It fails if fewer arrive in time.
func awaitStarts(t *testing.T, g *gatedQueries, want int) map[int]bool {
	t.Helper()
	got := make(map[int]bool, want)
	for range want {
		select {
		case i := <-g.started:
			got[i] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("expected %d starts, got %v", want, got)
		}
	}
	return got
}

// assertNoStart checks that the scheduler starts nothing more for a short while. A block that
// holds is the behaviour under test; the window only needs to be long enough to catch a start.
func assertNoStart(t *testing.T, g *gatedQueries) {
	t.Helper()
	select {
	case i := <-g.started:
		t.Fatalf("query %d started above the limit", i)
	case <-time.After(60 * time.Millisecond):
	}
}

// scheduleAsync runs the scheduler in its own goroutine, so a deadlock fails the test instead of hanging it.
func scheduleAsync(ctx context.Context, n int, providerOf func(int) string, limits dashboardLimits, run func(int)) <-chan []dashboardTask {
	out := make(chan []dashboardTask, 1)
	go func() { out <- runDashboardBounded(ctx, n, providerOf, limits, run) }()
	return out
}

func awaitSchedule(t *testing.T, out <-chan []dashboardTask) []dashboardTask {
	t.Helper()
	select {
	case tasks := <-out:
		return tasks
	case <-time.After(5 * time.Second):
		t.Fatal("scheduler did not return")
		return nil
	}
}

func providersOf(names ...string) func(int) string {
	return func(i int) string { return names[i] }
}

func TestDashboardLimitsAreDerivedFromTheReadAndProviderShape(t *testing.T) {
	cases := []struct {
		name          string
		perRead       int
		multiProvider bool
		wantPerRead   int
		wantPerProv   int
	}{
		{"zero is clamped to serial", 0, false, 1, 1},
		{"above the maximum is clamped", 9, false, dashboardMaxParallelism, dashboardMaxProviderParallelism},
		{"serial read has one provider slot", 1, true, 1, 1},
		{"single provider uses the provider bulkhead", 4, false, 4, 2},
		{"two providers keep one slot free", 2, true, 2, 1},
		{"two providers at four keep one slot free", 4, true, 4, 2},
		{"three reads across providers", 3, true, 3, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := newDashboardLimits(tc.perRead, tc.multiProvider, nil)
			if got.perRead != tc.wantPerRead || got.perProvider != tc.wantPerProv {
				t.Fatalf("perRead=%d perProvider=%d, want %d and %d", got.perRead, got.perProvider, tc.wantPerRead, tc.wantPerProv)
			}
		})
	}
}

func TestDashboardSlotPoolIsOnlyTriedAndNilIsEmpty(t *testing.T) {
	var none *dashboardSlotPool
	if none.tryAcquire() {
		t.Fatal("a nil pool must hold no slots")
	}
	none.release()
	if newDashboardSlotPool(0).tryAcquire() {
		t.Fatal("a zero-size pool must hold no slots")
	}
	pool := newDashboardSlotPool(1)
	if !pool.tryAcquire() {
		t.Fatal("first acquire must succeed")
	}
	if pool.tryAcquire() {
		t.Fatal("a full pool must refuse without blocking")
	}
	pool.release()
	if !pool.tryAcquire() {
		t.Fatal("a released slot must be available again")
	}
}

func TestDashboardSchedulerSerialWhenPerReadIsOne(t *testing.T) {
	const n = 4
	g := newGatedQueries(n)
	out := scheduleAsync(t.Context(), n, providersOf("a", "b", "c", "d"), newDashboardLimits(1, true, newDashboardSlotPool(3)), g.run)
	for want := range n {
		got := <-g.started
		if got != want {
			t.Fatalf("serial dispatch started %d before %d", got, want)
		}
		assertNoStart(t, g)
		g.release(want)
	}
	for _, task := range awaitSchedule(t, out) {
		if !task.Started || task.Panicked != nil {
			t.Fatalf("serial query did not complete cleanly: %+v", task)
		}
	}
}

func TestDashboardSchedulerBoundsOneProviderAtItsLimit(t *testing.T) {
	const n = 8
	g := newGatedQueries(n)
	limits := newDashboardLimits(4, false, newDashboardSlotPool(3))
	out := scheduleAsync(t.Context(), n, providersOf("a", "a", "a", "a", "a", "a", "a", "a"), limits, g.run)
	awaitStarts(t, g, limits.perProvider)
	assertNoStart(t, g)
	g.releaseAll()
	for _, task := range awaitSchedule(t, out) {
		if !task.Started {
			t.Fatalf("every query must eventually start: %+v", task)
		}
	}
}

func TestDashboardSchedulerUsesExtraSlotsUpToTheReadLimit(t *testing.T) {
	const n = 6
	g := newGatedQueries(n)
	pool := newDashboardSlotPool(2)
	limits := newDashboardLimits(3, true, pool)
	out := scheduleAsync(t.Context(), n, providersOf("p0", "p1", "p2", "p3", "p4", "p5"), limits, g.run)
	started := awaitStarts(t, g, 3)
	for _, want := range []int{0, 1, 2} {
		if !started[want] {
			t.Fatalf("expected the first three queries to start, got %v", started)
		}
	}
	assertNoStart(t, g)
	if pool.tryAcquire() {
		t.Fatal("two extra slots must be held while the read runs three queries")
	}
	g.releaseAll()
	awaitSchedule(t, out)
	if !pool.tryAcquire() {
		t.Fatal("extra slots must be returned when the read ends")
	}
}

func TestDashboardSchedulerBlockedProviderDoesNotHoldBothSlots(t *testing.T) {
	g := newGatedQueries(3)
	pool := newDashboardSlotPool(1)
	limits := newDashboardLimits(2, true, pool)
	out := scheduleAsync(t.Context(), 3, providersOf("a", "a", "b"), limits, g.run)
	started := awaitStarts(t, g, 2)
	if !started[0] || !started[2] || started[1] {
		t.Fatalf("query 2 for provider b must start while provider a is at its limit, got %v", started)
	}
	assertNoStart(t, g)

	// Query 0 finishes, freeing provider a and the read's own slot, so query 1 starts.
	g.release(0)
	if got := awaitStarts(t, g, 1); !got[1] {
		t.Fatalf("query 1 should start once provider a has room, got %v", got)
	}
	g.releaseAll()
	awaitSchedule(t, out)
}

func TestDashboardSchedulerReadNeverWaitsForAnotherRead(t *testing.T) {
	// The process pool is exhausted by someone else. A read still runs its queries one at a
	// time on its own slot, and never blocks waiting for the pool.
	pool := newDashboardSlotPool(1)
	if !pool.tryAcquire() {
		t.Fatal("setup: pool must start with one free slot")
	}
	g := newGatedQueries(2)
	out := scheduleAsync(t.Context(), 2, providersOf("a", "b"), newDashboardLimits(2, true, pool), g.run)
	if got := awaitStarts(t, g, 1); !got[0] {
		t.Fatalf("first query must use the read's own slot, got %v", got)
	}
	assertNoStart(t, g)
	g.release(0)
	if got := awaitStarts(t, g, 1); !got[1] {
		t.Fatalf("second query must run once the read's own slot is free, got %v", got)
	}
	g.releaseAll()
	awaitSchedule(t, out)
	pool.release()
}

func TestDashboardSchedulerRecoversPanicsPerQuery(t *testing.T) {
	const n = 4
	var completed atomic.Int32
	run := func(i int) {
		if i == 1 {
			panic("secret provider detail")
		}
		completed.Add(1)
	}
	tasks := awaitSchedule(t, scheduleAsync(t.Context(), n, providersOf("a", "b", "c", "d"), newDashboardLimits(2, true, newDashboardSlotPool(1)), run))
	for i, task := range tasks {
		if !task.Started {
			t.Fatalf("query %d did not start", i)
		}
		if (i == 1) != (task.Panicked != nil) {
			t.Fatalf("query %d panic state %v", i, task.Panicked)
		}
	}
	if !errors.Is(tasks[1].Panicked, errDashboardQueryPanicked) {
		t.Fatalf("panic must be reported as the generic error, got %v", tasks[1].Panicked)
	}
	if completed.Load() != n-1 {
		t.Fatalf("siblings of the panicking query must still run, completed %d", completed.Load())
	}
}

func TestDashboardSchedulerStopsStartingWhenTheContextEnds(t *testing.T) {
	const n = 6
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	g := newGatedQueries(n)
	var returned atomic.Int32
	run := func(i int) {
		defer returned.Add(1)
		g.started <- i
		select {
		case <-g.gates[i]:
		case <-ctx.Done():
		}
	}
	out := scheduleAsync(ctx, n, providersOf("a", "b", "c", "d", "e", "f"), newDashboardLimits(2, true, newDashboardSlotPool(1)), run)
	awaitStarts(t, g, 2)
	cancel()
	tasks := awaitSchedule(t, out)
	var started []int
	for i, task := range tasks {
		if task.Started {
			started = append(started, i)
		}
	}
	if !slices.Equal(started, []int{0, 1}) {
		t.Fatalf("only the two queries already in flight may start, started %v", started)
	}
	if returned.Load() != 2 {
		t.Fatalf("the scheduler returned before its in-flight queries finished: %d returned", returned.Load())
	}
	select {
	case i := <-g.started:
		t.Fatalf("query %d started after cancellation", i)
	default:
	}
}

func TestDashboardSchedulerIsCorrectUnderConcurrentReads(t *testing.T) {
	// Several reads share one pool. Peaks are checked per read, and the pool never grows past its size.
	const reads, perReadQueries, poolSize = 4, 8, 3
	pool := newDashboardSlotPool(poolSize)
	var peakTotal, activeTotal atomic.Int32
	var wg sync.WaitGroup
	for r := range reads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			providerOf := func(i int) string { return fmt.Sprintf("p%d", i%3) }
			limits := newDashboardLimits(2, true, pool)
			var active, peak atomic.Int32
			run := func(int) {
				now := active.Add(1)
				for {
					old := peak.Load()
					if now <= old || peak.CompareAndSwap(old, now) {
						break
					}
				}
				total := activeTotal.Add(1)
				for {
					old := peakTotal.Load()
					if total <= old || peakTotal.CompareAndSwap(old, total) {
						break
					}
				}
				time.Sleep(2 * time.Millisecond)
				activeTotal.Add(-1)
				active.Add(-1)
			}
			tasks := runDashboardBounded(t.Context(), perReadQueries, providerOf, limits, run)
			for i, task := range tasks {
				if !task.Started {
					t.Errorf("read %d query %d never started", r, i)
				}
			}
			if peak.Load() > 2 {
				t.Errorf("read %d peaked at %d, above its per-read limit of 2", r, peak.Load())
			}
		}()
	}
	wg.Wait()
	// One read holds its own slot without the pool, so the process peaks at reads + pool size at most.
	if peakTotal.Load() > reads+poolSize {
		t.Fatalf("process peaked at %d, above %d reads plus %d extra slots", peakTotal.Load(), reads, poolSize)
	}
	if !pool.tryAcquire() {
		t.Fatal("all extra slots must return to the pool once the reads finish")
	}
}
