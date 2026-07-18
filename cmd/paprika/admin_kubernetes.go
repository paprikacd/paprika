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
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/oauth2"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"
	"k8s.io/apimachinery/pkg/util/httpstream"        //nolint:staticcheck // Required by client-go's requested spdy.NewDialer and portforward.NewOnAddresses APIs.
	_ "k8s.io/client-go/plugin/pkg/client/auth/oidc" // Register legacy OIDC kubeconfig bearer authentication.
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/client-go/tools/portforward"
	clienttransport "k8s.io/client-go/transport"
	transportspdy "k8s.io/client-go/transport/spdy"
)

const adminDashboardRemotePort = uint16(3001)

type adminKubeconfig struct {
	RESTConfig *rest.Config
	Context    string
	Namespace  string
}

type adminKubeconfigLoader func(context.Context, *adminDashboardOptions) (*adminKubeconfig, error)

//nolint:cyclop // Kubeconfig selection validates each fail-closed input explicitly.
func loadAdminKubeconfig(_ context.Context, opts *adminDashboardOptions) (*adminKubeconfig, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	loadingRules.ExplicitPath = opts.Kubeconfig
	overrides := &clientcmd.ConfigOverrides{
		CurrentContext: opts.Context,
	}
	if opts.Namespace != "" {
		overrides.Context.Namespace = opts.Namespace
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, overrides)

	rawConfig, err := clientConfig.RawConfig()
	if err != nil {
		return nil, fmt.Errorf("read kubeconfig: %w", err)
	}
	contextName := rawConfig.CurrentContext
	if opts.Context != "" {
		contextName = opts.Context
	}
	selectedContext, ok := rawConfig.Contexts[contextName]
	if !ok || selectedContext == nil {
		return nil, fmt.Errorf("kubernetes context %q was not found in kubeconfig", contextName)
	}
	authInfo, ok := rawConfig.AuthInfos[selectedContext.AuthInfo]
	if !ok || authInfo == nil {
		return nil, fmt.Errorf("kubernetes context %q has no user credentials", contextName)
	}
	credentialErr := validateAdminBearerCredentials(authInfo)
	if credentialErr != nil {
		return nil, fmt.Errorf("kubernetes context %q: %w", contextName, credentialErr)
	}

	namespace, _, err := clientConfig.Namespace()
	if err != nil {
		return nil, fmt.Errorf("resolve Kubernetes namespace: %w", err)
	}
	if namespace == "" {
		namespace = metav1.NamespaceDefault
	}
	restConfig, err := clientConfig.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("build Kubernetes REST configuration: %w", err)
	}
	return &adminKubeconfig{
		RESTConfig: restConfig,
		Context:    contextName,
		Namespace:  namespace,
	}, nil
}

func validateAdminBearerCredentials(authInfo *clientcmdapi.AuthInfo) error {
	if authInfo == nil {
		return errors.New("bearer-capable credentials are required")
	}
	if authInfo.Token != "" ||
		authInfo.TokenFile != "" ||
		authInfo.Exec != nil ||
		(authInfo.AuthProvider != nil && strings.EqualFold(authInfo.AuthProvider.Name, "oidc")) {
		return nil
	}
	return errors.New(
		"bearer-capable Kubernetes credentials are required; select a short-lived OIDC or exec-token context instead of client-certificate or request-signing-only credentials",
	)
}

func adminCredentialRoundTripper(
	config *rest.Config,
	base http.RoundTripper,
) (http.RoundTripper, error) {
	if config == nil || base == nil {
		return nil, errors.New("kubernetes credential transport requires a REST config and loopback RoundTripper")
	}
	transportConfig, err := config.TransportConfig()
	if err != nil {
		return nil, fmt.Errorf("build Kubernetes credential transport config: %w", err)
	}
	wrapped, err := clienttransport.HTTPWrappersForConfig(transportConfig, base)
	if err != nil {
		return nil, fmt.Errorf("build Kubernetes bearer credential wrapper: %w", err)
	}
	return wrapped, nil
}

type adminCredentialRoundTripperFactory func(
	*rest.Config,
	http.RoundTripper,
) (http.RoundTripper, error)

type adminExchangeRequestClient struct {
	transport http.RoundTripper
}

func newAdminExchangeRequestClient(
	config *rest.Config,
	base http.RoundTripper,
	credentials adminCredentialRoundTripperFactory,
) (*adminExchangeRequestClient, error) {
	if credentials == nil {
		return nil, errors.New("kubernetes credential RoundTripper factory is unavailable")
	}
	transport, err := credentials(config, base)
	if err != nil {
		return nil, fmt.Errorf(
			"prepare Kubernetes exchange credentials: %w",
			redactAdminCredentialError(config, err),
		)
	}
	if transport == nil {
		return nil, errors.New("kubernetes credential RoundTripper factory returned no transport")
	}
	return &adminExchangeRequestClient{transport: transport}, nil
}

//nolint:cyclop // Request construction validates every loopback exchange URL invariant explicitly.
func (c *adminExchangeRequestClient) RoundTrip(
	ctx context.Context,
	endpoint string,
) (*http.Response, error) {
	if c == nil || c.transport == nil {
		return nil, errors.New("kubernetes exchange request client is unavailable")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse Kubernetes exchange URL: %w", err)
	}
	if parsed.Scheme != "http" ||
		parsed.Hostname() != "127.0.0.1" ||
		parsed.Path != "/admin/session/exchange" {
		return nil, errors.New("kubernetes exchange URL must be loopback /admin/session/exchange")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("build Kubernetes exchange request: %w", err)
	}
	response, err := c.transport.RoundTrip(request)
	if err != nil {
		return nil, fmt.Errorf("execute Kubernetes exchange request: %w", err)
	}
	if response == nil {
		return nil, errors.New("kubernetes exchange request returned no response")
	}
	if response.Body == nil {
		response.Body = http.NoBody
	}
	return response, nil
}

func redactAdminCredentialError(config *rest.Config, err error) error {
	if err == nil {
		return nil
	}
	var providerErr *oauth2.RetrieveError
	if errors.As(err, &providerErr) {
		status := "request failed"
		if providerErr.Response != nil && providerErr.Response.StatusCode > 0 {
			statusCode := providerErr.Response.StatusCode
			status = strconv.Itoa(statusCode)
			if statusText := http.StatusText(statusCode); statusText != "" {
				status += " " + statusText
			}
		}
		return fmt.Errorf("OIDC credential provider request failed: %s", status)
	}
	message := err.Error()
	if config == nil {
		return errors.New(message)
	}
	for _, secret := range adminCredentialSecrets(config) {
		message = strings.ReplaceAll(message, secret, "[REDACTED]")
	}
	return errors.New(message)
}

func adminCredentialSecrets(config *rest.Config) []string {
	if config == nil {
		return nil
	}
	unique := make(map[string]struct{})
	add := func(secret string) {
		if secret != "" {
			unique[secret] = struct{}{}
		}
	}
	add(config.BearerToken)
	add(config.Username)
	add(config.Password)
	if config.AuthProvider != nil {
		add(config.AuthProvider.Config["id-token"])
		add(config.AuthProvider.Config["refresh-token"])
		add(config.AuthProvider.Config["client-secret"])
	}
	if config.ExecProvider != nil {
		for _, env := range config.ExecProvider.Env {
			if len(env.Value) >= 16 || adminExecEnvNameLikelySecret(env.Name) {
				add(env.Value)
			}
		}
	}

	secrets := make([]string, 0, len(unique))
	for secret := range unique {
		secrets = append(secrets, secret)
	}
	sort.Slice(secrets, func(i, j int) bool {
		if len(secrets[i]) != len(secrets[j]) {
			return len(secrets[i]) > len(secrets[j])
		}
		return secrets[i] < secrets[j]
	})
	return secrets
}

func adminExecEnvNameLikelySecret(name string) bool {
	parts := strings.FieldsFunc(strings.ToUpper(name), func(r rune) bool {
		return r == '_' || r == '-' || r == '.'
	})
	for _, part := range parts {
		switch part {
		case "AUTH", "CREDENTIAL", "KEY", "PASSWORD", "SECRET", "TOKEN":
			return true
		}
	}
	return false
}

const adminExchangeProbeURL = "http://127.0.0.1:1/admin/session/exchange"

type adminExchangeCredentialProbeTransport struct{}

func (adminExchangeCredentialProbeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	authorization := req.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") ||
		len(authorization) == len("Bearer ") {
		return nil, errors.New(
			"kubernetes credentials did not produce bearer authentication; use an OIDC or exec-token context",
		)
	}
	return &http.Response{
		StatusCode: http.StatusNoContent,
		Header:     make(http.Header),
		Body:       http.NoBody,
		Request:    req,
	}, nil
}

func prepareAdminExchangeCredentials(
	ctx context.Context,
	config *rest.Config,
	credentials adminCredentialRoundTripperFactory,
) error {
	client, err := newAdminExchangeRequestClient(
		config,
		adminExchangeCredentialProbeTransport{},
		credentials,
	)
	if err != nil {
		return err
	}
	response, err := client.RoundTrip(ctx, adminExchangeProbeURL)
	if err != nil {
		return redactAdminCredentialError(config, err)
	}
	if closeErr := response.Body.Close(); closeErr != nil {
		return fmt.Errorf("close Kubernetes credential probe response: %w", closeErr)
	}
	return nil
}

type adminPodLister func(
	context.Context,
	string,
	metav1.ListOptions,
) (*corev1.PodList, error)

//nolint:cyclop // Eligibility, release ambiguity, and deterministic ordering are distinct checks.
func discoverAdminPod(
	ctx context.Context,
	namespace, release string,
	list adminPodLister,
) (*corev1.Pod, error) {
	if list == nil {
		return nil, errors.New("kubernetes pod lister is unavailable")
	}
	selector, err := labels.ValidatedSelectorFromSet(labels.Set{
		"app.kubernetes.io/name":       "paprika",
		"app.kubernetes.io/managed-by": "Helm",
	})
	if err != nil {
		return nil, fmt.Errorf("build Paprika pod label selector: %w", err)
	}
	if release != "" {
		releaseRequirement, requirementErr := labels.NewRequirement(
			"app.kubernetes.io/instance",
			selection.Equals,
			[]string{release},
		)
		if requirementErr != nil {
			return nil, fmt.Errorf("invalid --release label value %q: %w", release, requirementErr)
		}
		selector = selector.Add(*releaseRequirement)
	}
	pods, err := list(ctx, namespace, metav1.ListOptions{LabelSelector: selector.String()})
	if err != nil {
		return nil, fmt.Errorf("list Paprika pods in namespace %q: %w", namespace, err)
	}
	if pods == nil {
		return nil, fmt.Errorf("list Paprika pods in namespace %q returned no result", namespace)
	}

	eligible := make([]corev1.Pod, 0, len(pods.Items))
	releases := make(map[string]struct{})
	for i := range pods.Items {
		pod := pods.Items[i]
		podRelease := pod.Labels["app.kubernetes.io/instance"]
		if podRelease == "" {
			continue
		}
		if release == "" {
			releases[podRelease] = struct{}{}
		}
		if release != "" && podRelease != release {
			continue
		}
		if !isReadyAdminPod(&pod) {
			continue
		}
		eligible = append(eligible, pod)
	}
	if release == "" && len(releases) > 1 {
		names := make([]string, 0, len(releases))
		for name := range releases {
			names = append(names, name)
		}
		sort.Strings(names)
		return nil, fmt.Errorf(
			"multiple Paprika releases are eligible; select one with --release (valid releases: %s)",
			strings.Join(names, ", "),
		)
	}
	if len(eligible) == 0 {
		if release == "" {
			return nil, fmt.Errorf("no ready Paprika API or controller-manager pod found in namespace %q", namespace)
		}
		return nil, fmt.Errorf(
			"no ready Paprika API or controller-manager pod found for release %q in namespace %q",
			release,
			namespace,
		)
	}

	sort.Slice(eligible, func(i, j int) bool {
		leftPriority := adminPodPriority(&eligible[i])
		rightPriority := adminPodPriority(&eligible[j])
		if leftPriority != rightPriority {
			return leftPriority > rightPriority
		}
		leftCreated := eligible[i].CreationTimestamp.Time
		rightCreated := eligible[j].CreationTimestamp.Time
		if !leftCreated.Equal(rightCreated) {
			return leftCreated.After(rightCreated)
		}
		return eligible[i].Name < eligible[j].Name
	})
	selected := eligible[0].DeepCopy()
	return selected, nil
}

func isReadyAdminPod(pod *corev1.Pod) bool {
	if pod == nil || pod.DeletionTimestamp != nil || adminPodPriority(pod) == 0 {
		return false
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func adminPodPriority(pod *corev1.Pod) int {
	if pod == nil {
		return 0
	}
	if pod.Labels["app.kubernetes.io/component"] == "api-server" {
		return 2
	}
	if pod.Labels["control-plane"] == "controller-manager" {
		return 1
	}
	return 0
}

type adminAccessReviewer func(
	context.Context,
	*authorizationv1.SelfSubjectAccessReview,
) (*authorizationv1.SelfSubjectAccessReview, error)

func requireAdminPortForwardAccess(
	ctx context.Context,
	namespace, pod string,
	review adminAccessReviewer,
) error {
	if review == nil {
		return errors.New("kubernetes SelfSubjectAccessReview client is unavailable")
	}
	result, err := review(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authorizationv1.ResourceAttributes{
				Namespace:   namespace,
				Verb:        "create",
				Group:       "",
				Resource:    "pods",
				Subresource: "portforward",
				Name:        pod,
			},
		},
	})
	if err != nil {
		return fmt.Errorf(
			"review create pods/portforward access for %s/%s: %w",
			namespace,
			pod,
			err,
		)
	}
	if result == nil {
		return fmt.Errorf(
			"kubernetes access review for create pods/portforward on %s/%s was indeterminate",
			namespace,
			pod,
		)
	}
	if !result.Status.Allowed {
		reason := result.Status.Reason
		if reason == "" {
			reason = "the review was denied or indeterminate"
		}
		return fmt.Errorf(
			"kubernetes access denied for create pods/portforward on %s/%s: %s",
			namespace,
			pod,
			reason,
		)
	}
	return nil
}

type adminForwarder interface {
	ForwardPorts() error
	GetPorts() ([]portforward.ForwardedPort, error)
}

type adminPortForward struct {
	LocalPort uint16
	Done      <-chan error
	Joined    <-chan struct{}
}

type adminPortForwardDependencies struct {
	roundTripperFor func(*rest.Config) (http.RoundTripper, transportspdy.Upgrader, error)
	newDialer       func(transportspdy.Upgrader, *http.Client, string, string) (httpstream.Dialer, error)
	newForwarder    func(
		httpstream.Dialer,
		[]string,
		[]string,
		<-chan struct{},
		chan struct{},
		io.Writer,
		io.Writer,
	) (adminForwarder, error)
}

func defaultAdminPortForwardDependencies() adminPortForwardDependencies {
	return adminPortForwardDependencies{
		roundTripperFor: transportspdy.RoundTripperFor,
		newDialer: func(
			upgrader transportspdy.Upgrader,
			client *http.Client,
			method, endpoint string,
		) (httpstream.Dialer, error) {
			parsed, err := url.Parse(endpoint)
			if err != nil {
				return nil, fmt.Errorf("parse pod port-forward URL: %w", err)
			}
			return transportspdy.NewDialer(upgrader, client, method, parsed), nil
		},
		newForwarder: func(
			dialer httpstream.Dialer,
			addresses, ports []string,
			stop <-chan struct{},
			ready chan struct{},
			out, errOut io.Writer,
		) (adminForwarder, error) {
			return portforward.NewOnAddresses(dialer, addresses, ports, stop, ready, out, errOut)
		},
	}
}

//nolint:cyclop,funlen // Transport setup and lifecycle failures need distinct actionable errors.
func startAdminPortForward(
	ctx context.Context,
	config *rest.Config,
	namespace, pod string,
	deps adminPortForwardDependencies,
) (adminPortForward, error) {
	if config == nil ||
		deps.roundTripperFor == nil ||
		deps.newDialer == nil ||
		deps.newForwarder == nil {
		return adminPortForward{}, errors.New("pod port-forward dependencies are incomplete")
	}
	roundTripper, upgrader, err := deps.roundTripperFor(config)
	if err != nil {
		return adminPortForward{}, fmt.Errorf("create Kubernetes SPDY transport: %w", err)
	}
	endpoint, err := adminPortForwardURL(config.Host, namespace, pod)
	if err != nil {
		return adminPortForward{}, err
	}
	dialer, err := deps.newDialer(
		upgrader,
		&http.Client{Transport: adminRoundTripperWithContext(ctx, roundTripper)},
		http.MethodPost,
		endpoint,
	)
	if err != nil {
		return adminPortForward{}, fmt.Errorf("create Kubernetes SPDY dialer: %w", err)
	}

	stop := make(chan struct{})
	ready := make(chan struct{})
	var stopOnce sync.Once
	stopForward := func() {
		stopOnce.Do(func() { close(stop) })
	}
	stopOnCancel := context.AfterFunc(ctx, stopForward)
	forwarder, err := deps.newForwarder(
		dialer,
		[]string{"127.0.0.1"},
		[]string{fmt.Sprintf("0:%d", adminDashboardRemotePort)},
		stop,
		ready,
		io.Discard,
		io.Discard,
	)
	if err != nil {
		stopOnCancel()
		stopForward()
		return adminPortForward{}, fmt.Errorf("configure pod port-forward: %w", err)
	}

	done := make(chan error, 1)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		forwardErr := forwarder.ForwardPorts()
		stopOnCancel()
		stopForward()
		done <- forwardErr
		close(done)
	}()

	joinForwarder := func(primary error) error {
		stopForward()
		forwardErr := <-done
		<-joined
		if forwardErr != nil {
			return errors.Join(primary, fmt.Errorf("finish pod port-forward: %w", forwardErr))
		}
		return primary
	}

	select {
	case <-ready:
		ports, portsErr := forwarder.GetPorts()
		if portsErr != nil {
			return adminPortForward{}, joinForwarder(fmt.Errorf("read forwarded port: %w", portsErr))
		}
		for _, forwarded := range ports {
			if forwarded.Remote == adminDashboardRemotePort && forwarded.Local != 0 {
				if contextErr := ctx.Err(); contextErr != nil {
					return adminPortForward{}, joinForwarder(
						fmt.Errorf("wait for pod port-forward readiness: %w", contextErr),
					)
				}
				return adminPortForward{
					LocalPort: forwarded.Local,
					Done:      done,
					Joined:    joined,
				}, nil
			}
		}
		return adminPortForward{}, joinForwarder(fmt.Errorf(
			"port-forward became ready without a local port for remote %d",
			adminDashboardRemotePort,
		))
	case forwardErr := <-done:
		<-joined
		if forwardErr == nil {
			return adminPortForward{}, errors.New("pod port-forward stopped before becoming ready")
		}
		return adminPortForward{}, fmt.Errorf("run pod port-forward: %w", forwardErr)
	case <-ctx.Done():
		return adminPortForward{}, joinForwarder(
			fmt.Errorf("wait for pod port-forward readiness: %w", ctx.Err()),
		)
	}
}

type adminRoundTripperFunc func(*http.Request) (*http.Response, error)

func (f adminRoundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func adminRoundTripperWithContext(
	ctx context.Context,
	base http.RoundTripper,
) http.RoundTripper {
	return adminRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return base.RoundTrip(req.Clone(ctx))
	})
}

func adminPortForwardURL(host, namespace, pod string) (string, error) {
	endpoint, err := url.Parse(host)
	if err != nil {
		return "", fmt.Errorf("parse Kubernetes API server URL: %w", err)
	}
	if endpoint.Scheme == "" || endpoint.Host == "" {
		return "", fmt.Errorf("kubernetes API server URL %q is invalid", host)
	}
	prefix := strings.TrimSuffix(endpoint.Path, "/")
	endpoint.Path = fmt.Sprintf(
		"%s/api/v1/namespaces/%s/pods/%s/portforward",
		prefix,
		namespace,
		pod,
	)
	return endpoint.String(), nil
}
