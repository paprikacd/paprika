package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-logr/logr"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/cache"
)

func TestAPIModeStartsWithoutError(t *testing.T) {
	t.Parallel()

	fakeK8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte(`{}`)); err != nil {
			t.Errorf("Failed to write fake Kubernetes response: %v", err)
		}
	}))
	defer fakeK8s.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("fake-token"), 0o600); err != nil {
		t.Fatal(err)
	}

	probeAddrCh := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runAPIMode(ctx, &cliConfig{
			mode:         "api",
			k8sAPIServer: fakeK8s.URL,
			k8sTokenFile: tokenFile,
			uiAddr:       ":0",
			probeAddr:    ":0",
		}, newScheme(), logr.Discard(), probeAddrCh)
	}()

	var probeAddr string
	select {
	case probeAddr = <-probeAddrCh:
	case err := <-errCh:
		t.Fatalf("runAPIMode exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for API mode to bind")
	}

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("runAPIMode returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for runAPIMode to exit")
	}
}

func TestRepoServerHealthEndpoint(t *testing.T) {
	t.Parallel()

	probeAddrCh := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	k8sClient := fake.NewClientBuilder().WithScheme(newScheme()).Build()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runRepoServerMode(ctx, ":0", ":0", t.TempDir(), ":0", newScheme(), logr.Discard(), cache.Config{Backend: "memory"}, probeAddrCh, k8sClient)
	}()

	var probeAddr string
	select {
	case probeAddr = <-probeAddrCh:
	case err := <-errCh:
		t.Fatalf("runRepoServerMode exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for repo server to bind")
	}

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("runRepoServerMode returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for runRepoServerMode to exit")
	}
}

func TestBootstrapDefaultProjectsContinuesWhenOperatorNamespaceMissing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	scheme := newScheme()
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo", Namespace: "paprika-e2e"},
	}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithInterceptorFuncs(interceptor.Funcs{
			Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				if _, ok := obj.(*corev1alpha1.AppProject); ok && obj.GetNamespace() == "paprika-system" {
					return apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, obj.GetNamespace())
				}
				return c.Create(ctx, obj, opts...)
			},
		}).
		Build()

	bootstrapDefaultProjects(ctx, c, "paprika-system")

	var project corev1alpha1.AppProject
	if err := c.Get(context.Background(), client.ObjectKey{Name: "default", Namespace: "paprika-e2e"}, &project); err != nil {
		t.Fatalf("expected default AppProject in application namespace: %v", err)
	}
}

func waitForHealthz(ctx context.Context, probeAddr string) error {
	url := "http://" + probeAddr + "/healthz"
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("healthz returned status %d", resp.StatusCode)
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %w", ctx.Err(), lastErr)
		case <-ticker.C:
		}
	}
}
