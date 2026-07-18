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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/cli/browser"
	"github.com/spf13/cobra"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/benebsworth/paprika/internal/api/admin"
)

const defaultAdminDashboardTimeout = 30 * time.Second
const adminSessionRotationInterval = 5 * time.Minute

const adminNamespaceTrustWarning = "This workflow trusts the namespace pod-creation boundary; use it only where pod creation is restricted to trusted platform operators."

type adminDashboardOptions struct {
	Kubeconfig string
	Context    string
	Namespace  string
	Release    string
	LocalPort  int
	NoOpen     bool
	Timeout    time.Duration
	Output     string
}

type adminDashboardReady struct {
	Context       string    `json:"context"`
	Namespace     string    `json:"namespace"`
	Pod           string    `json:"pod"`
	URL           string    `json:"url"`
	Subject       string    `json:"subject"`
	SessionExpiry time.Time `json:"sessionExpiry"`
	AccessMode    string    `json:"accessMode"`
}

type adminDashboardOutput struct {
	writer io.Writer
}

func (o adminDashboardOutput) WriteProgress(message string) error {
	if _, err := fmt.Fprintln(o.writer, message); err != nil {
		return fmt.Errorf("write admin dashboard progress: %w", err)
	}
	return nil
}

//nolint:gocritic // Readiness is an immutable output value and is clearer by value.
func (o adminDashboardOutput) WriteReady(ready adminDashboardReady, output string) error {
	switch output {
	case outputJSON:
		if err := json.NewEncoder(o.writer).Encode(ready); err != nil {
			return fmt.Errorf("write admin dashboard JSON readiness: %w", err)
		}
	case outputTable:
		if _, err := fmt.Fprintf(
			o.writer,
			"Context: %s\nNamespace: %s\nPod: %s\nURL: %s\nSubject: %s\nSession expiry: %s\nAccess mode: %s\n",
			ready.Context,
			ready.Namespace,
			ready.Pod,
			ready.URL,
			ready.Subject,
			ready.SessionExpiry.Format(time.RFC3339),
			ready.AccessMode,
		); err != nil {
			return fmt.Errorf("write admin dashboard readiness: %w", err)
		}
	default:
		return fmt.Errorf("unsupported admin dashboard output %q", output)
	}
	return nil
}

type adminDashboardRunner func(
	context.Context,
	*adminDashboardOptions,
	adminDashboardOutput,
	adminDashboardOutput,
) error

type adminSignalNotifier func(
	context.Context,
	...os.Signal,
) (context.Context, context.CancelFunc)

func newAdminCmd(_ context.Context, runDashboard adminDashboardRunner) *cobra.Command {
	adminCmd := &cobra.Command{
		Use:   "admin",
		Short: "Open Kubernetes-verified administrative tools",
	}

	opts := adminDashboardOptions{
		Timeout: defaultAdminDashboardTimeout,
		Output:  outputTable,
	}
	dashboardCmd := &cobra.Command{
		Use:   "dashboard",
		Short: "Forward a verified Paprika administrative dashboard",
		Long: `Forward a verified Paprika administrative dashboard.

This workflow discovers a pod by the Paprika chart labels and therefore trusts
the namespace pod-creation boundary. Use it only where pod creation is
restricted to trusted platform operators.`,
		Args: cobra.NoArgs,
		PreRunE: func(*cobra.Command, []string) error {
			if opts.Output == outputYAML {
				return errors.New("YAML output is unavailable for the long-running admin dashboard command; use table or JSON")
			}
			if opts.Output != outputTable && opts.Output != outputJSON {
				return fmt.Errorf("unsupported output format %q: use table or json", opts.Output)
			}
			if opts.LocalPort < 0 || opts.LocalPort > 65535 {
				return errors.New("--port must be between 0 and 65535")
			}
			if opts.Timeout <= 0 {
				return errors.New("--timeout must be greater than zero")
			}
			return nil
		},
		//nolint:contextcheck // Cobra ExecuteContext owns the authoritative command context.
		RunE: func(cmd *cobra.Command, _ []string) error {
			if runDashboard == nil {
				return errors.New("admin dashboard runner is unavailable")
			}
			return runDashboard(
				cmd.Context(),
				&opts,
				adminDashboardOutput{writer: cmd.OutOrStdout()},
				adminDashboardOutput{writer: cmd.ErrOrStderr()},
			)
		},
	}
	dashboardCmd.Flags().StringVar(&opts.Kubeconfig, "kubeconfig", "", "Path to the Kubernetes kubeconfig")
	dashboardCmd.Flags().StringVar(&opts.Context, "context", "", "Kubernetes context override")
	dashboardCmd.Flags().StringVarP(&opts.Namespace, "namespace", "n", "", "Kubernetes namespace override")
	dashboardCmd.Flags().StringVar(&opts.Release, "release", "", "Paprika Helm release name")
	dashboardCmd.Flags().IntVar(&opts.LocalPort, "port", 0, "Local dashboard port (0 chooses an available port)")
	dashboardCmd.Flags().BoolVar(&opts.NoOpen, "no-open", false, "Do not open the dashboard in a browser")
	dashboardCmd.Flags().DurationVar(&opts.Timeout, "timeout", defaultAdminDashboardTimeout, "Discovery and forwarding timeout")
	dashboardCmd.Flags().StringVarP(&opts.Output, "output", "o", outputTable, "Output format: table or json")
	adminCmd.AddCommand(dashboardCmd)
	return adminCmd
}

type adminDashboardDependencies struct {
	loadKubeconfig adminKubeconfigLoader
	newPodLister   func(*rest.Config) (adminPodLister, error)
	newReviewer    func(*rest.Config) (adminAccessReviewer, error)
	forward        func(context.Context, *rest.Config, string, string) (adminPortForward, error)
	credentials    adminCredentialRoundTripperFactory
	now            func() time.Time
	newSession     func(*rest.Config, uint16, adminCredentialRoundTripperFactory, adminSelectedPodGetter, func() time.Time) adminDashboardSession
	startProxy     func(context.Context, int, uint16, *adminTokenHolder) (adminDashboardProxy, error)
	validateProxy  func(context.Context, string, admin.SessionDescription, time.Time) error
	rotation       func(context.Context, time.Duration) adminRotationSchedule
	openURL        func(string) error
}

type adminDashboardSession interface {
	AwaitAndExchange(context.Context, *corev1.Pod) (adminSessionState, error)
	Rotate(context.Context, *corev1.Pod, string) (adminSessionState, error)
	Revoke(context.Context, string) error
}

type adminDashboardProxy interface {
	URL() string
	Done() <-chan struct{}
	Close(context.Context) error
}

func defaultAdminDashboardDependencies() adminDashboardDependencies {
	return adminDashboardDependencies{
		loadKubeconfig: loadAdminKubeconfig,
		newPodLister: func(cfg *rest.Config) (adminPodLister, error) {
			client, err := kubernetes.NewForConfig(cfg)
			if err != nil {
				return nil, fmt.Errorf("create Kubernetes pod client: %w", err)
			}
			return func(
				ctx context.Context,
				namespace string,
				opts metav1.ListOptions,
			) (*corev1.PodList, error) {
				return client.CoreV1().Pods(namespace).List(ctx, opts)
			}, nil
		},
		newReviewer: func(cfg *rest.Config) (adminAccessReviewer, error) {
			client, err := kubernetes.NewForConfig(cfg)
			if err != nil {
				return nil, fmt.Errorf("create Kubernetes authorization client: %w", err)
			}
			return func(
				ctx context.Context,
				review *authorizationv1.SelfSubjectAccessReview,
			) (*authorizationv1.SelfSubjectAccessReview, error) {
				return client.AuthorizationV1().SelfSubjectAccessReviews().Create(
					ctx,
					review,
					metav1.CreateOptions{},
				)
			}, nil
		},
		forward: func(
			ctx context.Context,
			cfg *rest.Config,
			namespace, pod string,
		) (adminPortForward, error) {
			return startAdminPortForward(ctx, cfg, namespace, pod, defaultAdminPortForwardDependencies())
		},
		credentials: adminCredentialRoundTripper,
		now:         time.Now,
		newSession: func(
			config *rest.Config,
			port uint16,
			credentials adminCredentialRoundTripperFactory,
			pods adminSelectedPodGetter,
			now func() time.Time,
		) adminDashboardSession {
			client := newAdminSessionClient(config, port, credentials, pods)
			client.now = now
			return client
		},
		startProxy: func(
			ctx context.Context,
			localPort int,
			upstreamPort uint16,
			holder *adminTokenHolder,
		) (adminDashboardProxy, error) {
			return startAdminProxy(ctx, localPort, upstreamPort, holder)
		},
		validateProxy: validateAdminProxySession,
		rotation:      adminRotationTicks,
		openURL:       browser.OpenURL,
	}
}

func runAdminDashboard(
	ctx context.Context,
	opts *adminDashboardOptions,
	out, progress adminDashboardOutput,
) error {
	signalCtx, stop := adminDashboardSignalContext(ctx, signal.NotifyContext)
	defer stop()
	return runAdminDashboardWithDependencies(
		signalCtx,
		opts,
		out,
		progress,
		defaultAdminDashboardDependencies(),
	)
}

func adminDashboardSignalContext(
	ctx context.Context,
	notify adminSignalNotifier,
) (context.Context, context.CancelFunc) {
	return notify(ctx, os.Interrupt, syscall.SIGTERM)
}

//nolint:gocyclo,cyclop,funlen,gocognit,gocritic // Setup stages preserve fail-closed ordering; dependencies are immutable test seams.
func runAdminDashboardWithDependencies(
	ctx context.Context,
	opts *adminDashboardOptions,
	out, progress adminDashboardOutput,
	deps adminDashboardDependencies,
) error {
	if deps.loadKubeconfig == nil ||
		deps.newPodLister == nil ||
		deps.newReviewer == nil ||
		deps.forward == nil ||
		deps.credentials == nil ||
		deps.now == nil ||
		deps.newSession == nil ||
		deps.startProxy == nil ||
		deps.validateProxy == nil ||
		deps.rotation == nil ||
		deps.openURL == nil {
		return errors.New("admin dashboard Kubernetes dependencies are incomplete")
	}

	setupCtx, cancelSetup := context.WithTimeout(ctx, opts.Timeout)
	defer cancelSetup()

	if err := progress.WriteProgress("Loading Kubernetes configuration..."); err != nil {
		return err
	}
	kubeconfig, err := deps.loadKubeconfig(setupCtx, opts)
	if err != nil {
		return fmt.Errorf("load Kubernetes configuration: %w", err)
	}
	if progressErr := progress.WriteProgress(
		"Warning: exact pod port-forward permission grants unrestricted Paprika administration. " +
			adminNamespaceTrustWarning,
	); progressErr != nil {
		return progressErr
	}
	if opts.LocalPort != 0 {
		if progressErr := progress.WriteProgress(
			"Warning: a fixed --port creates a stable browser origin; clear trusted-origin " +
				"storage and service-worker state before reusing it for another cluster.",
		); progressErr != nil {
			return progressErr
		}
	}
	credentialErr := prepareAdminExchangeCredentials(
		setupCtx,
		kubeconfig.RESTConfig,
		deps.credentials,
	)
	if credentialErr != nil {
		return fmt.Errorf("prepare Kubernetes bearer credentials: %w", credentialErr)
	}
	lister, err := deps.newPodLister(kubeconfig.RESTConfig)
	if err != nil {
		return err
	}
	reviewer, err := deps.newReviewer(kubeconfig.RESTConfig)
	if err != nil {
		return err
	}

	progressErr := progress.WriteProgress("Discovering an eligible Paprika pod...")
	if progressErr != nil {
		return progressErr
	}
	pod, err := discoverAdminPod(setupCtx, kubeconfig.Namespace, opts.Release, lister)
	if err != nil {
		return fmt.Errorf("discover Paprika admin dashboard pod: %w", err)
	}
	if accessErr := requireAdminPortForwardAccess(
		setupCtx,
		kubeconfig.Namespace,
		pod.Name,
		reviewer,
	); accessErr != nil {
		return accessErr
	}

	forwardCtx, cancelForward := context.WithCancel(context.WithoutCancel(ctx))
	resultCh := make(chan adminForwardResult, 1)
	go func() {
		forward, forwardErr := deps.forward(
			forwardCtx,
			kubeconfig.RESTConfig,
			kubeconfig.Namespace,
			pod.Name,
		)
		resultCh <- adminForwardResult{forward: forward, err: forwardErr}
	}()

	var tunnel adminPortForward
	select {
	case result := <-resultCh:
		if result.err != nil {
			startErr := fmt.Errorf("start admin dashboard port-forward: %w", result.err)
			if result.forward.Done != nil {
				return joinActiveAdminForward(cancelForward, result.forward, startErr)
			}
			cancelForward()
			return startErr
		}
		tunnel = result.forward
		if tunnel.LocalPort == 0 || tunnel.Done == nil {
			return joinActiveAdminForward(
				cancelForward,
				tunnel,
				errors.New("admin dashboard port-forward returned an invalid ready tunnel"),
			)
		}
	case <-setupCtx.Done():
		return joinPendingAdminForward(
			cancelForward,
			resultCh,
			fmt.Errorf("prepare admin dashboard within %s: %w", opts.Timeout, setupCtx.Err()),
		)
	}
	sessionClient := deps.newSession(
		kubeconfig.RESTConfig,
		tunnel.LocalPort,
		deps.credentials,
		adminSelectedPodGetterFromLister(lister),
		deps.now,
	)
	if sessionClient == nil {
		return joinActiveAdminForward(
			cancelForward,
			tunnel,
			errors.New("admin session client is unavailable"),
		)
	}
	state, err := sessionClient.AwaitAndExchange(setupCtx, pod)
	if err != nil {
		return joinActiveAdminForward(
			cancelForward,
			tunnel,
			fmt.Errorf("establish verified admin session: %w", err),
		)
	}
	holder := newAdminTokenHolder(state.token)
	proxyCtx, cancelProxy := context.WithCancel(context.WithoutCancel(ctx))
	proxy, err := deps.startProxy(
		proxyCtx,
		opts.LocalPort,
		tunnel.LocalPort,
		holder,
	)
	if err != nil {
		cancelProxy()
		clearedToken, clearErr := holder.Clear(setupCtx)
		return errors.Join(
			clearErr,
			bestEffortAdminRevoke(setupCtx, sessionClient, clearedToken),
			joinActiveAdminForward(
				cancelForward,
				tunnel,
				fmt.Errorf("start browser-facing admin proxy: %w", err),
			),
		)
	}
	if err := deps.validateProxy(setupCtx, proxy.URL(), state.description, deps.now()); err != nil {
		return shutdownAdminDashboard(
			ctx,
			opts.Timeout,
			sessionClient,
			holder,
			proxy,
			cancelProxy,
			cancelForward,
			tunnel,
			false,
			nil,
			fmt.Errorf("validate browser-facing admin proxy: %w", err),
		)
	}
	cancelSetup()

	ready := adminDashboardReady{
		Context:       kubeconfig.Context,
		Namespace:     kubeconfig.Namespace,
		Pod:           pod.Name,
		URL:           proxy.URL() + "/dashboard/",
		Subject:       state.description.Subject,
		SessionExpiry: state.description.IdleExpires,
		AccessMode:    state.description.AccessMode,
	}
	if err := out.WriteReady(ready, opts.Output); err != nil {
		return shutdownAdminDashboard(
			ctx,
			opts.Timeout,
			sessionClient,
			holder,
			proxy,
			cancelProxy,
			cancelForward,
			tunnel,
			false,
			nil,
			err,
		)
	}
	if !opts.NoOpen {
		if err := deps.openURL(ready.URL); err != nil {
			if progressErr := progress.WriteProgress(
				fmt.Sprintf("Browser launch failed; open the printed URL manually: %v", err),
			); progressErr != nil {
				return shutdownAdminDashboard(
					ctx,
					opts.Timeout,
					sessionClient,
					holder,
					proxy,
					cancelProxy,
					cancelForward,
					tunnel,
					false,
					nil,
					progressErr,
				)
			}
		}
	}

	rotation := deps.rotation(proxyCtx, adminSessionRotationInterval)
	defer rotation.Stop()
	for {
		select {
		case forwardErr := <-tunnel.Done:
			primary := errors.New(
				"admin dashboard port-forward stopped unexpectedly; rerun the command to reconnect",
			)
			if forwardErr != nil {
				primary = fmt.Errorf("admin dashboard port-forward stopped: %w", forwardErr)
			}
			return shutdownAdminDashboard(
				ctx,
				opts.Timeout,
				sessionClient,
				holder,
				proxy,
				cancelProxy,
				cancelForward,
				tunnel,
				true,
				forwardErr,
				primary,
			)
		case <-proxy.Done():
			return shutdownAdminDashboard(
				ctx,
				opts.Timeout,
				sessionClient,
				holder,
				proxy,
				cancelProxy,
				cancelForward,
				tunnel,
				false,
				nil,
				errors.New("browser-facing admin proxy stopped unexpectedly"),
			)
		case _, ok := <-rotation.C():
			if !ok {
				return shutdownAdminDashboard(
					ctx,
					opts.Timeout,
					sessionClient,
					holder,
					proxy,
					cancelProxy,
					cancelForward,
					tunnel,
					false,
					nil,
					errors.New("admin session rotation scheduler stopped unexpectedly"),
				)
			}
			refreshCtx, cancelRefresh := context.WithTimeout(
				context.WithoutCancel(ctx),
				opts.Timeout,
			)
			var replacement adminSessionState
			refreshErr := holder.Rotate(refreshCtx, func(
				rotationCtx context.Context,
				current string,
			) (string, error) {
				var rotateErr error
				replacement, rotateErr = sessionClient.Rotate(rotationCtx, pod, current)
				if rotateErr != nil {
					return "", fmt.Errorf("rotate admin session: %w", rotateErr)
				}
				return replacement.token, nil
			}, boundedAdminOrphanCleanup(ctx, opts.Timeout, sessionClient))
			cancelRefresh()
			if refreshErr != nil {
				return shutdownAdminDashboard(
					ctx,
					opts.Timeout,
					sessionClient,
					holder,
					proxy,
					cancelProxy,
					cancelForward,
					tunnel,
					false,
					nil,
					fmt.Errorf("refresh verified admin session: %w", refreshErr),
				)
			}
		case <-ctx.Done():
			return shutdownAdminDashboard(
				ctx,
				opts.Timeout,
				sessionClient,
				holder,
				proxy,
				cancelProxy,
				cancelForward,
				tunnel,
				false,
				nil,
				nil,
			)
		}
	}
}

func adminSelectedPodGetterFromLister(lister adminPodLister) adminSelectedPodGetter {
	return func(ctx context.Context, namespace, name string) (*corev1.Pod, error) {
		pods, err := lister(ctx, namespace, metav1.ListOptions{
			FieldSelector: fields.OneTermEqualSelector("metadata.name", name).String(),
		})
		if err != nil {
			return nil, fmt.Errorf("read selected pod %s/%s: %w", namespace, name, err)
		}
		if pods == nil || len(pods.Items) != 1 {
			return nil, fmt.Errorf(
				"selected pod %s/%s revalidation returned %d matches",
				namespace,
				name,
				adminPodListLength(pods),
			)
		}
		return pods.Items[0].DeepCopy(), nil
	}
}

func adminPodListLength(pods *corev1.PodList) int {
	if pods == nil {
		return 0
	}
	return len(pods.Items)
}

//nolint:gocritic // The expected description is an immutable comparison value.
func validateAdminProxySession(
	ctx context.Context,
	proxyOrigin string,
	expected admin.SessionDescription,
	now time.Time,
) error {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		proxyOrigin+"/admin/session",
		http.NoBody,
	)
	if err != nil {
		return errors.New("build admin proxy session validation request")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return errors.New("request admin proxy session validation")
	}
	if err = normalizeAdminResponse(response, "admin proxy session validation"); err != nil {
		return err
	}
	defer closeAdminResponse(response.Body)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("admin proxy session validation returned HTTP %d", response.StatusCode)
	}
	var description admin.SessionDescription
	if err := decodeStrictAdminJSON(response.Body, &description); err != nil {
		return fmt.Errorf("decode admin proxy session validation: %w", err)
	}
	return validateAdminDescription(expected, description, now)
}

type adminRotationSchedule struct {
	ticks <-chan time.Time
	stop  func()
}

func (schedule adminRotationSchedule) C() <-chan time.Time {
	return schedule.ticks
}

func (schedule adminRotationSchedule) Stop() {
	if schedule.stop != nil {
		schedule.stop()
	}
}

func adminRotationTicks(ctx context.Context, interval time.Duration) adminRotationSchedule {
	ticks := make(chan time.Time)
	runCtx, cancel := context.WithCancel(ctx)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		defer close(ticks)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case tick := <-ticker.C:
				select {
				case ticks <- tick:
				case <-runCtx.Done():
					return
				}
			case <-runCtx.Done():
				return
			}
		}
	}()
	var stopOnce sync.Once
	return adminRotationSchedule{
		ticks: ticks,
		stop: func() {
			stopOnce.Do(func() {
				cancel()
				<-joined
			})
		},
	}
}

func bestEffortAdminRevoke(
	ctx context.Context,
	session adminDashboardSession,
	token string,
) error {
	if session == nil || !validAdminSecret(token) {
		return nil
	}
	if err := session.Revoke(ctx, token); err != nil {
		return fmt.Errorf("revoke admin session: %w", err)
	}
	return nil
}

func boundedAdminOrphanCleanup(
	ctx context.Context,
	timeout time.Duration,
	session adminDashboardSession,
) func(string) error {
	return func(orphanedToken string) error {
		cleanupCtx, cancelCleanup := context.WithTimeout(
			context.WithoutCancel(ctx),
			timeout,
		)
		defer cancelCleanup()
		return bestEffortAdminRevoke(cleanupCtx, session, orphanedToken)
	}
}

func shutdownAdminDashboard(
	ctx context.Context,
	timeout time.Duration,
	session adminDashboardSession,
	holder *adminTokenHolder,
	proxy adminDashboardProxy,
	cancelProxy context.CancelFunc,
	cancelForward context.CancelFunc,
	tunnel adminPortForward,
	tunnelDoneConsumed bool,
	tunnelErr error,
	primary error,
) error {
	cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancelCleanup()
	token, handoffErr := holder.BeginShutdown(cleanupCtx)
	revokeErr := bestEffortAdminRevoke(cleanupCtx, session, token)

	_, clearErr := holder.Clear(cleanupCtx)
	proxyErr := proxy.Close(cleanupCtx)
	cancelProxy()

	forwardErr := finishAdminForwardForShutdown(
		cleanupCtx,
		cancelForward,
		tunnel,
		tunnelDoneConsumed,
		tunnelErr,
		primary,
	)
	if proxyErr != nil {
		proxyErr = fmt.Errorf("finish browser-facing admin proxy: %w", proxyErr)
	}
	return errors.Join(primary, handoffErr, revokeErr, clearErr, proxyErr, forwardErr)
}

func finishAdminForwardForShutdown(
	ctx context.Context,
	cancel context.CancelFunc,
	tunnel adminPortForward,
	doneConsumed bool,
	tunnelErr error,
	primary error,
) error {
	cancel()
	if doneConsumed {
		return finishConsumedAdminForward(ctx, tunnel.Joined, tunnelErr, primary)
	}
	if tunnel.Done == nil {
		return errors.New("active forwarding tunnel has no completion channel")
	}
	completedErr, waitErr := waitAdminForwardCompletion(ctx, tunnel.Done)
	if waitErr != nil {
		return waitErr
	}
	if tunnel.Joined != nil {
		if err := waitAdminForwardJoined(ctx, tunnel.Joined); err != nil {
			return err
		}
	}
	if completedErr != nil {
		return fmt.Errorf("finish admin dashboard port-forward: %w", completedErr)
	}
	return nil
}

func finishConsumedAdminForward(
	ctx context.Context,
	joined <-chan struct{},
	tunnelErr, primary error,
) error {
	if joined != nil {
		if err := waitAdminForwardJoined(ctx, joined); err != nil {
			return err
		}
	}
	if tunnelErr != nil && primary == nil {
		return fmt.Errorf("finish admin dashboard port-forward: %w", tunnelErr)
	}
	return nil
}

func waitAdminForwardCompletion(
	ctx context.Context,
	done <-chan error,
) (completedErr, waitErr error) {
	select {
	case completedErr := <-done:
		return completedErr, nil
	default:
	}
	select {
	case completedErr := <-done:
		return completedErr, nil
	case <-ctx.Done():
		return nil, fmt.Errorf(
			"wait for admin dashboard port-forward completion: %w",
			ctx.Err(),
		)
	}
}

func waitAdminForwardJoined(ctx context.Context, joined <-chan struct{}) error {
	select {
	case <-joined:
		return nil
	default:
	}
	select {
	case <-joined:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for admin dashboard port-forward join: %w", ctx.Err())
	}
}

type adminForwardResult struct {
	forward adminPortForward
	err     error
}

func joinPendingAdminForward(
	cancel context.CancelFunc,
	resultCh <-chan adminForwardResult,
	primary error,
) error {
	cancel()
	result := <-resultCh
	if result.err != nil {
		setupErr := errors.Join(primary, fmt.Errorf("finish forwarding setup: %w", result.err))
		if result.forward.Done != nil {
			return joinActiveAdminForward(cancel, result.forward, setupErr)
		}
		return setupErr
	}
	if result.forward.Done == nil {
		return errors.Join(primary, errors.New("forwarding setup returned no completion channel"))
	}
	return joinAdminForwardDone(result.forward.Done, result.forward.Joined, primary)
}

func joinActiveAdminForward(
	cancel context.CancelFunc,
	forward adminPortForward,
	primary error,
) error {
	cancel()
	if forward.Done == nil {
		return errors.Join(primary, errors.New("active forwarding tunnel has no completion channel"))
	}
	return joinAdminForwardDone(forward.Done, forward.Joined, primary)
}

func joinAdminForwardDone(
	done <-chan error,
	joined <-chan struct{},
	primary error,
) error {
	forwardErr := <-done
	if joined != nil {
		<-joined
	}
	if forwardErr != nil {
		return errors.Join(primary, fmt.Errorf("finish admin dashboard port-forward: %w", forwardErr))
	}
	return primary
}
