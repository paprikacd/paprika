package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	admissionWorkBody    = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics"}}`
	admissionCatalogBody = `{"jsonrpc":"2.0","id":1,"method":"initialize"}`
	admissionAuthorBody  = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_dashboard"}}`
)

// productionAdmissionPools are the pools and wait the gateway starts with by
// default, resolved through the same flag path the binary uses.
func productionAdmissionPools(t *testing.T, args ...string) observabilityHTTPPools {
	t.Helper()
	cfg, err := parseManagerConfig(append([]string{"--mode=observability-gateway"}, args...), &bytes.Buffer{})
	require.NoError(t, err)
	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	return capacity.Pools
}

// blockingHandler holds requests marked hold=1 until release closes.
func blockingHandler(release <-chan struct{}, entered chan<- struct{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		if r.URL.Query().Get("hold") == "1" {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		w.WriteHeader(http.StatusOK)
	})
}

func admissionServe(ctx context.Context, h http.Handler, path, body string) (int, time.Duration) {
	start := time.Now()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(ctx, http.MethodPost, path, strings.NewReader(body)))
	return rec.Code, time.Since(start)
}

func TestAdmissionPoolWaitsThenRejectsAtDeadline(t *testing.T) {
	p := newObservabilityAdmissionPool(1, 1)
	require.True(t, p.acquire(t.Context()))
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	assert.False(t, p.acquire(ctx))
	assert.GreaterOrEqual(t, time.Since(start), 30*time.Millisecond)
}

func TestAdmissionPoolWaiterAdmittedWhenSlotFrees(t *testing.T) {
	p := newObservabilityAdmissionPool(1, 1)
	require.True(t, p.acquire(t.Context()))
	go func() {
		time.Sleep(20 * time.Millisecond)
		p.release()
	}()
	assert.True(t, p.acquire(t.Context()))
}

func TestAdmissionPoolZeroWaitFailsFast(t *testing.T) {
	p := newObservabilityAdmissionPool(1, 1)
	require.True(t, p.acquire(t.Context()))
	ctx, cancel := context.WithTimeout(t.Context(), 0)
	defer cancel()
	start := time.Now()
	assert.False(t, p.acquire(ctx))
	assert.Less(t, time.Since(start), 20*time.Millisecond)
}

// Waiters are bounded per pool: with size 1 running and 1 waiting, the next
// request is refused at once even though its own deadline is far away.
func TestAdmissionPoolCapsWaiters(t *testing.T) {
	p := newObservabilityAdmissionPool(1, 1)
	require.True(t, p.acquire(t.Context()))
	waiterDone := make(chan bool, 1)
	go func() { waiterDone <- p.acquire(t.Context()) }()
	time.Sleep(20 * time.Millisecond)

	start := time.Now()
	assert.False(t, p.acquire(t.Context()))
	assert.Less(t, time.Since(start), 20*time.Millisecond)

	p.release()
	assert.True(t, <-waiterDone)
}

func TestAdmissionPoolStopsWaitingWhenClientGoes(t *testing.T) {
	p := newObservabilityAdmissionPool(1, 1)
	require.True(t, p.acquire(t.Context()))
	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	assert.False(t, p.acquire(ctx))
	assert.Less(t, time.Since(start), time.Second)
}

// With one work slot, a second request waits for the first. With no wait it is
// refused at once. Both outcomes return the 429 headers when refused.
func TestLimitObservabilityProtocolRequestsWaitsForWorkSlot(t *testing.T) {
	for _, tc := range []struct {
		name     string
		wait     time.Duration
		wantCode int
	}{
		{"with wait the second request is admitted", 2 * time.Second, http.StatusOK},
		{"without wait the second request is refused", 0, http.StatusTooManyRequests},
	} {
		t.Run(tc.name, func(t *testing.T) {
			release := make(chan struct{})
			entered := make(chan struct{}, 2)
			h := limitObservabilityProtocolRequestsWith(blockingHandler(release, entered),
				observabilityHTTPPools{Work: 1, WorkWaiters: 1, Catalog: 1, Dashboards: 1, Intake: 4, AdmissionWait: tc.wait})
			firstCode := make(chan int, 1)
			go func() {
				code, _ := admissionServe(t.Context(), h, "/observe/mcp?hold=1", admissionWorkBody)
				firstCode <- code
			}()
			<-entered

			secondCode := make(chan int, 1)
			go func() {
				code, _ := admissionServe(t.Context(), h, "/observe/mcp", admissionWorkBody)
				secondCode <- code
			}()
			if tc.wait == 0 {
				assert.Equal(t, tc.wantCode, <-secondCode)
			} else {
				// Free the first slot while the second request is still queued.
				time.Sleep(30 * time.Millisecond)
				close(release)
				assert.Equal(t, tc.wantCode, <-secondCode)
			}
			if tc.wait == 0 {
				close(release)
			}
			assert.Equal(t, http.StatusOK, <-firstCode)
		})
	}
}

// Regression for the starvation bug: with the production 1 s wait and the work
// pool saturated, catalog and dashboard requests are still admitted at once.
// The work pool holds 4 running and up to 32 waiting (the budget queue), so a
// 33rd data request is refused at once.
func TestSaturatedWorkPoolDoesNotBlockCatalogOrDashboards(t *testing.T) {
	pools := productionAdmissionPools(t)
	require.Equal(t, time.Second, pools.AdmissionWait)
	require.Equal(t, 32, pools.WorkWaiters)
	release := make(chan struct{})
	entered := make(chan struct{}, 64)
	h := limitObservabilityProtocolRequestsWith(blockingHandler(release, entered), pools)

	var holders sync.WaitGroup
	for range pools.Work {
		holders.Add(1)
		go func() {
			defer holders.Done()
			admissionServe(t.Context(), h, "/observe/mcp?hold=1", admissionWorkBody)
		}()
		<-entered
	}
	var waiters sync.WaitGroup
	waiterCodes := make([]int, pools.WorkWaiters)
	for i := range pools.WorkWaiters {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			waiterCodes[i], _ = admissionServe(t.Context(), h, "/observe/mcp", admissionWorkBody)
		}()
	}
	time.Sleep(100 * time.Millisecond)

	code, elapsed := admissionServe(t.Context(), h, "/observe/mcp", admissionWorkBody)
	assert.Equal(t, http.StatusTooManyRequests, code, "a request beyond the work pool's waiters must be refused")
	assert.Less(t, elapsed, 50*time.Millisecond)

	code, elapsed = admissionServe(t.Context(), h, "/observe/mcp", admissionCatalogBody)
	assert.Equal(t, http.StatusOK, code, "catalog must not wait behind saturated work")
	assert.Less(t, elapsed, 50*time.Millisecond)

	code, elapsed = admissionServe(t.Context(), h, "/observe/mcp", dashboardAdmissionEnvelope)
	assert.Equal(t, http.StatusOK, code, "dashboards must not wait behind saturated work")
	assert.Less(t, elapsed, 50*time.Millisecond)

	close(release)
	holders.Wait()
	waiters.Wait()
	for i, c := range waiterCodes {
		assert.Equal(t, http.StatusOK, c, "waiter %d", i)
	}
}

// A burst of concurrency + queue data requests inside the edge wait is admitted,
// not refused at the edge. With a 5 ms execution each request finishes well inside
// the 1 s deadline, so all 36 must succeed.
func TestBudgetSizedBurstAdmittedWithinEdgeWait(t *testing.T) {
	pools := productionAdmissionPools(t)
	budgetCapacity := 4 + 32
	require.Equal(t, budgetCapacity, pools.Work+pools.WorkWaiters)
	h := limitObservabilityProtocolRequestsWith(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		time.Sleep(5 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}), pools)

	codes := make([]int, budgetCapacity)
	var wg sync.WaitGroup
	for i := range budgetCapacity {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = admissionServe(t.Context(), h, "/observe/mcp", admissionWorkBody)
		}()
	}
	wg.Wait()
	for i, c := range codes {
		assert.Equal(t, http.StatusOK, c, "burst request %d of %d", i, budgetCapacity)
	}
}

// Over a real HTTP/1.1 connection, a client that leaves while its request waits
// for a pool must release the wait at once rather than at the admission deadline.
func TestAdmissionHTTP1ClientLeavingStopsWaiting(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	pools := observabilityHTTPPools{Work: 1, WorkWaiters: 1, Catalog: 1, Dashboards: 1, Intake: 4, AdmissionWait: time.Second}
	handler := limitObservabilityProtocolRequestsWith(blockingHandler(release, entered), pools)
	var returnedAt atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		if r.URL.Query().Get("hold") != "1" {
			returnedAt.Store(time.Now().UnixNano())
		}
	}))
	defer srv.Close()
	defer close(release)

	holder := make(chan struct{})
	go func() {
		defer close(holder)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, srv.URL+"/observe/mcp?hold=1", strings.NewReader(admissionWorkBody))
		if err != nil {
			return
		}
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
		}
	}()
	<-entered

	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/observe/mcp", strings.NewReader(admissionWorkBody))
	require.NoError(t, err)
	resp, err := client.Do(req)
	if err == nil {
		_ = resp.Body.Close()
	}
	require.Error(t, err, "client should give up at its own 100ms deadline")
	left := time.Now()

	require.Eventually(t, func() bool { return returnedAt.Load() != 0 }, 3*time.Second, 10*time.Millisecond)
	stopped := time.Unix(0, returnedAt.Load())
	assert.Less(t, stopped.Sub(left), 300*time.Millisecond, "handler kept waiting after the client left")
}

// nestedAdmission runs n concurrent outer requests that each issue one nested
// request to the same gateway while holding their pool slot. It returns the
// nested status codes. Every outer request is held until all n are inside the
// handler, so the outer class's pool is full when the nested requests arrive.
func nestedAdmission(t *testing.T, pools observabilityHTTPPools, outerBody, nestedBody string, n int) []int {
	t.Helper()
	var srv *httptest.Server
	entered := make(chan struct{}, n)
	gate := make(chan struct{})
	var mu sync.Mutex
	var nested []int
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) == outerBody {
			entered <- struct{}{}
			<-gate
			req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, srv.URL+"/observe/mcp", strings.NewReader(nestedBody))
			code := 0
			if resp, err := srv.Client().Do(req); err == nil {
				code = resp.StatusCode
				_ = resp.Body.Close()
			}
			mu.Lock()
			nested = append(nested, code)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	})
	srv = httptest.NewServer(limitObservabilityProtocolRequestsWith(inner, pools))
	defer srv.Close()

	var outer sync.WaitGroup
	for range n {
		outer.Add(1)
		go func() {
			defer outer.Done()
			req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, srv.URL+"/observe/mcp", strings.NewReader(outerBody))
			if resp, err := srv.Client().Do(req); err == nil {
				_ = resp.Body.Close()
			}
		}()
	}
	for range n {
		<-entered
	}
	close(gate)
	outer.Wait()
	mu.Lock()
	defer mu.Unlock()
	return nested
}

// The reviewer's deadlock shapes. Before intake was released after
// classification, every intake slot held a request that was waiting for a
// nested request which needed an intake slot. Now each nested request must be
// admitted.
func TestNestedRequestsAdmittedWhenIntakeEqualsWork(t *testing.T) {
	pools := productionAdmissionPools(t, "--observability-http-intake-slots=4")
	require.Equal(t, 4, pools.Intake)
	require.Equal(t, pools.Work, pools.Intake)
	codes := nestedAdmission(t, pools, admissionAuthorBody, admissionCatalogBody, pools.Work)
	require.Len(t, codes, pools.Work)
	for _, c := range codes {
		assert.Equal(t, http.StatusOK, c, "authoring nested handshake")
	}
}

func TestNestedDashboardQueriesAdmittedWhenWorkIsOneAndIntakeEqualsDashboards(t *testing.T) {
	pools := productionAdmissionPools(t, "--observability-http-work-slots=1")
	require.Equal(t, 1, pools.Work)
	require.Equal(t, pools.Dashboards, pools.Intake)
	codes := nestedAdmission(t, pools, dashboardAdmissionEnvelope, admissionWorkBody, pools.Dashboards)
	require.Len(t, codes, pools.Dashboards)
	for _, c := range codes {
		assert.Equal(t, http.StatusOK, c, "dashboard nested data request")
	}
}

// limitWithProductionPools applies the gateway's startup pools and admission
// wait, so the existing reserve tests exercise the real waits.
func limitWithProductionPools(t *testing.T, next http.Handler) http.Handler {
	t.Helper()
	return limitObservabilityProtocolRequestsWith(next, productionAdmissionPools(t))
}
