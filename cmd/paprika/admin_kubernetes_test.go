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
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/client-go/tools/portforward"
	transportspdy "k8s.io/client-go/transport/spdy"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

var adminOIDCTestSequence atomic.Uint64

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestAdminKubeconfigStaticBearerUsesClientGoWrapper(t *testing.T) {
	credential := strings.Repeat("x", 37)
	var gotAuthorization string
	base := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodPost ||
			req.URL.String() != "http://127.0.0.1:43123/admin/session/exchange" {
			t.Fatalf("exchange request = %s %s", req.Method, req.URL)
		}
		gotAuthorization = req.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("{}")),
			Request:    req,
		}, nil
	})

	client, err := newAdminExchangeRequestClient(
		&rest.Config{
			Host:        "https://cluster.invalid",
			BearerToken: credential,
		},
		base,
		adminCredentialRoundTripper,
	)
	if err != nil {
		t.Fatalf("newAdminExchangeRequestClient() error = %v", err)
	}
	resp, err := client.RoundTrip(t.Context(), "http://127.0.0.1:43123/admin/session/exchange")
	if err != nil {
		t.Fatalf("RoundTrip() error = %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close response body: %v", err)
	}
	if gotAuthorization != "Bearer "+credential {
		t.Fatal("client-go bearer wrapper did not authenticate the loopback request")
	}
}

func TestAdminKubeconfigExecBearerUsesClientGoWrapper(t *testing.T) {
	if os.Getenv("GO_WANT_ADMIN_EXEC_HELPER") == "1" {
		_, _ = fmt.Fprintln(os.Stdout, `{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"exec-helper-value"}}`)
		os.Exit(0)
	}

	var gotAuthorization string
	base := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		gotAuthorization = req.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("{}")),
			Request:    req,
		}, nil
	})
	cfg := &rest.Config{
		Host: "https://cluster.invalid",
		ExecProvider: &api.ExecConfig{
			Command:         os.Args[0],
			Args:            []string{"-test.run=TestAdminKubeconfigExecBearerUsesClientGoWrapper"},
			Env:             []api.ExecEnvVar{{Name: "GO_WANT_ADMIN_EXEC_HELPER", Value: "1"}},
			APIVersion:      "client.authentication.k8s.io/v1",
			InteractiveMode: api.NeverExecInteractiveMode,
		},
	}

	client, err := newAdminExchangeRequestClient(cfg, base, adminCredentialRoundTripper)
	if err != nil {
		t.Fatalf("newAdminExchangeRequestClient() error = %v", err)
	}
	resp, err := client.RoundTrip(t.Context(), "http://127.0.0.1:43123/admin/session/exchange")
	if err != nil {
		t.Fatalf("RoundTrip() error = %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close response body: %v", err)
	}
	if gotAuthorization != "Bearer exec-helper-value" {
		t.Fatal("client-go exec wrapper did not authenticate the loopback request")
	}
}

func TestAdminKubeconfigOIDCBearerUsesProductionExchangeRequest(t *testing.T) {
	sequence := adminOIDCTestSequence.Add(1)
	credential := testAdminOIDCToken(t, time.Unix(4_102_444_800, 0))
	var gotAuthorization string
	base := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		gotAuthorization = req.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusNoContent,
			Header:     make(http.Header),
			Body:       http.NoBody,
			Request:    req,
		}, nil
	})
	cfg := &rest.Config{
		Host: fmt.Sprintf("https://cluster-%d.invalid", sequence),
		AuthProvider: &api.AuthProviderConfig{
			Name: "oidc",
			Config: map[string]string{
				"idp-issuer-url": fmt.Sprintf("https://identity-%d.invalid", sequence),
				"client-id":      fmt.Sprintf("paprika-cli-%d", sequence),
				"id-token":       credential,
			},
		},
	}

	client, err := newAdminExchangeRequestClient(cfg, base, adminCredentialRoundTripper)
	if err != nil {
		t.Fatalf("newAdminExchangeRequestClient() error = %v", err)
	}
	resp, err := client.RoundTrip(t.Context(), "http://127.0.0.1:43123/admin/session/exchange")
	if err != nil {
		t.Fatalf("RoundTrip() error = %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close response body: %v", err)
	}
	if gotAuthorization != "Bearer "+credential {
		t.Fatal("client-go OIDC wrapper did not authenticate the production-built exchange request")
	}
}

func testAdminOIDCToken(t *testing.T, expiry time.Time) string {
	t.Helper()
	encode := base64.RawURLEncoding.EncodeToString
	return strings.Join([]string{
		encode([]byte(`{"alg":"none","typ":"JWT"}`)),
		encode(fmt.Appendf(nil, `{"exp":%d}`, expiry.Unix())),
		"signature",
	}, ".")
}

func TestAdminKubeconfigRejectsNonBearerCredentials(t *testing.T) {
	tests := []struct {
		name string
		auth api.AuthInfo
	}{
		{
			name: "client certificate only",
			auth: api.AuthInfo{ClientCertificateData: []byte("certificate"), ClientKeyData: []byte("key")},
		},
		{
			name: "request signing only",
			auth: api.AuthInfo{AuthProvider: &api.AuthProviderConfig{Name: "gcp"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateAdminBearerCredentials(&tt.auth)
			if err == nil {
				t.Fatal("validateAdminBearerCredentials() error = nil")
			}
			for _, want := range []string{"bearer", "OIDC", "exec"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not contain %q", err, want)
				}
			}
		})
	}
}

func TestAdminKubeconfigOIDCProviderIsRegistered(t *testing.T) {
	sequence := adminOIDCTestSequence.Add(1)
	_, err := rest.GetAuthProvider(
		fmt.Sprintf("https://registration-cluster-%d.invalid", sequence),
		&api.AuthProviderConfig{
			Name: "oidc",
			Config: map[string]string{
				"idp-issuer-url": fmt.Sprintf("https://registration-identity-%d.invalid", sequence),
				"client-id":      fmt.Sprintf("registration-cli-%d", sequence),
				"id-token":       "header.payload.signature",
			},
		},
		nil,
	)
	if err != nil && strings.Contains(err.Error(), "no Auth Provider found") {
		t.Fatalf("OIDC kubeconfig provider is not registered: %v", err)
	}
}

func TestAdminKubeconfigRedactsAllConfiguredCredentialForms(t *testing.T) {
	values := map[string]string{
		"bearer":        strings.Repeat("b", 31),
		"username":      strings.Repeat("u", 17),
		"password":      strings.Repeat("p", 29),
		"id-token":      strings.Repeat("i", 37),
		"refresh-token": strings.Repeat("r", 41),
		"client-secret": strings.Repeat("c", 43),
		"exec-one":      strings.Repeat("e", 47),
		"exec-two":      strings.Repeat("v", 53),
	}
	config := &rest.Config{
		BearerToken: values["bearer"],
		Username:    values["username"],
		Password:    values["password"],
		AuthProvider: &api.AuthProviderConfig{
			Name: "oidc",
			Config: map[string]string{
				"id-token":      values["id-token"],
				"refresh-token": values["refresh-token"],
				"client-secret": values["client-secret"],
			},
		},
		ExecProvider: &api.ExecConfig{
			Env: []api.ExecEnvVar{
				{Name: "FIRST", Value: values["exec-one"]},
				{Name: "SECOND", Value: values["exec-two"]},
				{Name: "EMPTY", Value: ""},
			},
		},
	}
	raw := strings.Join([]string{
		values["bearer"],
		values["username"],
		values["password"],
		values["id-token"],
		values["refresh-token"],
		values["client-secret"],
		values["exec-one"],
		values["exec-two"],
	}, " ")

	redacted := redactAdminCredentialError(config, errors.New(raw))
	for name, value := range values {
		if strings.Contains(redacted.Error(), value) {
			t.Errorf("redacted error leaked %s", name)
		}
	}
	if count := strings.Count(redacted.Error(), "[REDACTED]"); count != len(values) {
		t.Errorf("redacted marker count = %d, want %d: %q", count, len(values), redacted)
	}
}

func TestAdminKubeconfigSuppressesOIDCProviderResponseBody(t *testing.T) {
	providerSecret := strings.Repeat("provider-response-secret", 3)
	err := redactAdminCredentialError(&rest.Config{}, &oauth2.RetrieveError{
		Response: &http.Response{
			Status:     "401 Unauthorized " + providerSecret,
			StatusCode: http.StatusUnauthorized,
		},
		Body:             []byte(providerSecret),
		ErrorCode:        "invalid_client",
		ErrorDescription: providerSecret,
	})
	if strings.Contains(err.Error(), providerSecret) {
		t.Fatalf("redacted error leaked provider response body: %q", err)
	}
	if !strings.Contains(err.Error(), "401 Unauthorized") {
		t.Fatalf("redacted error = %q, want safe provider status", err)
	}
	if err.Error() != "OIDC credential provider request failed: 401 Unauthorized" {
		t.Fatalf("redacted error trusted raw provider status: %q", err)
	}
}

func TestAdminKubeconfigCredentialSecretsAreUniqueAndLongestFirst(t *testing.T) {
	longOpaque := strings.Repeat("opaque", 4)
	config := &rest.Config{
		BearerToken: "admin-secret",
		Username:    "admin",
		Password:    "admin-secret",
		ExecProvider: &api.ExecConfig{Env: []api.ExecEnvVar{
			{Name: "REGION", Value: "us"},
			{Name: "ACCESS_TOKEN", Value: "abc"},
			{Name: "AUDIENCE", Value: longOpaque},
			{Name: "DUPLICATE_TOKEN", Value: "admin-secret"},
		}},
	}

	got := adminCredentialSecrets(config)
	want := []string{longOpaque, "admin-secret", "admin", "abc"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("adminCredentialSecrets() = %q, want %q", got, want)
	}

	redacted := redactAdminCredentialError(
		config,
		errors.New("admin-secret admin "+longOpaque+" abc region=us"),
	)
	if strings.Contains(redacted.Error(), "admin") ||
		strings.Contains(redacted.Error(), longOpaque) ||
		strings.Contains(redacted.Error(), " abc") {
		t.Fatalf("redacted error leaked configured credential: %q", redacted)
	}
	if !strings.Contains(redacted.Error(), "region=us") {
		t.Fatalf("short ordinary exec env value was blanket-replaced: %q", redacted)
	}
	if strings.Contains(redacted.Error(), "[REDACTED]-secret") {
		t.Fatalf("overlapping credential was only partially redacted: %q", redacted)
	}
}

func TestAdminKubeconfigExchangeNormalizesNilResponseBody(t *testing.T) {
	client, err := newAdminExchangeRequestClient(
		&rest.Config{Host: "https://cluster.invalid"},
		roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
		func(_ *rest.Config, base http.RoundTripper) (http.RoundTripper, error) {
			return base, nil
		},
	)
	if err != nil {
		t.Fatalf("newAdminExchangeRequestClient() error = %v", err)
	}
	response, err := client.RoundTrip(
		t.Context(),
		"http://127.0.0.1:43123/admin/session/exchange",
	)
	if err != nil {
		t.Fatalf("RoundTrip() error = %v", err)
	}
	if response.Body == nil {
		t.Fatal("RoundTrip() response Body = nil, want safe empty body")
	}
	if err := response.Body.Close(); err != nil {
		t.Fatalf("close response body: %v", err)
	}
}

func TestAdminDiscoverySelectsEligiblePod(t *testing.T) {
	now := time.Now().UTC()
	ready := func(name, release, component string, created time.Time) corev1.Pod {
		labels := map[string]string{
			"app.kubernetes.io/name":       "paprika",
			"app.kubernetes.io/managed-by": "Helm",
			"app.kubernetes.io/instance":   release,
		}
		if component == "manager" {
			labels["control-plane"] = "controller-manager"
		} else {
			labels["app.kubernetes.io/component"] = component
		}
		return corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "paprika", Labels: labels, CreationTimestamp: metav1.NewTime(created)},
			Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
				Type: corev1.PodReady, Status: corev1.ConditionTrue,
			}}},
		}
	}
	terminating := ready("terminating", "one", "api-server", now.Add(10*time.Minute))
	deleted := metav1.NewTime(now)
	terminating.DeletionTimestamp = &deleted
	unready := ready("unready", "one", "api-server", now.Add(20*time.Minute))
	unready.Status.Conditions[0].Status = corev1.ConditionFalse

	var selector string
	selected, err := discoverAdminPod(t.Context(), "paprika", "one", func(
		_ context.Context,
		namespace string,
		opts metav1.ListOptions,
	) (*corev1.PodList, error) {
		if namespace != "paprika" {
			t.Fatalf("namespace = %q, want paprika", namespace)
		}
		selector = opts.LabelSelector
		return &corev1.PodList{Items: []corev1.Pod{
			ready("manager-newest", "one", "manager", now.Add(30*time.Minute)),
			ready("api-old", "one", "api-server", now),
			ready("api-z", "one", "api-server", now.Add(time.Minute)),
			ready("api-a", "one", "api-server", now.Add(time.Minute)),
			terminating,
			unready,
			ready("other-component", "one", "repo-server", now.Add(40*time.Minute)),
		}}, nil
	})
	if err != nil {
		t.Fatalf("discoverAdminPod() error = %v", err)
	}
	if selected.Name != "api-a" {
		t.Errorf("selected pod = %q, want api-a", selected.Name)
	}
	for _, label := range []string{
		"app.kubernetes.io/name=paprika",
		"app.kubernetes.io/managed-by=Helm",
		"app.kubernetes.io/instance=one",
	} {
		if !strings.Contains(selector, label) {
			t.Errorf("selector = %q, want %q", selector, label)
		}
	}
}

func TestAdminDiscoveryFallsBackAndRejectsAmbiguousReleases(t *testing.T) {
	makePod := func(name, release string) corev1.Pod {
		return corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: name,
				Labels: map[string]string{
					"app.kubernetes.io/name":       "paprika",
					"app.kubernetes.io/managed-by": "Helm",
					"app.kubernetes.io/instance":   release,
					"control-plane":                "controller-manager",
				},
			},
			Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
				Type: corev1.PodReady, Status: corev1.ConditionTrue,
			}}},
		}
	}
	lister := func(context.Context, string, metav1.ListOptions) (*corev1.PodList, error) {
		return &corev1.PodList{Items: []corev1.Pod{
			makePod("manager-b", "release-b"),
			makePod("manager-a", "release-a"),
		}}, nil
	}

	_, err := discoverAdminPod(t.Context(), "paprika", "", lister)
	if err == nil {
		t.Fatal("discoverAdminPod() error = nil, want ambiguity")
	}
	if !strings.Contains(err.Error(), "release-a, release-b") {
		t.Errorf("ambiguity error = %q, want sorted valid releases", err)
	}

	selected, err := discoverAdminPod(t.Context(), "paprika", "release-b", lister)
	if err != nil {
		t.Fatalf("discoverAdminPod(release-b) error = %v", err)
	}
	if selected.Name != "manager-b" {
		t.Errorf("selected pod = %q, want manager-b", selected.Name)
	}
}

func TestAdminDiscoveryDoesNotGuessWhenAnotherReleaseIsUnready(t *testing.T) {
	makePod := func(name, release string, ready bool) corev1.Pod {
		status := corev1.ConditionFalse
		if ready {
			status = corev1.ConditionTrue
		}
		return corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: name,
				Labels: map[string]string{
					"app.kubernetes.io/name":       "paprika",
					"app.kubernetes.io/managed-by": "Helm",
					"app.kubernetes.io/instance":   release,
					"control-plane":                "controller-manager",
				},
			},
			Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
				Type: corev1.PodReady, Status: status,
			}}},
		}
	}
	_, err := discoverAdminPod(t.Context(), "paprika", "", func(
		context.Context,
		string,
		metav1.ListOptions,
	) (*corev1.PodList, error) {
		return &corev1.PodList{Items: []corev1.Pod{
			makePod("ready", "release-a", true),
			makePod("rolling", "release-b", false),
		}}, nil
	})
	if err == nil || !strings.Contains(err.Error(), "release-a, release-b") {
		t.Fatalf("discoverAdminPod() error = %v, want ambiguity across every labelled install", err)
	}
}

func TestAdminDiscoveryRejectsReleaseSelectorInjection(t *testing.T) {
	called := false
	_, err := discoverAdminPod(
		t.Context(),
		"paprika",
		"release-a,app.kubernetes.io/instance=release-b",
		func(context.Context, string, metav1.ListOptions) (*corev1.PodList, error) {
			called = true
			return nil, errors.New("must not list")
		},
	)
	if err == nil || !strings.Contains(err.Error(), "invalid --release") {
		t.Fatalf("discoverAdminPod() error = %v, want invalid release selector", err)
	}
	if called {
		t.Fatal("pod lister called with injected label selector")
	}
}

func TestAdminAccessReviewRequiresExactPermission(t *testing.T) {
	var got *authorizationv1.SelfSubjectAccessReview
	err := requireAdminPortForwardAccess(t.Context(), "paprika", "api-2", func(
		_ context.Context,
		review *authorizationv1.SelfSubjectAccessReview,
	) (*authorizationv1.SelfSubjectAccessReview, error) {
		got = review.DeepCopy()
		return &authorizationv1.SelfSubjectAccessReview{
			Status: authorizationv1.SubjectAccessReviewStatus{Allowed: true},
		}, nil
	})
	if err != nil {
		t.Fatalf("requireAdminPortForwardAccess() error = %v", err)
	}
	attrs := got.Spec.ResourceAttributes
	if attrs == nil ||
		attrs.Verb != "create" ||
		attrs.Group != "" ||
		attrs.Resource != "pods" ||
		attrs.Subresource != "portforward" ||
		attrs.Namespace != "paprika" ||
		attrs.Name != "api-2" {
		t.Fatalf("review attributes = %#v, want exact selected pod port-forward create", attrs)
	}
}

func TestAdminAccessReviewRejectsEveryNonSuccess(t *testing.T) {
	tests := []struct {
		name   string
		status authorizationv1.SubjectAccessReviewStatus
		err    error
	}{
		{name: "denied", status: authorizationv1.SubjectAccessReviewStatus{Denied: true, Reason: "policy"}},
		{name: "indeterminate", status: authorizationv1.SubjectAccessReviewStatus{}},
		{name: "review error", err: errors.New("review unavailable")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := requireAdminPortForwardAccess(t.Context(), "ns", "pod", func(
				context.Context,
				*authorizationv1.SelfSubjectAccessReview,
			) (*authorizationv1.SelfSubjectAccessReview, error) {
				if tt.err != nil {
					return nil, tt.err
				}
				return &authorizationv1.SelfSubjectAccessReview{Status: tt.status}, nil
			})
			if err == nil {
				t.Fatal("requireAdminPortForwardAccess() error = nil")
			}
		})
	}
}

type fakeAdminForwarder struct {
	ready       chan<- struct{}
	stop        <-chan struct{}
	ports       []portforward.ForwardedPort
	portsErr    error
	err         error
	stopErr     error
	started     chan struct{}
	allowReady  <-chan struct{}
	stopped     chan struct{}
	stoppedOnce sync.Once
}

func (f *fakeAdminForwarder) ForwardPorts() error {
	if f.started != nil {
		close(f.started)
	}
	if f.err != nil {
		return f.err
	}
	if f.allowReady != nil {
		select {
		case <-f.allowReady:
		case <-f.stop:
			f.stoppedOnce.Do(func() { close(f.stopped) })
			return f.stopErr
		}
	}
	close(f.ready)
	<-f.stop
	f.stoppedOnce.Do(func() { close(f.stopped) })
	return f.stopErr
}

func (f *fakeAdminForwarder) GetPorts() ([]portforward.ForwardedPort, error) {
	return f.ports, f.portsErr
}

func TestAdminPortForwardBindsLoopbackAndMapsHiddenPort(t *testing.T) {
	var gotAddresses, gotPorts []string
	stopped := make(chan struct{})
	deps := adminPortForwardDependencies{
		roundTripperFor: func(*rest.Config) (http.RoundTripper, transportspdy.Upgrader, error) {
			return http.DefaultTransport, nil, nil
		},
		newDialer: func(transportspdy.Upgrader, *http.Client, string, string) (httpstream.Dialer, error) {
			return nil, nil
		},
		newForwarder: func(
			_ httpstream.Dialer,
			addresses, ports []string,
			stop <-chan struct{},
			ready chan struct{},
			_, _ io.Writer,
		) (adminForwarder, error) {
			gotAddresses = append([]string(nil), addresses...)
			gotPorts = append([]string(nil), ports...)
			return &fakeAdminForwarder{
				ready:   ready,
				stop:    stop,
				ports:   []portforward.ForwardedPort{{Local: 43219, Remote: adminDashboardRemotePort}},
				stopped: stopped,
			}, nil
		},
	}
	ctx, cancel := context.WithCancel(t.Context())
	forward, err := startAdminPortForward(ctx, &rest.Config{Host: "https://cluster.invalid"}, "paprika", "api-2", deps)
	if err != nil {
		t.Fatalf("startAdminPortForward() error = %v", err)
	}
	if strings.Join(gotAddresses, ",") != "127.0.0.1" {
		t.Errorf("addresses = %v, want loopback only", gotAddresses)
	}
	if strings.Join(gotPorts, ",") != "0:3001" {
		t.Errorf("ports = %v, want ephemeral local to hidden 3001", gotPorts)
	}
	if forward.LocalPort != 43219 {
		t.Errorf("LocalPort = %d, want selected port after readiness", forward.LocalPort)
	}

	cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("port-forward goroutine did not stop after context cancellation")
	}
	select {
	case err := <-forward.Done:
		if err != nil {
			t.Errorf("Done error = %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("forward Done did not close")
	}
}

func TestAdminPortForwardBlocksUntilReady(t *testing.T) {
	allowReady := make(chan struct{})
	started := make(chan struct{})
	stopped := make(chan struct{})
	deps := testAdminPortForwardDependencies(func(
		stop <-chan struct{},
		ready chan struct{},
	) adminForwarder {
		return &fakeAdminForwarder{
			ready:      ready,
			stop:       stop,
			ports:      []portforward.ForwardedPort{{Local: 43219, Remote: adminDashboardRemotePort}},
			started:    started,
			allowReady: allowReady,
			stopped:    stopped,
		}
	})
	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() {
		_, err := startAdminPortForward(
			ctx,
			&rest.Config{Host: "https://cluster.invalid"},
			"paprika",
			"api-2",
			deps,
		)
		result <- err
	}()
	<-started
	select {
	case err := <-result:
		t.Fatalf("startAdminPortForward returned before ready: %v", err)
	default:
	}

	close(allowReady)
	// The result returns after readiness, so cancel its live tunnel immediately.
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("startAdminPortForward() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("startAdminPortForward did not return after readiness")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("ready tunnel did not stop after cancellation")
	}
}

func TestAdminPortForwardJoinsPostReadyFailures(t *testing.T) {
	tests := []struct {
		name     string
		ports    []portforward.ForwardedPort
		portsErr error
		want     string
	}{
		{name: "get ports error", portsErr: errors.New("ports unavailable"), want: "ports unavailable"},
		{
			name:  "missing remote mapping",
			ports: []portforward.ForwardedPort{{Local: 43123, Remote: 3000}},
			want:  "without a local port",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stopped := make(chan struct{})
			deps := testAdminPortForwardDependencies(func(
				stop <-chan struct{},
				ready chan struct{},
			) adminForwarder {
				return &fakeAdminForwarder{
					ready:    ready,
					stop:     stop,
					ports:    tt.ports,
					portsErr: tt.portsErr,
					stopErr:  errors.New("forward cleanup failed"),
					stopped:  stopped,
				}
			})

			_, err := startAdminPortForward(
				t.Context(),
				&rest.Config{Host: "https://cluster.invalid"},
				"paprika",
				"api-2",
				deps,
			)
			select {
			case <-stopped:
			default:
				t.Fatal("startAdminPortForward returned before ForwardPorts completed")
			}
			if err == nil ||
				!strings.Contains(err.Error(), tt.want) ||
				!strings.Contains(err.Error(), "forward cleanup failed") {
				t.Fatalf("startAdminPortForward() error = %v, want primary and cleanup errors", err)
			}
		})
	}
}

func TestAdminPortForwardJoinsCancellationBeforeReady(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	neverReady := make(chan struct{})
	deps := testAdminPortForwardDependencies(func(
		stop <-chan struct{},
		ready chan struct{},
	) adminForwarder {
		return &fakeAdminForwarder{
			ready:      ready,
			stop:       stop,
			started:    started,
			allowReady: neverReady,
			stopErr:    errors.New("cancel cleanup failed"),
			stopped:    stopped,
		}
	})
	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() {
		_, err := startAdminPortForward(
			ctx,
			&rest.Config{Host: "https://cluster.invalid"},
			"paprika",
			"api-2",
			deps,
		)
		result <- err
	}()
	<-started
	cancel()
	err := <-result
	select {
	case <-stopped:
	default:
		t.Fatal("startAdminPortForward returned before ForwardPorts completed")
	}
	if err == nil ||
		!strings.Contains(err.Error(), context.Canceled.Error()) ||
		!strings.Contains(err.Error(), "cancel cleanup failed") {
		t.Fatalf("startAdminPortForward() error = %v, want cancellation and cleanup errors", err)
	}
}

func TestAdminPortForwardCancelsBlockedSPDYHandshake(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseTransport := make(chan struct{})
	var releaseOnce sync.Once
	var client *http.Client
	deps := adminPortForwardDependencies{
		roundTripperFor: func(*rest.Config) (http.RoundTripper, transportspdy.Upgrader, error) {
			return roundTripperFunc(func(req *http.Request) (*http.Response, error) {
				close(requestStarted)
				select {
				case <-req.Context().Done():
					return nil, req.Context().Err()
				case <-releaseTransport:
					return nil, errors.New("transport manually released")
				}
			}), nil, nil
		},
		newDialer: func(
			_ transportspdy.Upgrader,
			gotClient *http.Client,
			_, _ string,
		) (httpstream.Dialer, error) {
			client = gotClient
			return nil, nil
		},
		newForwarder: func(
			httpstream.Dialer,
			[]string,
			[]string,
			<-chan struct{},
			chan struct{},
			io.Writer,
			io.Writer,
		) (adminForwarder, error) {
			return adminForwarderFunc(func() error {
				req, err := http.NewRequestWithContext(
					context.Background(),
					http.MethodPost,
					"https://cluster.invalid/upgrade",
					http.NoBody,
				)
				if err != nil {
					return err
				}
				response, err := client.Transport.RoundTrip(req)
				if response != nil && response.Body != nil {
					_ = response.Body.Close()
				}
				return err
			}), nil
		},
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := startAdminPortForward(
			ctx,
			&rest.Config{Host: "https://cluster.invalid"},
			"paprika",
			"api-2",
			deps,
		)
		result <- err
	}()
	<-requestStarted
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), context.DeadlineExceeded.Error()) {
			t.Fatalf("startAdminPortForward() error = %v, want handshake context cancellation", err)
		}
	case <-time.After(time.Second):
		releaseOnce.Do(func() { close(releaseTransport) })
		err := <-result
		t.Fatalf("blocked SPDY handshake ignored forward context: %v", err)
	}
	releaseOnce.Do(func() { close(releaseTransport) })
}

type adminForwarderFunc func() error

func (f adminForwarderFunc) ForwardPorts() error {
	return f()
}

func (adminForwarderFunc) GetPorts() ([]portforward.ForwardedPort, error) {
	return nil, nil
}

func testAdminPortForwardDependencies(
	newForwarder func(<-chan struct{}, chan struct{}) adminForwarder,
) adminPortForwardDependencies {
	return adminPortForwardDependencies{
		roundTripperFor: func(*rest.Config) (http.RoundTripper, transportspdy.Upgrader, error) {
			return http.DefaultTransport, nil, nil
		},
		newDialer: func(transportspdy.Upgrader, *http.Client, string, string) (httpstream.Dialer, error) {
			return nil, nil
		},
		newForwarder: func(
			_ httpstream.Dialer,
			_, _ []string,
			stop <-chan struct{},
			ready chan struct{},
			_, _ io.Writer,
		) (adminForwarder, error) {
			return newForwarder(stop, ready), nil
		},
	}
}

func TestAdminPortForwardStopsOnErrorBeforeReady(t *testing.T) {
	deps := adminPortForwardDependencies{
		roundTripperFor: func(*rest.Config) (http.RoundTripper, transportspdy.Upgrader, error) {
			return http.DefaultTransport, nil, nil
		},
		newDialer: func(transportspdy.Upgrader, *http.Client, string, string) (httpstream.Dialer, error) {
			return nil, nil
		},
		newForwarder: func(
			httpstream.Dialer,
			[]string,
			[]string,
			<-chan struct{},
			chan struct{},
			io.Writer,
			io.Writer,
		) (adminForwarder, error) {
			return &fakeAdminForwarder{err: errors.New("upgrade failed")}, nil
		},
	}

	_, err := startAdminPortForward(
		t.Context(),
		&rest.Config{Host: "https://cluster.invalid"},
		"paprika",
		"api-2",
		deps,
	)
	if err == nil || !strings.Contains(err.Error(), "upgrade failed") {
		t.Fatalf("startAdminPortForward() error = %v, want transport failure", err)
	}
}
