package kube

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/metrics/pkg/client/clientset/versioned"
)

// ClientBuilder constructs a clientset and the HTTP client backing it. It is a
// seam so tests can exercise the cache without a real API server.
type ClientBuilder func(*rest.Config) (kubernetes.Interface, *http.Client, error)

// MetricsBuilder constructs the metrics.k8s.io clientset for a cluster over an
// HTTP client that has already been built for it, so the aggregated API shares
// the connection pool the core API is already using. It is a separate seam from
// ClientBuilder because a cache built with a hand-written ClientBuilder (as the
// tests do) still gets a real, cheap-to-construct metrics client.
type MetricsBuilder func(*rest.Config, *http.Client) (versioned.Interface, error)

// Clients hands out one long-lived Kubernetes client per remote cluster.
//
// Building a clientset per reconcile — which is what this replaces — throws
// away the connection pool every time, so each health check pays a fresh TCP
// handshake and TLS negotiation against every managed cluster. Holding one
// client per cluster keeps those connections warm.
//
// It caches two clients per cluster, not one: the core kubernetes.Interface and
// the metrics.k8s.io versioned.Interface, built over the same *http.Client.
// They are cached together because they are the same connection to the same API
// server under two generated clients — a capacity read touches both (nodes and
// pods through one, node metrics through the other), and building the metrics
// client per read would pay a TLS handshake per cluster per read for exactly
// the reason this cache exists.
//
// The entry map is a sync.Map rather than a mutex-guarded map because the
// access pattern is the one sync.Map is built for: a key set bounded by the
// number of registered clusters, written once when a cluster appears, and read
// on every reconcile thereafter. An RWMutex would put every reconcile across
// every cluster behind one lock for a value that almost never changes.
type Clients struct {
	build        ClientBuilder
	buildMetrics MetricsBuilder

	// clusterKey -> *entry. Never deleted except by Close or a credential
	// change, so the map stays the size of the fleet.
	entries sync.Map
}

type entry struct {
	// once guards construction so N concurrent reconciles of the same cluster
	// build one client, not N.
	once sync.Once

	fingerprint string
	client      kubernetes.Interface
	http        *http.Client
	err         error

	// metrics and metricsErr are kept apart from client and err on purpose: a
	// cluster with no metrics.k8s.io client must still serve core reads. See
	// MetricsFor.
	metrics    versioned.Interface
	metricsErr error
}

// NewClients returns a cache that builds real clientsets.
func NewClients() *Clients {
	return &Clients{build: defaultBuilder, buildMetrics: defaultMetricsBuilder}
}

// NewClientsWithBuilder returns a cache that builds clients through fn.
func NewClientsWithBuilder(fn ClientBuilder) *Clients {
	return &Clients{build: fn, buildMetrics: defaultMetricsBuilder}
}

func defaultBuilder(cfg *rest.Config) (kubernetes.Interface, *http.Client, error) {
	httpClient, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("building http client: %w", err)
	}
	clientset, err := kubernetes.NewForConfigAndClient(cfg, httpClient)
	if err != nil {
		return nil, nil, fmt.Errorf("building clientset: %w", err)
	}
	return clientset, httpClient, nil
}

// defaultMetricsBuilder builds the metrics.k8s.io clientset over httpClient, so
// it reuses the connection pool the core clientset already holds for cfg.
func defaultMetricsBuilder(cfg *rest.Config, httpClient *http.Client) (versioned.Interface, error) {
	metricsClient, err := versioned.NewForConfigAndClient(cfg, httpClient)
	if err != nil {
		return nil, fmt.Errorf("building metrics clientset: %w", err)
	}
	return metricsClient, nil
}

// For returns the client for clusterKey, building it on first use.
//
// cfg is expected to carry a per-request timeout already; the returned client
// is shared, so callers must not mutate it.
//
// When cfg's credentials differ from the ones the cached client was built with
// — a rotated kubeconfig, a new CA — the old client is discarded and its idle
// connections closed before a replacement is built.
func (c *Clients) For(clusterKey string, cfg *rest.Config) (kubernetes.Interface, error) {
	current, err := c.entryFor(clusterKey, cfg)
	if err != nil {
		return nil, err
	}
	return current.client, nil
}

// MetricsFor returns the metrics.k8s.io client for clusterKey, building it on
// first use alongside the core client and sharing that client's connections.
//
// cfg must be the same config For is called with for this cluster: the two
// clients live in one cache entry, keyed by the same credential fingerprint and
// evicted together when those credentials rotate.
//
// A metrics client that could not be built is reported here and only here — the
// core client is still served, because metrics.k8s.io is an optional add-on and
// its absence must not take capacity's structural half down with it. That
// failure is not evicted on a read: unlike an unreachable API server, a config
// the generated client refuses is deterministic, so retrying it per read would
// rebuild the same error.
func (c *Clients) MetricsFor(clusterKey string, cfg *rest.Config) (versioned.Interface, error) {
	current, err := c.entryFor(clusterKey, cfg)
	if err != nil {
		return nil, err
	}
	if current.metricsErr != nil {
		return nil, current.metricsErr
	}
	if current.metrics == nil {
		return nil, fmt.Errorf("no metrics client is configured for cluster %q", clusterKey)
	}
	return current.metrics, nil
}

// entryFor returns the built cache entry for clusterKey, which holds every
// client this cache hands out for that cluster.
func (c *Clients) entryFor(clusterKey string, cfg *rest.Config) (*entry, error) {
	if cfg == nil {
		return nil, fmt.Errorf("no rest config for cluster %q", clusterKey)
	}
	want := fingerprint(cfg)

	for {
		loaded, _ := c.entries.LoadOrStore(clusterKey, &entry{fingerprint: want})
		current, ok := loaded.(*entry)
		if !ok {
			return nil, fmt.Errorf("cluster %q holds an unexpected cache entry", clusterKey)
		}

		if current.fingerprint != want {
			// Credentials changed. Drop the stale entry and retry; whichever
			// caller wins the delete race rebuilds, the rest observe the new
			// entry on the next iteration.
			if c.entries.CompareAndDelete(clusterKey, loaded) {
				closeIdle(current)
			}
			continue
		}

		current.once.Do(func() {
			current.client, current.http, current.err = c.build(cfg)
			if current.err != nil || c.buildMetrics == nil {
				return
			}
			current.metrics, current.metricsErr = c.buildMetrics(cfg, current.http)
		})
		if current.err != nil {
			// A failed build must not be cached forever, or a cluster that was
			// briefly unreachable at startup never recovers.
			c.entries.CompareAndDelete(clusterKey, loaded)
			return nil, current.err
		}
		return current, nil
	}
}

// Forget drops the client for clusterKey and closes its idle connections. Call
// it when a cluster is deregistered.
func (c *Clients) Forget(clusterKey string) {
	if loaded, ok := c.entries.LoadAndDelete(clusterKey); ok {
		if current, isEntry := loaded.(*entry); isEntry {
			closeIdle(current)
		}
	}
}

// Close releases every cached client. Safe to call more than once.
func (c *Clients) Close() {
	c.entries.Range(func(key, value any) bool {
		c.entries.Delete(key)
		if current, ok := value.(*entry); ok {
			closeIdle(current)
		}
		return true
	})
}

// Len reports how many clusters are cached. Intended for tests and metrics.
func (c *Clients) Len() int {
	count := 0
	c.entries.Range(func(_, _ any) bool {
		count++
		return true
	})
	return count
}

func closeIdle(e *entry) {
	// The entry may never have been built; once.Do makes this safe to read.
	if e.http == nil {
		return
	}
	if closer, ok := e.http.Transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
		return
	}
	e.http.CloseIdleConnections()
}

// fingerprint hashes the parts of a rest.Config that decide who we authenticate
// as and who we trust. Two configs with the same fingerprint can share a
// connection pool; two that differ must not.
//
// The values are hashed rather than concatenated into a key so bearer tokens
// and private keys never sit in a map key, a log line or a metric label.
func fingerprint(cfg *rest.Config) string {
	// Built into one buffer and hashed in a single call: hash.Hash.Write never
	// returns an error, so routing through an io.Writer would only produce
	// error returns that exist to be ignored.
	var buf []byte
	add := func(parts ...string) {
		for _, part := range parts {
			// Length-prefix so ("ab","c") and ("a","bc") do not collide.
			buf = strconv.AppendInt(buf, int64(len(part)), 10)
			buf = append(buf, ':')
			buf = append(buf, part...)
			buf = append(buf, '|')
		}
	}

	add(cfg.Host, cfg.APIPath)
	add(cfg.Username, cfg.Password, cfg.BearerToken, cfg.BearerTokenFile)
	// ServerName, CAFile and friends are promoted from the embedded
	// TLSClientConfig.
	add(cfg.ServerName, cfg.CAFile, cfg.CertFile, cfg.KeyFile)
	add(string(cfg.CAData), string(cfg.CertData), string(cfg.KeyData))
	add(cfg.Impersonate.UserName, cfg.Impersonate.UID)
	add(cfg.AcceptContentTypes, cfg.ContentType)
	add(strconv.FormatBool(cfg.Insecure), cfg.Timeout.String())

	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:])
}

// RequestTimeout returns a copy of cfg whose requests give up after d.
//
// client-go's generated clients do not all take a context — Discovery's
// ServerVersion is the one this control plane leans on — so a deadline has to
// travel on the config rather than the call.
func RequestTimeout(cfg *rest.Config, d time.Duration) *rest.Config {
	if cfg == nil || d <= 0 {
		return cfg
	}
	out := rest.CopyConfig(cfg)
	out.Timeout = d
	return out
}
