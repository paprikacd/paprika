package insights

import (
	"context"
	"net/http"
	"time"
)

// resultCacheHeader asks for a fresh execution. The request skips the lookup and the
// join, and the result it gets is stored for the requests after it.
const resultCacheHeader = "X-Insights-Cache"

// resultCacheRefresh is the value of resultCacheHeader that asks for a refresh.
const resultCacheRefresh = "refresh"

func wantsResultRefresh(r *http.Request) bool {
	return r.Header.Get(resultCacheHeader) == resultCacheRefresh
}

// admission is the execution slot a request may hold. A shared request takes a slot
// to list its catalog and keeps it until it knows whether it must execute. A local
// request takes one only to execute, so a cache hit or a join never waits for a slot.
type admission struct {
	s *Server
	// held releases the slot taken before the catalog listing, or is nil.
	held func()
	// admitted records that this request took an execution slot for its own execution.
	admitted bool
}

// share releases the slot held from the listing, once. A hit or a join calls it before
// it waits, so a waiting request never holds a slot.
func (a *admission) share() {
	if a.held != nil {
		release := a.held
		a.held = nil
		release()
	}
}

// run executes under an execution slot: the one held from the listing, or a new one.
// An admission refusal is recorded on the receipt and returned, and nothing executes.
func (a *admission) run(ctx context.Context, execute func(context.Context) (QueryResult, error)) (QueryResult, error) {
	if a.held != nil {
		a.admitted = true
		return execute(ctx)
	}
	receipt := receiptFrom(ctx)
	release, err := a.s.acquireQuery(ctx)
	receipt.mark("admission")
	if err != nil {
		receipt.fail(err)
		return QueryResult{Diagnostics: receipt.diagnostics()}, err
	}
	a.admitted = true
	defer release()
	return execute(ctx)
}

// throughResultCache answers a query from the result cache when it can. A hit or a join
// returns a stored or in-flight result and makes no provider request. A miss executes once
// for every caller waiting on it. A refresh, an unscoped provider and a query that cannot
// be keyed execute on their own and never join. A joiner whose leader was canceled, timed
// out or refused for capacity re-claims once, so one caller's cancellation does not fail
// the others.
func (s *Server) throughResultCache(ctx context.Context, p *providerClient, q *Query, refresh bool, adm *admission, execute func(context.Context) (QueryResult, error)) (QueryResult, error) {
	if s.results == nil {
		return adm.run(ctx, execute)
	}
	scope := resultScope(p)
	key := resultKey(scope, q)
	if reason := bypassReason(scope, key, refresh); reason != "" {
		return s.bypassQuery(ctx, q, scope, key, reason, adm, execute)
	}
	for attempt := 0; ; attempt++ {
		hit, join, lead := s.results.claim(key)
		if hit != nil {
			return s.servedQuery(ctx, q, hit, "hit", adm), nil
		}
		if join == nil {
			return s.leadQuery(ctx, q, key, lead, adm, execute)
		}
		result, retry, err := s.joinQuery(ctx, q, join, adm, attempt == 0)
		if !retry {
			return result, err
		}
	}
}

// bypassQuery executes a query that must not use the cache, and stores its result when the
// result may be shared: a refresh refreshes the entry the next caller reads.
func (s *Server) bypassQuery(ctx context.Context, q *Query, scope, key, reason string, adm *admission, execute func(context.Context) (QueryResult, error)) (QueryResult, error) {
	s.results.lookup("bypass", q.Kind, reason)
	receiptFrom(ctx).setCache(&QueryDiagnosticCache{Status: "bypass", Reason: reason})
	result, err := adm.run(ctx, execute)
	if err == nil && scope != "" && key != "" && keepable(&result, q, s.results.now()) {
		s.results.put(key, q.ProviderID, &result, executionIDOf(&result))
	}
	return result, err
}

// servedQuery answers from a stored result: a hit, which makes no provider request.
func (s *Server) servedQuery(ctx context.Context, q *Query, entry *resultEntry, status string, adm *admission) QueryResult {
	adm.share()
	s.results.lookup(status, q.Kind, "")
	return cachedResult(ctx, entry, status, s.results.now())
}

// joinQuery waits for the leader of an in-flight execution. It reports retry when the leader was
// canceled, timed out or refused for capacity and this caller may claim again.
func (s *Server) joinQuery(ctx context.Context, q *Query, join *resultFlight, adm *admission, mayRetry bool) (QueryResult, bool, error) {
	adm.share()
	entry, err := join.wait(ctx)
	if err == nil {
		s.results.lookup("joined", q.Kind, "")
		return cachedResult(ctx, entry, "joined", s.results.now()), false, nil
	}
	if mayRetry && ctx.Err() == nil && retryableLeaderFailure(err) {
		return QueryResult{}, true, nil
	}
	receipt := receiptFrom(ctx)
	receipt.fail(err)
	return QueryResult{Diagnostics: receipt.diagnostics()}, false, err
}

// leadQuery executes a query as the leader of its flight. The result wakes the joiners, and it is
// stored when it may be served later.
func (s *Server) leadQuery(ctx context.Context, q *Query, key string, lead *resultFlight, adm *admission, execute func(context.Context) (QueryResult, error)) (QueryResult, error) {
	result, err := adm.run(ctx, execute)
	keep := err == nil && keepable(&result, q, s.results.now())
	missReason := ""
	if err == nil && !keep {
		missReason = "uncacheable"
		if q.End > float64(s.results.now().UnixMilli())/1000 {
			missReason = "live_edge"
		}
	}
	s.results.complete(key, q.ProviderID, lead, &result, executionIDOf(&result), err, keep)
	s.results.lookup("miss", q.Kind, missReason)
	receiptFrom(ctx).setCache(&QueryDiagnosticCache{Status: "miss", Reason: missReason})
	return result, err
}

// bypassReason names why a query skips the cache, or is empty when it may use it.
func bypassReason(scope, key string, refresh bool) string {
	switch {
	case scope == "":
		return "unscoped"
	case key == "":
		return "uncacheable"
	case refresh:
		return "refresh"
	}
	return ""
}

// retryableLeaderFailure reports whether a joiner should re-claim after its leader failed:
// the leader was canceled, timed out or refused for capacity, which says nothing about the
// query itself. Any other failure is shared with every joiner.
func retryableLeaderFailure(err error) bool {
	switch classifyQueryFailure(err).Code {
	case "canceled", "timeout", "rate_limited":
		return true
	}
	return false
}

// cachedResult is the result a hit or a join delivers. Its receipt records the cache phase
// and the source execution, and it has no provider request, so it reports no upstream phase.
func cachedResult(ctx context.Context, entry *resultEntry, status string, now time.Time) QueryResult {
	result := entry.result
	receipt := receiptFrom(ctx)
	if receipt == nil {
		return result
	}
	age := max(float64(now.Sub(entry.stored))/float64(time.Millisecond), 0)
	receipt.mark("cache")
	receipt.setCache(&QueryDiagnosticCache{Status: status, SourceExecutionID: entry.executionID, AgeMs: &age})
	receipt.diag.complete(&result, nil)
	result.Diagnostics = receipt.diagnostics()
	return result
}

// setCache records how the cache answered this execution. It is nil-safe.
func (r *queryReceipt) setCache(cache *QueryDiagnosticCache) {
	if r != nil {
		r.diag.Cache = cache
	}
}

// executionIDOf is the execution a result came from, or empty when it has no receipt.
func executionIDOf(result *QueryResult) string {
	if result.Diagnostics == nil {
		return ""
	}
	return result.Diagnostics.ExecutionID
}

// forgetResults drops a provider's cached results after its configuration changes.
func (s *Server) forgetResults(providerID string) {
	if s.results != nil {
		s.results.forgetProvider(providerID)
	}
}
