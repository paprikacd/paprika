/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestAdminDashboardFlags(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		var got adminDashboardOptions
		cmd := newAdminCmd(t.Context(), func(
			_ context.Context,
			opts *adminDashboardOptions,
			_, _ adminDashboardOutput,
		) error {
			got = *opts
			return nil
		})
		cmd.SetArgs([]string{"dashboard"})

		if err := cmd.ExecuteContext(t.Context()); err != nil {
			t.Fatalf("ExecuteContext() error = %v", err)
		}
		if got.LocalPort != 0 {
			t.Errorf("LocalPort = %d, want 0", got.LocalPort)
		}
		if got.Timeout != 30*time.Second {
			t.Errorf("Timeout = %s, want 30s", got.Timeout)
		}
	})

	t.Run("all supported overrides", func(t *testing.T) {
		var got adminDashboardOptions
		cmd := newAdminCmd(t.Context(), func(
			_ context.Context,
			opts *adminDashboardOptions,
			_, _ adminDashboardOutput,
		) error {
			got = *opts
			return nil
		})
		cmd.SetArgs([]string{
			"dashboard",
			"--kubeconfig=/tmp/cluster.yaml",
			"--context=omega",
			"--namespace=paprika-system",
			"--release=paprika-e2e",
			"--port=43821",
			"--no-open",
			"--timeout=45s",
			"--output=json",
		})

		if err := cmd.ExecuteContext(t.Context()); err != nil {
			t.Fatalf("ExecuteContext() error = %v", err)
		}
		if got.Kubeconfig != "/tmp/cluster.yaml" ||
			got.Context != "omega" ||
			got.Namespace != "paprika-system" ||
			got.Release != "paprika-e2e" ||
			got.LocalPort != 43821 ||
			!got.NoOpen ||
			got.Timeout != 45*time.Second ||
			got.Output != outputJSON {
			t.Fatalf("options = %#v, want all flag overrides", got)
		}
	})
}

func TestAdminDashboardFlagsUseExecuteContext(t *testing.T) {
	type contextKey struct{}
	constructorCtx := context.WithValue(t.Context(), contextKey{}, "constructor")
	executeCtx := context.WithValue(t.Context(), contextKey{}, "execute")
	var got string
	cmd := newAdminCmd(constructorCtx, func(
		ctx context.Context,
		_ *adminDashboardOptions,
		_, _ adminDashboardOutput,
	) error {
		got, _ = ctx.Value(contextKey{}).(string)
		return nil
	})
	cmd.SetArgs([]string{"dashboard"})

	if err := cmd.ExecuteContext(executeCtx); err != nil {
		t.Fatalf("ExecuteContext() error = %v", err)
	}
	if got != "execute" {
		t.Fatalf("runner context value = %q, want ExecuteContext value", got)
	}
}

func TestAdminDashboardFlagsExplainNamespaceTrustBoundary(t *testing.T) {
	var stdout bytes.Buffer
	cmd := newAdminCmd(t.Context(), func(
		context.Context,
		*adminDashboardOptions,
		adminDashboardOutput,
		adminDashboardOutput,
	) error {
		return nil
	})
	cmd.SetOut(&stdout)
	cmd.SetArgs([]string{"dashboard", "--help"})

	if err := cmd.ExecuteContext(t.Context()); err != nil {
		t.Fatalf("ExecuteContext() error = %v", err)
	}
	for _, want := range []string{
		"namespace pod-creation boundary",
		"trusted platform operators",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("help output does not contain %q:\n%s", want, stdout.String())
		}
	}
}

func TestAdminDashboardFlagsRejectYAMLBeforeKubernetesAccess(t *testing.T) {
	called := false
	cmd := newAdminCmd(t.Context(), func(
		_ context.Context,
		_ *adminDashboardOptions,
		_, _ adminDashboardOutput,
	) error {
		called = true
		return nil
	})
	cmd.SetArgs([]string{"dashboard", "--output=yaml"})

	err := cmd.ExecuteContext(t.Context())
	if err == nil || !strings.Contains(err.Error(), "YAML") {
		t.Fatalf("ExecuteContext() error = %v, want actionable YAML rejection", err)
	}
	if called {
		t.Fatal("Kubernetes runner called for rejected YAML output")
	}
}

func TestAdminDashboardFlagsJSONWritesOneReadinessObject(t *testing.T) {
	var stdout, stderr bytes.Buffer
	cmd := newAdminCmd(t.Context(), func(
		_ context.Context,
		_ *adminDashboardOptions,
		out, progress adminDashboardOutput,
	) error {
		if err := progress.WriteProgress("discovering pods"); err != nil {
			return err
		}
		return out.WriteReady(adminDashboardReady{
			Context:   "omega",
			Namespace: "paprika-system",
			Pod:       "paprika-api-2",
			URL:       "http://127.0.0.1:43123/dashboard/",
		}, outputJSON)
	})
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{"dashboard", "--output=json", "--no-open"})

	if err := cmd.ExecuteContext(t.Context()); err != nil {
		t.Fatalf("ExecuteContext() error = %v", err)
	}

	dec := json.NewDecoder(&stdout)
	var ready adminDashboardReady
	if err := dec.Decode(&ready); err != nil {
		t.Fatalf("decode readiness: %v; stdout=%q", err, stdout.String())
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err == nil {
		t.Fatalf("stdout contains more than one JSON value: %q", stdout.String())
	}
	if strings.Contains(stdout.String(), "discovering") {
		t.Fatalf("progress leaked to stdout: %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "discovering") {
		t.Fatalf("stderr = %q, want progress", stderr.String())
	}
	if ready.Pod != "paprika-api-2" {
		t.Errorf("ready.Pod = %q, want paprika-api-2", ready.Pod)
	}
}

func TestAdminKubeconfigFailurePrecedesDiscoveryAndReadiness(t *testing.T) {
	tests := []struct {
		name string
		auth clientcmdapi.AuthInfo
	}{
		{
			name: "client certificate only",
			auth: clientcmdapi.AuthInfo{
				ClientCertificateData: []byte("certificate"),
				ClientKeyData:         []byte("key"),
			},
		},
		{
			name: "request signing only",
			auth: clientcmdapi.AuthInfo{
				AuthProvider: &clientcmdapi.AuthProviderConfig{Name: "gcp"},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kubeconfigPath := filepath.Join(t.TempDir(), "config")
			err := clientcmd.WriteToFile(clientcmdapi.Config{
				Clusters: map[string]*clientcmdapi.Cluster{
					"cluster": {Server: "https://cluster.invalid"},
				},
				AuthInfos: map[string]*clientcmdapi.AuthInfo{
					"user": &tt.auth,
				},
				Contexts: map[string]*clientcmdapi.Context{
					"omega": {Cluster: "cluster", AuthInfo: "user", Namespace: "paprika"},
				},
				CurrentContext: "omega",
			}, kubeconfigPath)
			if err != nil {
				t.Fatalf("write kubeconfig: %v", err)
			}

			var stdout, stderr bytes.Buffer
			discovered := false
			deps := testAdminDashboardDependencies(nil)
			deps.loadKubeconfig = loadAdminKubeconfig
			deps.newPodLister = func(*rest.Config) (adminPodLister, error) {
				discovered = true
				return nil, errors.New("must not discover")
			}

			err = runAdminDashboardWithDependencies(
				t.Context(),
				&adminDashboardOptions{
					Kubeconfig: kubeconfigPath,
					Timeout:    time.Second,
					Output:     outputJSON,
				},
				adminDashboardOutput{writer: &stdout},
				adminDashboardOutput{writer: &stderr},
				deps,
			)
			if err == nil || !strings.Contains(err.Error(), "OIDC") {
				t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
			}
			if discovered {
				t.Fatal("pod discovery ran after unsupported credentials")
			}
			if stdout.Len() != 0 {
				t.Fatalf("readiness output emitted after unsupported credentials: %q", stdout.String())
			}
		})
	}
}

func TestAdminKubeconfigCredentialFactoryFailsClosedAndRedacts(t *testing.T) {
	credential := strings.Repeat("s", 43)
	var stdout, stderr bytes.Buffer
	discovered := false
	deps := testAdminDashboardDependencies(nil)
	deps.loadKubeconfig = func(
		context.Context,
		*adminDashboardOptions,
	) (*adminKubeconfig, error) {
		return &adminKubeconfig{
			RESTConfig: &rest.Config{Host: "https://cluster.invalid", BearerToken: credential},
			Context:    "omega",
			Namespace:  "paprika",
		}, nil
	}
	deps.credentials = func(*rest.Config, http.RoundTripper) (http.RoundTripper, error) {
		return nil, fmt.Errorf("credential wrapper unavailable for %s", credential)
	}
	deps.newPodLister = func(*rest.Config) (adminPodLister, error) {
		discovered = true
		return nil, errors.New("must not discover")
	}

	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: &stdout},
		adminDashboardOutput{writer: &stderr},
		deps,
	)
	if err == nil || !strings.Contains(err.Error(), "credential wrapper unavailable") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
	if discovered {
		t.Fatal("pod discovery ran after credential transport failure")
	}
	for name, value := range map[string]string{
		"error":  err.Error(),
		"stdout": stdout.String(),
		"stderr": stderr.String(),
	} {
		if strings.Contains(value, credential) || strings.Contains(value, "Authorization") {
			t.Fatalf("%s leaked credential material: %q", name, value)
		}
	}
	if !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("credential failure was not visibly redacted: %v", err)
	}
}

func TestAdminPortForwardWorkflowJoinsSetupTimeout(t *testing.T) {
	joined := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		<-ctx.Done()
		close(joined)
		return adminPortForward{}, errors.New("forward setup cleanup failed")
	})

	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: 10 * time.Millisecond, Output: outputJSON},
		adminDashboardOutput{writer: io.Discard},
		adminDashboardOutput{writer: io.Discard},
		deps,
	)
	select {
	case <-joined:
	default:
		t.Fatal("dashboard returned before the in-flight forwarding setup completed")
	}
	if err == nil ||
		!strings.Contains(err.Error(), context.DeadlineExceeded.Error()) ||
		!strings.Contains(err.Error(), "forward setup cleanup failed") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v, want timeout and joined setup error", err)
	}
}

func TestAdminPortForwardWorkflowJoinsOutputFailure(t *testing.T) {
	joined := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-ctx.Done()
			close(joined)
			done <- errors.New("tunnel cleanup failed")
			close(done)
		}()
		return adminPortForward{LocalPort: 43123, Done: done}, nil
	})

	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: errorWriter{err: errors.New("readiness write failed")}},
		adminDashboardOutput{writer: io.Discard},
		deps,
	)
	select {
	case <-joined:
	default:
		t.Fatal("dashboard returned before the active tunnel completed")
	}
	if err == nil ||
		!strings.Contains(err.Error(), "readiness write failed") ||
		!strings.Contains(err.Error(), "tunnel cleanup failed") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v, want output and joined tunnel errors", err)
	}
}

func TestAdminPortForwardWorkflowWaitsForTunnelGoroutineAfterDone(t *testing.T) {
	release := make(chan struct{})
	joined := make(chan struct{})
	cancelled := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-ctx.Done()
			close(cancelled)
			done <- errors.New("tunnel stopped")
			close(done)
			<-release
			close(joined)
		}()
		return adminPortForward{LocalPort: 43123, Done: done, Joined: joined}, nil
	})
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			t.Context(),
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
			adminDashboardOutput{writer: errorWriter{err: errors.New("readiness write failed")}},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-cancelled
	select {
	case err := <-result:
		close(release)
		t.Fatalf("dashboard returned before tunnel goroutine joined: %v", err)
	default:
	}
	close(release)
	err := <-result
	if err == nil ||
		!strings.Contains(err.Error(), "readiness write failed") ||
		!strings.Contains(err.Error(), "tunnel stopped") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
}

func TestAdminPortForwardWorkflowJoinsSpontaneousTunnelFailure(t *testing.T) {
	release := make(chan struct{})
	joined := make(chan struct{})
	doneSent := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		context.Context,
		*rest.Config,
		string,
		string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			done <- errors.New("pod connection lost")
			close(done)
			close(doneSent)
			<-release
			close(joined)
		}()
		return adminPortForward{LocalPort: 43123, Done: done, Joined: joined}, nil
	})
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			t.Context(),
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
			adminDashboardOutput{writer: io.Discard},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-doneSent
	select {
	case err := <-result:
		close(release)
		t.Fatalf("dashboard returned before failed tunnel goroutine joined: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	err := <-result
	if err == nil || !strings.Contains(err.Error(), "pod connection lost") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
}

func TestAdminPortForwardWorkflowJoinsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	joined := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		forwardCtx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-forwardCtx.Done()
			close(joined)
			done <- nil
			close(done)
		}()
		return adminPortForward{LocalPort: 43123, Done: done}, nil
	})
	var stdout, progress bytes.Buffer

	err := runAdminDashboardWithDependencies(
		ctx,
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: cancelWriter{writer: &stdout, cancel: cancel}},
		adminDashboardOutput{writer: &progress},
		deps,
	)
	if err != nil {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
	select {
	case <-joined:
	default:
		t.Fatal("dashboard returned before the cancelled tunnel completed")
	}
	if lines := strings.Count(strings.TrimSpace(stdout.String()), "\n") + 1; lines != 1 {
		t.Fatalf("stdout contains %d readiness lines: %q", lines, stdout.String())
	}
	for _, want := range []string{
		"namespace pod-creation boundary",
		"trusted platform operators",
	} {
		if !strings.Contains(progress.String(), want) {
			t.Errorf("runtime warning does not contain %q: %q", want, progress.String())
		}
	}
}

type errorWriter struct {
	err error
}

func (w errorWriter) Write([]byte) (int, error) {
	return 0, w.err
}

type cancelWriter struct {
	writer io.Writer
	cancel context.CancelFunc
}

func (w cancelWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.cancel()
	return n, err
}

func testAdminDashboardDependencies(
	forward func(context.Context, *rest.Config, string, string) (adminPortForward, error),
) adminDashboardDependencies {
	if forward == nil {
		forward = func(
			context.Context,
			*rest.Config,
			string,
			string,
		) (adminPortForward, error) {
			return adminPortForward{}, errors.New("forward must not run")
		}
	}
	return adminDashboardDependencies{
		loadKubeconfig: func(
			context.Context,
			*adminDashboardOptions,
		) (*adminKubeconfig, error) {
			return &adminKubeconfig{
				RESTConfig: &rest.Config{
					Host:        "https://cluster.invalid",
					BearerToken: strings.Repeat("k", 32),
				},
				Context:   "omega",
				Namespace: "paprika",
			}, nil
		},
		newPodLister: func(*rest.Config) (adminPodLister, error) {
			return func(
				context.Context,
				string,
				metav1.ListOptions,
			) (*corev1.PodList, error) {
				return &corev1.PodList{Items: []corev1.Pod{{
					ObjectMeta: metav1.ObjectMeta{
						Name: "api-1",
						Labels: map[string]string{
							"app.kubernetes.io/name":       "paprika",
							"app.kubernetes.io/managed-by": "Helm",
							"app.kubernetes.io/instance":   "paprika",
							"app.kubernetes.io/component":  "api-server",
						},
					},
					Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
						Type: corev1.PodReady, Status: corev1.ConditionTrue,
					}}},
				}}}, nil
			}, nil
		},
		newReviewer: func(*rest.Config) (adminAccessReviewer, error) {
			return func(
				context.Context,
				*authorizationv1.SelfSubjectAccessReview,
			) (*authorizationv1.SelfSubjectAccessReview, error) {
				return &authorizationv1.SelfSubjectAccessReview{
					Status: authorizationv1.SubjectAccessReviewStatus{Allowed: true},
				}, nil
			}, nil
		},
		forward:     forward,
		credentials: adminCredentialRoundTripper,
		now:         time.Now,
	}
}
