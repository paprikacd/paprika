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

// Package main is the entry point for the Paprika operator and API server.
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	"github.com/benebsworth/paprika/analysis"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/gates"
	"github.com/benebsworth/paprika/health"
	"github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	controller "github.com/benebsworth/paprika/internal/controller/pipelines"
	webhookpipelinesv1alpha1 "github.com/benebsworth/paprika/internal/webhook/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/traffic"
	// +kubebuilder:scaffold:imports
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
}

func main() {
	var metricsAddr string
	var metricsCertPath, metricsCertName, metricsCertKey string
	var webhookCertPath, webhookCertName, webhookCertKey string
	var enableLeaderElection bool
	var probeAddr string
	var secureMetrics bool
	var enableHTTP2 bool
	var operatorNamespace string
	var uiAddr string
	var mode string
	var k8sAPIServer string
	var k8sTokenFile string
	flag.StringVar(&metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	flag.BoolVar(&secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	flag.StringVar(&webhookCertPath, "webhook-cert-path", "", "The directory that contains the webhook certificate.")
	flag.StringVar(&webhookCertName, "webhook-cert-name", "tls.crt", "The name of the webhook certificate file.")
	flag.StringVar(&webhookCertKey, "webhook-cert-key", "tls.key", "The name of the webhook key file.")
	flag.StringVar(&metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	flag.StringVar(&metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	flag.StringVar(&metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	flag.BoolVar(&enableHTTP2, "enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics and webhook servers")
	flag.StringVar(&operatorNamespace, "operator-namespace", "paprika-system",
		"The namespace where the operator runs (used for manifest snapshots and step jobs).")
	flag.StringVar(&uiAddr, "ui-bind-address", ":3000",
		"The address the UI dashboard server binds to.")
	flag.StringVar(&mode, "mode", "operator",
		"Running mode: 'operator' (controllers + API) or 'api' (API server only).")
	flag.StringVar(&k8sAPIServer, "k8s-api-server", "",
		"Kubernetes API server URL. Only used in 'api' mode.")
	flag.StringVar(&k8sTokenFile, "k8s-token-file", "",
		"Path to Kubernetes service account token. Only used in 'api' mode.")
	opts := zap.Options{
		Development: true,
	}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	if mode != "operator" && mode != "api" {
		setupLog.Error(fmt.Errorf("invalid mode: %s", mode), "Must be 'operator' or 'api'")
		os.Exit(1)
	}

	if mode == "api" {
		if err := runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr, probeAddr); err != nil {
			setupLog.Error(err, "API mode failed")
			os.Exit(1)
		}
		os.Exit(0)
	}

	runOperatorMode(uiAddr, metricsAddr, probeAddr, webhookCertPath, webhookCertName, webhookCertKey,
		metricsCertPath, metricsCertName, metricsCertKey, operatorNamespace,
		enableLeaderElection, secureMetrics, enableHTTP2)
}

func runOperatorMode(uiAddr, metricsAddr, probeAddr, webhookCertPath, webhookCertName, webhookCertKey,
	metricsCertPath, metricsCertName, metricsCertKey, operatorNamespace string,
	enableLeaderElection, secureMetrics, enableHTTP2 bool) {
	tlsOpts := buildOperatorTLSOptions(enableHTTP2)
	webhookServer := buildOperatorWebhookServer(tlsOpts, webhookCertPath, webhookCertName, webhookCertKey)
	metricsServerOptions := buildOperatorMetricsOptions(tlsOpts, metricsAddr, metricsCertPath, metricsCertName, metricsCertKey, secureMetrics)

	cfg := ctrl.GetConfigOrDie()
	cfg.QPS = 50
	cfg.Burst = 100
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsServerOptions,
		WebhookServer:          webhookServer,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "paprika-operator.paprika.io",
	})
	if err != nil {
		setupLog.Error(err, "Failed to start manager")
		os.Exit(1)
	}

	k8sClient, err := kubernetes.NewForConfig(mgr.GetConfig())
	if err != nil {
		setupLog.Error(err, "Failed to create kubernetes clientset")
		os.Exit(1)
	}

	setupOperatorControllers(mgr, k8sClient, operatorNamespace)
	startOperatorUI(mgr, uiAddr)

	setupLog.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "Failed to run manager")
		os.Exit(1)
	}
}

func buildOperatorTLSOptions(enableHTTP2 bool) []func(*tls.Config) {
	if enableHTTP2 {
		return nil
	}
	setupLog.Info("Disabling HTTP/2")
	return []func(*tls.Config){func(c *tls.Config) {
		c.NextProtos = []string{"http/1.1"}
	}}
}

func buildOperatorWebhookServer(tlsOpts []func(*tls.Config), certPath, certName, certKey string) webhook.Server {
	options := webhook.Options{TLSOpts: tlsOpts}
	if certPath != "" {
		setupLog.Info("Initializing webhook certificate watcher using provided certificates",
			"webhook-cert-path", certPath, "webhook-cert-name", certName, "webhook-cert-key", certKey)
		options.CertDir = certPath
		options.CertName = certName
		options.KeyName = certKey
	}
	return webhook.NewServer(options)
}

func buildOperatorMetricsOptions(tlsOpts []func(*tls.Config), bindAddr, certPath, certName, certKey string, secure bool) metricsserver.Options {
	options := metricsserver.Options{
		BindAddress:   bindAddr,
		SecureServing: secure,
		TLSOpts:       tlsOpts,
	}
	if secure {
		options.FilterProvider = filters.WithAuthenticationAndAuthorization
	}
	if certPath != "" {
		setupLog.Info("Initializing metrics certificate watcher using provided certificates",
			"metrics-cert-path", certPath, "metrics-cert-name", certName, "metrics-cert-key", certKey)
		options.CertDir = certPath
		options.CertName = certName
		options.KeyName = certKey
	}
	return options
}

func setupPipelineController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string) error {
	if err := (&controller.PipelineReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		K8sClient: k8sClient, Namespace: operatorNamespace,
		WorkflowEngine: engine.NewWorkflowEngine(k8sClient, operatorNamespace),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up pipeline controller: %w", err)
	}
	return nil
}

func setupStageController(mgr ctrl.Manager) error {
	if err := (&controller.StageReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up stage controller: %w", err)
	}
	return nil
}

func setupReleaseController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string) error {
	dynamicClient, err := dynamic.NewForConfig(mgr.GetConfig())
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}
	if err := (&controller.ReleaseReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		K8sClient: k8sClient, Namespace: operatorNamespace,
		DynamicClient:        dynamicClient,
		RestConfig:           mgr.GetConfig(),
		ClusterMgr:           controller.NewClusterClientManager(mgr.GetClient(), mgr.GetConfig()),
		GateExecutor:         gates.NewSmokeGate(),
		Analyzer:             analysis.NewAnalyzer(k8sClient, operatorNamespace, mgr.GetConfig()),
		TemplateRenderer:     engine.NewTemplateRenderer("/tmp/paprika-helm"),
		TrafficRouterFactory: traffic.NewRouter,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up release controller: %w", err)
	}
	return nil
}

func setupTemplateController(mgr ctrl.Manager) error {
	if err := (&controller.TemplateReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up template controller: %w", err)
	}
	return nil
}

func setupArtifactController(mgr ctrl.Manager) error {
	if err := (&controller.ArtifactReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up artifact controller: %w", err)
	}
	return nil
}

func setupApplicationController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string) error {
	dynClient, err := dynamic.NewForConfig(mgr.GetConfig())
	if err != nil {
		return fmt.Errorf("creating dynamic client: %w", err)
	}
	k8sClientset, ok := k8sClient.(*kubernetes.Clientset)
	if !ok {
		return fmt.Errorf("expected *kubernetes.Clientset, got %T", k8sClient)
	}
	if err := (&controller.ApplicationReconciler{
		Client:     mgr.GetClient(),
		Scheme:     mgr.GetScheme(),
		K8sClient:  k8sClientset,
		Namespace:  operatorNamespace,
		RestConfig: mgr.GetConfig(),
		WorkDir:    "/tmp/paprika-sources",
		HealthEval: health.NewEvaluator(),
		DiffEngine: engine.NewDiffEngine(dynClient, discovery.NewDiscoveryClientForConfigOrDie(mgr.GetConfig())),
		ResHealth:  health.NewResourceHealthChecker(mgr.GetClient()),
		ClusterMgr: controller.NewClusterClientManager(mgr.GetClient(), mgr.GetConfig()),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up application controller: %w", err)
	}
	return nil
}

func setupOperatorControllers(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string) {
	controllers := []struct {
		name  string
		setup func() error
	}{
		{"pipeline", func() error { return setupPipelineController(mgr, k8sClient, operatorNamespace) }},
		{"stage", func() error { return setupStageController(mgr) }},
		{"release", func() error { return setupReleaseController(mgr, k8sClient, operatorNamespace) }},
		{"template", func() error { return setupTemplateController(mgr) }},
		{"artifact", func() error { return setupArtifactController(mgr) }},
		{"application", func() error { return setupApplicationController(mgr, k8sClient, operatorNamespace) }},
	}

	for _, c := range controllers {
		if err := c.setup(); err != nil {
			setupLog.Error(err, "Failed to create controller", "controller", c.name)
			os.Exit(1)
		}
	}
	// +kubebuilder:scaffold:webhook
	if os.Getenv("ENABLE_WEBHOOKS") != "false" {
		if err := webhookpipelinesv1alpha1.SetupPipelineWebhookWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create webhook", "webhook", "Pipeline")
			os.Exit(1)
		}
		if err := webhookpipelinesv1alpha1.SetupStageWebhookWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create webhook", "webhook", "Stage")
			os.Exit(1)
		}
		if err := webhookpipelinesv1alpha1.SetupReleaseWebhookWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create webhook", "webhook", "Release")
			os.Exit(1)
		}
		if err := webhookpipelinesv1alpha1.SetupTemplateWebhookWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create webhook", "webhook", "Template")
			os.Exit(1)
		}
	}
	// +kubebuilder:scaffold:builder

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up ready check")
		os.Exit(1)
	}
}

func startOperatorUI(mgr ctrl.Manager, uiAddr string) {
	paprikaServer := api.NewPaprikaServer(mgr.GetClient())
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer)

	uiMux := http.NewServeMux()
	uiMux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	uiMux.Handle("/", api.UIHandler())

	uiServer := &http.Server{
		Addr:              uiAddr,
		Handler:           uiMux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		setupLog.Info("Starting UI server", "addr", uiAddr)
		if err := uiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			setupLog.Error(err, "UI server error")
			os.Exit(1)
		}
	}()
}

func runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr, probeAddr string) error {
	config, err := buildAPIConfig(k8sAPIServer, k8sTokenFile)
	if err != nil {
		return err
	}

	apiClient, err := createAPIClient(config)
	if err != nil {
		return err
	}

	paprikaServer := api.NewPaprikaServer(apiClient)
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer)

	mux := buildAPIMux(connectHandler)
	healthMux := buildHealthMux()

	startHealthProbeServer(healthMux, probeAddr)
	return startAPIServer(mux, uiAddr)
}

func buildAPIConfig(k8sAPIServer, k8sTokenFile string) (*rest.Config, error) {
	if k8sAPIServer == "" {
		config, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("get in-cluster config (use --k8s-api-server): %w", err)
		}
		return config, nil
	}

	token, err := readBearerToken(k8sTokenFile)
	if err != nil {
		return nil, err
	}
	return &rest.Config{
		Host:            k8sAPIServer,
		BearerToken:     token,
		TLSClientConfig: rest.TLSClientConfig{Insecure: false},
	}, nil
}

func readBearerToken(k8sTokenFile string) (string, error) {
	if k8sTokenFile == "" {
		// #nosec G304 -- hardcoded in-cluster token path
		data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
		if err != nil {
			return "", fmt.Errorf("no token file or in-cluster token: %w", err)
		}
		return string(data), nil
	}
	// #nosec G304 -- k8sTokenFile is from a command-line flag
	data, err := os.ReadFile(k8sTokenFile)
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	return string(data), nil
}

func createAPIClient(config *rest.Config) (client.Client, error) {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	apiClient, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create k8s client: %w", err)
	}
	return apiClient, nil
}

func buildAPIMux(connectHandler http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	mux.Handle("/healthz", http.HandlerFunc(healthzHandler))
	mux.Handle("/", api.UIHandler())
	return mux
}

func buildHealthMux() *http.ServeMux {
	healthMux := http.NewServeMux()
	healthMux.Handle("/healthz", http.HandlerFunc(healthzHandler))
	healthMux.Handle("/readyz", http.HandlerFunc(healthzHandler))
	return healthMux
}

func healthzHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintln(w, "ok")
}

func startHealthProbeServer(healthMux *http.ServeMux, probeAddr string) {
	healthServer := &http.Server{
		Addr:              probeAddr,
		Handler:           healthMux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		setupLog.Info("Starting health probe server", "addr", probeAddr)
		if err := healthServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			setupLog.Error(err, "Health probe server error")
		}
	}()
}

func startAPIServer(mux *http.ServeMux, uiAddr string) error {
	server := &http.Server{
		Addr:              uiAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	setupLog.Info("Starting API server", "addr", uiAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("api server error: %w", err)
	}
	return nil
}
