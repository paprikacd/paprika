package kube

import (
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

func TestNegotiationLeavesTheCallersConfigAlone(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		apply           func(*rest.Config) *rest.Config
		wantContentType string
	}{
		// Custom resources are JSON-only, so a config that may reach one must
		// keep sending JSON while still accepting protobuf for built-in reads.
		"responses only": {
			apply:           WithProtobufResponses,
			wantContentType: runtime.ContentTypeJSON,
		},
		"both ways": {
			apply:           WithProtobufBothWays,
			wantContentType: runtime.ContentTypeProtobuf,
		},
	}

	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			base := &rest.Config{
				Host:          "https://example.test",
				ContentConfig: rest.ContentConfig{ContentType: "original"},
			}
			got := test.apply(base)

			require.Equal(t, acceptProtobufThenJSON, got.AcceptContentTypes)
			require.Equal(t, test.wantContentType, got.ContentType)
			require.Equal(t, "https://example.test", got.Host)

			// A manager's base config is shared with CRD clients; mutating it
			// in place would change their wire format too.
			require.Equal(t, "original", base.ContentType,
				"the caller's config must not be mutated")
			require.Empty(t, base.AcceptContentTypes)
		})
	}
}

func TestNegotiationToleratesANilConfig(t *testing.T) {
	t.Parallel()

	require.Nil(t, WithProtobufResponses(nil))
	require.Nil(t, WithProtobufBothWays(nil))
}

// countingBuilder is a hand-written fake: it records how many clientsets were
// built so the tests can assert the cache actually caches.
type countingBuilder struct {
	calls atomic.Int64
	err   error
}

func (b *countingBuilder) build(*rest.Config) (kubernetes.Interface, *http.Client, error) {
	b.calls.Add(1)
	if b.err != nil {
		return nil, nil, b.err
	}
	return fake.NewSimpleClientset(), &http.Client{}, nil
}

func config(host, token string) *rest.Config {
	return &rest.Config{Host: host, BearerToken: token}
}

func TestClientsBuildsOncePerCluster(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)
	cfg := config("https://a.test", "token-1")

	for range 5 {
		got, err := clients.For("fleet/a", cfg)
		require.NoError(t, err)
		require.NotNil(t, got)
	}

	require.Equal(t, int64(1), builder.calls.Load(),
		"a cached client must not be rebuilt per call")
	require.Equal(t, 1, clients.Len())
}

func TestClientsBuildsOnceUnderConcurrentReconciles(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)
	cfg := config("https://a.test", "token-1")

	var group sync.WaitGroup
	for range 32 {
		group.Go(func() {
			_, err := clients.For("fleet/a", cfg)
			require.NoError(t, err)
		})
	}
	group.Wait()

	require.Equal(t, int64(1), builder.calls.Load(),
		"concurrent reconciles of one cluster must share a single build")
}

func TestClientsKeepsClustersApart(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)

	_, err := clients.For("fleet/a", config("https://a.test", "token-a"))
	require.NoError(t, err)
	_, err = clients.For("fleet/b", config("https://b.test", "token-b"))
	require.NoError(t, err)

	require.Equal(t, int64(2), builder.calls.Load())
	require.Equal(t, 2, clients.Len())
}

func TestClientsRebuildsWhenCredentialsRotate(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)

	_, err := clients.For("fleet/a", config("https://a.test", "token-1"))
	require.NoError(t, err)
	_, err = clients.For("fleet/a", config("https://a.test", "token-1"))
	require.NoError(t, err)
	require.Equal(t, int64(1), builder.calls.Load())

	// A rotated kubeconfig must not keep authenticating with the old token.
	_, err = clients.For("fleet/a", config("https://a.test", "token-2"))
	require.NoError(t, err)
	require.Equal(t, int64(2), builder.calls.Load())
	require.Equal(t, 1, clients.Len(), "the stale entry must be replaced, not accumulated")
}

func TestClientsDoesNotCacheAFailedBuild(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{err: errors.New("api server unreachable")}
	clients := NewClientsWithBuilder(builder.build)
	cfg := config("https://a.test", "token-1")

	_, err := clients.For("fleet/a", cfg)
	require.Error(t, err)

	// A cluster that was unreachable at startup has to be able to recover.
	builder.err = nil
	got, err := clients.For("fleet/a", cfg)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, int64(2), builder.calls.Load())
}

func TestClientsForgetAndClose(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)
	_, err := clients.For("fleet/a", config("https://a.test", "t"))
	require.NoError(t, err)
	_, err = clients.For("fleet/b", config("https://b.test", "t"))
	require.NoError(t, err)

	clients.Forget("fleet/a")
	require.Equal(t, 1, clients.Len())

	clients.Close()
	require.Equal(t, 0, clients.Len())
	clients.Close() // must be idempotent
}

func TestClientsRejectsANilConfig(t *testing.T) {
	t.Parallel()

	clients := NewClientsWithBuilder((&countingBuilder{}).build)
	_, err := clients.For("fleet/a", nil)
	require.Error(t, err)
}

func TestFingerprintSeparatesCredentials(t *testing.T) {
	t.Parallel()

	base := config("https://a.test", "token-1")
	require.Equal(t, fingerprint(base), fingerprint(config("https://a.test", "token-1")))
	require.NotEqual(t, fingerprint(base), fingerprint(config("https://a.test", "token-2")))
	require.NotEqual(t, fingerprint(base), fingerprint(config("https://b.test", "token-1")))

	// Length prefixing keeps adjacent fields from bleeding into each other.
	require.NotEqual(t,
		fingerprint(&rest.Config{Host: "ab", BearerToken: "c"}),
		fingerprint(&rest.Config{Host: "a", BearerToken: "bc"}),
	)

	// The digest must not carry the secret it is derived from.
	require.NotContains(t, fingerprint(base), "token-1")
}

func TestRequestTimeoutIsCopiedNotMutated(t *testing.T) {
	t.Parallel()

	base := &rest.Config{Host: "https://a.test"}
	got := RequestTimeout(base, 10*time.Second)

	require.Equal(t, 10*time.Second, got.Timeout)
	require.Zero(t, base.Timeout, "the caller's config must not be mutated")
	require.Same(t, base, RequestTimeout(base, 0), "a non-positive timeout is a no-op")
}

func TestMetricsClientSharesTheClusterEntry(t *testing.T) {
	t.Parallel()

	// The metrics client is why this cache grew a second client type: a
	// capacity read asks nodes and pods of the core API and node metrics of
	// metrics.k8s.io, and building the second one per read would pay a fresh
	// TLS handshake per cluster per read.
	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)
	cfg := config("https://a.test", "token-1")

	first, err := clients.MetricsFor("fleet/a", cfg)
	require.NoError(t, err)
	require.NotNil(t, first)

	second, err := clients.MetricsFor("fleet/a", cfg)
	require.NoError(t, err)
	require.Same(t, first, second, "a cached metrics client must not be rebuilt per call")

	core, err := clients.For("fleet/a", cfg)
	require.NoError(t, err)
	require.NotNil(t, core)

	require.Equal(t, int64(1), builder.calls.Load(),
		"the core and metrics clients share one build")
	require.Equal(t, 1, clients.Len(), "both clients live in one cache entry")
}

func TestMetricsClientIsRebuiltWhenCredentialsRotate(t *testing.T) {
	t.Parallel()

	builder := &countingBuilder{}
	clients := NewClientsWithBuilder(builder.build)

	before, err := clients.MetricsFor("fleet/a", config("https://a.test", "token-1"))
	require.NoError(t, err)

	// The same eviction rule the core client follows: a rotated kubeconfig
	// must not keep authenticating with the old token.
	after, err := clients.MetricsFor("fleet/a", config("https://a.test", "token-2"))
	require.NoError(t, err)
	require.NotSame(t, before, after)
	require.Equal(t, int64(2), builder.calls.Load())
	require.Equal(t, 1, clients.Len(), "the stale entry must be replaced, not accumulated")
}

func TestMetricsClientRejectsANilConfig(t *testing.T) {
	t.Parallel()

	clients := NewClientsWithBuilder((&countingBuilder{}).build)
	_, err := clients.MetricsFor("fleet/a", nil)
	require.Error(t, err)
}
