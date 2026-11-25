package insights

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// The result cache holds recent provider results for a short time, so that
// several dashboards or viewers that read the same window in the same grain do
// not each call the provider. An entry is keyed by the caller's authorization
// scope and by the resolved query, so one caller never receives a result that
// another caller could not have requested. Concurrent identical queries join
// one in-flight execution (the leader), and a joiner waits for the leader's
// result instead of calling the provider.
//
// The cache is bounded by bytes and by entry count, expires entries after
// resultCacheTTL, and evicts least recently used entries first.
const (
	// resultCacheTTL is how long a stored result may be served. It bounds how stale a
	// window can be, and how long a revoked grant can still be served.
	resultCacheTTL = 15 * time.Second
	// DefaultResultCacheMiB is the byte budget of the result cache when the flag is not set.
	DefaultResultCacheMiB = 16
	// MaxResultCacheMiB is the largest budget the configuration accepts.
	MaxResultCacheMiB        = 128
	resultCacheMaxEntries    = 1024
	resultCacheMaxEntryBytes = 1 << 20
)

// errResultCacheNoResult is the error a flight carries when its leader finished
// without a result and without an error.
var errResultCacheNoResult = errors.New("result cache: leader returned no result")

// resultCacheMetrics records cache evictions and occupancy. It is the seam the
// tests use to observe the cache without OpenTelemetry.
type resultCacheMetrics interface {
	lookup(outcome, kind, reason string)
	evicted(reason string)
	usage(bytes, entries int)
}

// resultEntry is one cached result. Its slices are shared read-only with every
// caller that receives it.
type resultEntry struct {
	key, providerID, executionID string
	result                       QueryResult
	stored, expires              time.Time
	cost                         int
}

// resultFlight is one in-flight execution that joiners wait on. The leader
// completes it exactly once.
type resultFlight struct {
	done        chan struct{}
	entry       *resultEntry
	err         error
	executionID string
	// epoch is the cache's invalidation epoch when the flight began. A result whose flight began
	// before a provider was forgotten came from the old configuration and is not stored.
	epoch uint64
}

// resultCache is the bounded, shared store. A nil *resultCache is disabled: its
// callers check for nil before using it.
type resultCache struct {
	mu       sync.Mutex
	maxBytes int
	bytes    int
	now      func() time.Time
	metrics  resultCacheMetrics
	entries  map[string]*list.Element
	lru      *list.List
	flights  map[string]*resultFlight
	// epoch moves on every forgetProvider, so an execution that began before an invalidation
	// cannot store its result after it.
	epoch uint64
}

// newResultCache returns a cache bounded by maxBytes, or nil when maxBytes is not
// positive. A nil clock uses time.Now.
func newResultCache(maxBytes int, metrics resultCacheMetrics, now func() time.Time) *resultCache {
	if maxBytes <= 0 {
		return nil
	}
	if now == nil {
		now = time.Now
	}
	return &resultCache{
		maxBytes: maxBytes,
		now:      now,
		metrics:  metrics,
		entries:  make(map[string]*list.Element),
		lru:      list.New(),
		flights:  make(map[string]*resultFlight),
	}
}

// resultKey is the cache key of a resolved query under an authorization scope. It
// is empty when the query cannot be encoded, and an empty key must never be
// cached or joined.
func resultKey(scope string, q *Query) string {
	raw, err := json.Marshal([]any{scope, q.ProviderID, q.Kind, q.Query, q.Start, q.End, q.Step, q.TraceID})
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// resultScope is the authorization scope a result is cached under. A local provider
// is checked by the proxy's global read permission only, so every caller shares one
// scope. A shared provider uses the gateway's digest for the caller, which is empty
// when the gateway reported none; an empty scope disables sharing for that provider.
func resultScope(p *providerClient) string {
	if p.remote == nil {
		return "local"
	}
	return p.remote.scope
}

// resultCost estimates the bytes a result holds, so the byte budget bounds memory.
// It is an estimate of the payload, not an exact heap measurement.
func resultCost(r *QueryResult) int {
	cost := 256
	for i := range r.Series {
		s := &r.Series[i]
		cost += 64 + len(s.Name) + 32*len(s.Points)
		for k, v := range s.Labels {
			cost += 32 + len(k) + len(v)
		}
	}
	for i := range r.Traces {
		t := &r.Traces[i]
		cost += 160 + len(t.TraceID) + len(t.Service) + len(t.Operation) + len(t.Status)
	}
	for i := range r.Spans {
		sp := &r.Spans[i]
		cost += 192 + len(sp.SpanID) + len(sp.ParentSpanID) + len(sp.Service) + len(sp.Operation) + len(sp.Status)
		for _, a := range sp.Attributes {
			cost += 32 + len(a.Key) + len(a.Value)
		}
	}
	return cost + frameCost(r.Records)
}

// frameCost estimates the records frame: its columns, and each row with its text cells.
func frameCost(frame *dataframe.Frame) int {
	if frame == nil {
		return 0
	}
	cost := 0
	for _, column := range frame.Columns {
		cost += 24 + len(column.Key) + len(column.Label) + len(column.Type) + len(column.Unit)
	}
	for _, row := range frame.Rows {
		cost += 24 + 24*len(row)
		for _, cell := range row {
			if text, ok := cell.(string); ok {
				cost += len(text)
			}
		}
	}
	return cost
}

// entryOf returns the entry an LRU element holds. Only entries are stored, so the nil case is unreachable.
func entryOf(elem *list.Element) *resultEntry {
	entry, _ := elem.Value.(*resultEntry) //nolint:errcheck // Only resultEntry values are stored, so the assertion always holds.
	return entry
}

// keepable reports whether a result may be stored. A result is not kept when it
// is truncated for any reason other than the row limit, which the query asked for,
// and not when its window still reaches the present, because the window will move.
func keepable(r *QueryResult, q *Query, now time.Time) bool {
	if r == nil {
		return false
	}
	if r.Truncated && (r.Truncation == nil || r.Truncation.Reason != "row_limit") {
		return false
	}
	return q.End <= float64(now.UnixMilli())/1000
}

// claim looks a key up. A live entry is a hit; an in-flight execution is a join
// the caller waits on; otherwise the caller becomes the leader and must complete
// the flight it is given. An expired entry is dropped here.
func (c *resultCache) claim(key string) (hit *resultEntry, join, lead *resultFlight) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.entries[key]; ok {
		entry := entryOf(elem)
		if c.now().Before(entry.expires) {
			c.lru.MoveToFront(elem)
			return entry, nil, nil
		}
		c.removeLocked(elem, "expired")
	}
	if flight, ok := c.flights[key]; ok {
		return nil, flight, nil
	}
	flight := &resultFlight{done: make(chan struct{}), epoch: c.epoch}
	c.flights[key] = flight
	return nil, nil, flight
}

// complete finishes a leader's flight and wakes its joiners. A success is stored
// when keep is set and the result fits. An error is shared with the joiners but
// never stored. The caller that passes a nil lead, or a nil result without an
// error, gets no flight to complete.
func (c *resultCache) complete(key, providerID string, lead *resultFlight, r *QueryResult, executionID string, err error, keep bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.flights[key] == lead {
		delete(c.flights, key)
	}
	lead.executionID = executionID
	switch {
	case err != nil:
		lead.err = err
	case r == nil:
		lead.err = errResultCacheNoResult
	default:
		// The joiners' age starts when the leader finished, so a join reports the leader's clock.
		lead.entry = &resultEntry{key: key, providerID: providerID, executionID: executionID, result: storedResult(r), stored: c.now()}
		if keep && lead.epoch == c.epoch {
			c.insertLocked(lead.entry)
		}
	}
	close(lead.done)
}

// currentEpoch is the invalidation epoch an execution outside a flight reads before it starts,
// and hands to put when it finishes.
func (c *resultCache) currentEpoch() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.epoch
}

// put stores a result directly, replacing any entry under the same key. It is used
// when a caller refreshed past the cache and wants the new result served next. A result
// whose execution began before an invalidation (an older epoch) is not stored.
func (c *resultCache) put(key, providerID string, r *QueryResult, executionID string, epoch uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if epoch != c.epoch {
		return
	}
	c.insertLocked(&resultEntry{key: key, providerID: providerID, executionID: executionID, result: storedResult(r)})
}

// wait returns the leader's entry once the flight completes, or the leader's
// error. The context ends the wait early and returns its error.
func (f *resultFlight) wait(ctx context.Context) (*resultEntry, error) {
	select {
	case <-f.done:
		if f.err != nil {
			return nil, f.err
		}
		return f.entry, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("wait for shared result: %w", ctx.Err())
	}
}

// forgetProvider drops every entry of a provider, so a configuration change is never
// answered from a result the old configuration produced.
func (c *resultCache) forgetProvider(providerID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.epoch++
	for elem := c.lru.Front(); elem != nil; {
		next := elem.Next()
		if entryOf(elem).providerID == providerID {
			c.removeLocked(elem, "invalidated")
		}
		elem = next
	}
}

// insertLocked stores an entry and evicts least recently used entries until the
// byte and count bounds hold. An entry larger than one megabyte, or than the whole
// budget, is not stored.
func (c *resultCache) insertLocked(entry *resultEntry) {
	cost := resultCost(&entry.result)
	if cost > resultCacheMaxEntryBytes || cost > c.maxBytes {
		c.recordEviction("oversize")
		return
	}
	if elem, ok := c.entries[entry.key]; ok {
		c.removeLocked(elem, "")
	}
	for c.bytes+cost > c.maxBytes || len(c.entries) >= resultCacheMaxEntries {
		back := c.lru.Back()
		if back == nil {
			break
		}
		c.removeLocked(back, "capacity")
	}
	now := c.now()
	entry.cost = cost
	entry.stored = now
	entry.expires = now.Add(resultCacheTTL)
	c.entries[entry.key] = c.lru.PushFront(entry)
	c.bytes += cost
	c.reportUsage()
}

// removeLocked drops one entry. An empty reason is a replacement, which is not an eviction.
func (c *resultCache) removeLocked(elem *list.Element, reason string) {
	entry := entryOf(elem)
	c.lru.Remove(elem)
	delete(c.entries, entry.key)
	c.bytes -= entry.cost
	if reason != "" {
		c.recordEviction(reason)
	}
	c.reportUsage()
}

// lookup counts one cache decision: hit, joined, miss or bypass, with the query kind and,
// for a bypass or an unkept miss, the reason.
func (c *resultCache) lookup(outcome, kind, reason string) {
	if c.metrics != nil {
		c.metrics.lookup(outcome, kind, reason)
	}
}

func (c *resultCache) recordEviction(reason string) {
	if c.metrics != nil {
		c.metrics.evicted(reason)
	}
}

func (c *resultCache) reportUsage() {
	if c.metrics != nil {
		c.metrics.usage(c.bytes, len(c.entries))
	}
}

// storedResult is the result a cache keeps: the same payload without the receipt,
// which describes one request and must not be replayed to another.
func storedResult(r *QueryResult) QueryResult {
	stored := *r
	stored.Diagnostics = nil
	return stored
}

// otelResultCacheMetrics records the cache on the Insights meter.
type otelResultCacheMetrics struct {
	lookups   metric.Int64Counter
	evictions metric.Int64Counter
	bytes     metric.Int64Gauge
	entries   metric.Int64Gauge
}

func newResultCacheMetrics(meter metric.Meter) (*otelResultCacheMetrics, error) {
	lookups, err := meter.Int64Counter("paprika_insights_result_cache_lookups", metric.WithDescription("Result cache decisions by outcome, kind and bypass reason"))
	if err != nil {
		return nil, fmt.Errorf("create result cache lookup counter: %w", err)
	}
	evictions, err := meter.Int64Counter("paprika_insights_result_cache_evictions", metric.WithDescription("Result cache entries removed, by reason"))
	if err != nil {
		return nil, fmt.Errorf("create result cache eviction counter: %w", err)
	}
	bytes, err := meter.Int64Gauge("paprika_insights_result_cache_bytes", metric.WithDescription("Estimated bytes held by the result cache"))
	if err != nil {
		return nil, fmt.Errorf("create result cache bytes gauge: %w", err)
	}
	entries, err := meter.Int64Gauge("paprika_insights_result_cache_entries", metric.WithDescription("Entries held by the result cache"))
	if err != nil {
		return nil, fmt.Errorf("create result cache entries gauge: %w", err)
	}
	return &otelResultCacheMetrics{lookups: lookups, evictions: evictions, bytes: bytes, entries: entries}, nil
}

func (m *otelResultCacheMetrics) lookup(outcome, kind, reason string) {
	attributes := []attribute.KeyValue{attribute.String("outcome", outcome), attribute.String("kind", kind)}
	if reason != "" {
		attributes = append(attributes, attribute.String("reason", reason))
	}
	m.lookups.Add(context.Background(), 1, metric.WithAttributes(attributes...))
}

func (m *otelResultCacheMetrics) evicted(reason string) {
	m.evictions.Add(context.Background(), 1, metric.WithAttributes(attribute.String("reason", reason)))
}

func (m *otelResultCacheMetrics) usage(bytes, entries int) {
	m.bytes.Record(context.Background(), int64(bytes))
	m.entries.Record(context.Background(), int64(entries))
}
