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
	"time"

	"github.com/spf13/cobra"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const defaultAdminDashboardTimeout = 30 * time.Second

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
	Context   string `json:"context"`
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	URL       string `json:"url"`
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

func (o adminDashboardOutput) WriteReady(ready adminDashboardReady, output string) error {
	switch output {
	case outputJSON:
		if err := json.NewEncoder(o.writer).Encode(ready); err != nil {
			return fmt.Errorf("write admin dashboard JSON readiness: %w", err)
		}
	case outputTable:
		if _, err := fmt.Fprintf(
			o.writer,
			"Context: %s\nNamespace: %s\nPod: %s\nURL: %s\n",
			ready.Context,
			ready.Namespace,
			ready.Pod,
			ready.URL,
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
	}
}

func runAdminDashboard(
	ctx context.Context,
	opts *adminDashboardOptions,
	out, progress adminDashboardOutput,
) error {
	return runAdminDashboardWithDependencies(
		ctx,
		opts,
		out,
		progress,
		defaultAdminDashboardDependencies(),
	)
}

//nolint:gocyclo,cyclop,funlen // Setup stages are kept explicit to preserve fail-closed ordering.
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
		deps.now == nil {
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
	if err := requireAdminPortForwardAccess(
		setupCtx,
		kubeconfig.Namespace,
		pod.Name,
		reviewer,
	); err != nil {
		return err
	}

	forwardCtx, cancelForward := context.WithCancel(ctx)
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
	cancelSetup()

	ready := adminDashboardReady{
		Context:   kubeconfig.Context,
		Namespace: kubeconfig.Namespace,
		Pod:       pod.Name,
		URL:       fmt.Sprintf("http://127.0.0.1:%d/dashboard/", tunnel.LocalPort),
	}
	if err := progress.WriteProgress(
		"Warning: exact pod port-forward permission grants unrestricted Paprika administration. " +
			adminNamespaceTrustWarning,
	); err != nil {
		return joinActiveAdminForward(cancelForward, tunnel, err)
	}
	if err := out.WriteReady(ready, opts.Output); err != nil {
		return joinActiveAdminForward(cancelForward, tunnel, err)
	}

	select {
	case forwardErr := <-tunnel.Done:
		cancelForward()
		if tunnel.Joined != nil {
			<-tunnel.Joined
		}
		if ctx.Err() != nil && forwardErr == nil {
			return nil
		}
		if forwardErr != nil {
			return fmt.Errorf("admin dashboard port-forward stopped: %w", forwardErr)
		}
		return errors.New("admin dashboard port-forward stopped unexpectedly; rerun the command to reconnect")
	case <-ctx.Done():
		return joinActiveAdminForward(cancelForward, tunnel, nil)
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
