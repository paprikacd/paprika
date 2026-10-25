package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

type namespaceCacheTransport func(*http.Request) (*http.Response, error)

func (f namespaceCacheTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

// Exercise actual controller-runtime informers against a Kubernetes API. A
// fake client does not reproduce cluster-scoped discovery or cache startup.
// make test/test-race supplies these binaries in CI.
func TestAPICacheNamespaceStartsWithoutClusterPolicyAccess(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("requires the envtest binaries supplied by make test/test-race")
	}
	environment := &envtest.Environment{CRDDirectoryPaths: []string{"../config/crd/bases"}, ErrorIfCRDPathMissing: true}
	config, err := environment.Start()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, environment.Stop()) })
	scheme := newScheme()
	admin, err := client.New(config, client.Options{Scheme: scheme})
	require.NoError(t, err)
	require.NoError(t, admin.Create(t.Context(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "review-cache"}}))

	for _, namespace := range []string{"review-cache", ""} {
		name := namespace
		if name == "" {
			name = "default-cluster-wide"
		}
		t.Run(name, func(t *testing.T) {
			testAPIInformerScope(t, config, namespace)
		})
	}
}

func testAPIInformerScope(t *testing.T, base *rest.Config, namespace string) {
	t.Helper()
	config := rest.CopyConfig(base)
	var rootCollections atomic.Int32
	var policyReads atomic.Int32
	config.Wrap(func(next http.RoundTripper) http.RoundTripper {
		return namespaceCacheTransport(func(req *http.Request) (*http.Response, error) {
			parts := strings.Split(strings.Trim(req.URL.Path, "/"), "/")
			rootCollection := len(parts) == 4 && parts[0] == "apis"
			if rootCollection {
				rootCollections.Add(1)
			}
			if strings.HasSuffix(req.URL.Path, "/policies") {
				policyReads.Add(1)
			}
			if namespace != "" && rootCollection {
				return &http.Response{
					StatusCode: http.StatusForbidden,
					Header:     http.Header{"Content-Type": {"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","message":"namespace-only test identity","code":403}`)),
					Request:    req,
				}, nil
			}
			return next.RoundTrip(req)
		})
	})
	ctx, cancel := context.WithCancel(t.Context())
	bundle, err := createAPICacheBundle(ctx, config, newScheme(), namespace)
	require.NoError(t, err)
	stopped := make(chan error, 1)
	go func() { stopped <- bundle.Cache.Start(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case stopErr := <-stopped:
			require.NoError(t, stopErr)
		case <-time.After(5 * time.Second):
			t.Error("API cache did not stop")
		}
	})
	syncCtx, syncCancel := context.WithTimeout(ctx, 5*time.Second)
	defer syncCancel()
	require.True(t, bundle.Cache.WaitForCacheSync(syncCtx), "namespace-only startup must not depend on a cluster Policy watch")
	if namespace != "" {
		require.Zero(t, rootCollections.Load(), "warming must never request an all-namespace or cluster collection")
		err = bundle.Client.List(ctx, &policyv1alpha1.PolicyList{})
		require.True(t, apierrors.IsForbidden(err), "explicit Policy reads must preserve the authorization error, not return an empty set")
		require.EqualValues(t, 1, policyReads.Load(), "denied Policy reads must not create a retrying informer")
	} else {
		require.Positive(t, policyReads.Load(), "the existing cluster-wide API still warms Policy")
		require.NoError(t, bundle.Client.List(ctx, &policyv1alpha1.PolicyList{}))
	}
}
