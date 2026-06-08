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
	"crypto/tls"
	"flag"
	"fmt"
	"net/http"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
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

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/v1alpha1"
	"github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/controller"
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

// nolint:gocyclo
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
		if err := runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr); err != nil {
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
	var tlsOpts []func(*tls.Config)
	disableHTTP2 := func(c *tls.Config) {
		setupLog.Info("Disabling HTTP/2")
		c.NextProtos = []string{"http/1.1"}
	}

	if !enableHTTP2 {
		tlsOpts = append(tlsOpts, disableHTTP2)
	}

	webhookTLSOpts := tlsOpts
	webhookServerOptions := webhook.Options{
		TLSOpts: webhookTLSOpts,
	}

	if len(webhookCertPath) > 0 {
		setupLog.Info("Initializing webhook certificate watcher using provided certificates",
			"webhook-cert-path", webhookCertPath, "webhook-cert-name", webhookCertName, "webhook-cert-key", webhookCertKey)

		webhookServerOptions.CertDir = webhookCertPath
		webhookServerOptions.CertName = webhookCertName
		webhookServerOptions.KeyName = webhookCertKey
	}

	webhookServer := webhook.NewServer(webhookServerOptions)

	metricsServerOptions := metricsserver.Options{
		BindAddress:   metricsAddr,
		SecureServing: secureMetrics,
		TLSOpts:       tlsOpts,
	}

	if secureMetrics {
		metricsServerOptions.FilterProvider = filters.WithAuthenticationAndAuthorization
	}

	if len(metricsCertPath) > 0 {
		setupLog.Info("Initializing metrics certificate watcher using provided certificates",
			"metrics-cert-path", metricsCertPath, "metrics-cert-name", metricsCertName, "metrics-cert-key", metricsCertKey)

		metricsServerOptions.CertDir = metricsCertPath
		metricsServerOptions.CertName = metricsCertName
		metricsServerOptions.KeyName = metricsCertKey
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
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

	if err := (&controller.PipelineReconciler{
		Client:    mgr.GetClient(),
		Scheme:    mgr.GetScheme(),
		K8sClient: k8sClient,
		Namespace: operatorNamespace,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "pipeline")
		os.Exit(1)
	}
	if err := (&controller.StageReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "stage")
		os.Exit(1)
	}
	if err := (&controller.ReleaseReconciler{
		Client:    mgr.GetClient(),
		Scheme:    mgr.GetScheme(),
		K8sClient: k8sClient,
		Namespace: operatorNamespace,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "release")
		os.Exit(1)
	}
	if err := (&controller.TemplateReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "template")
		os.Exit(1)
	}
	if err := (&controller.ArtifactReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "artifact")
		os.Exit(1)
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

	paprikaServer := api.NewPaprikaServer(mgr.GetClient())
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer)

	uiMux := http.NewServeMux()
	uiMux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	uiMux.Handle("/", api.UIHandler())

	uiServer := &http.Server{
		Addr:    uiAddr,
		Handler: uiMux,
	}

	go func() {
		setupLog.Info("Starting UI server", "addr", uiAddr)
		if err := uiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			setupLog.Error(err, "UI server error")
			os.Exit(1)
		}
	}()

	setupLog.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "Failed to run manager")
		os.Exit(1)
	}
}

func runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr string) error {
	var config *rest.Config
	var err error

	if k8sAPIServer != "" {
		token := ""
		if k8sTokenFile != "" {
			data, err := os.ReadFile(k8sTokenFile)
			if err != nil {
				return fmt.Errorf("read token file: %w", err)
			}
			token = string(data)
		} else {
			data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
			if err != nil {
				return fmt.Errorf("no token file or in-cluster token: %w", err)
			}
			token = string(data)
		}
		config = &rest.Config{
			Host:            k8sAPIServer,
			BearerToken:     token,
			TLSClientConfig: rest.TLSClientConfig{Insecure: false},
		}
	} else {
		config, err = rest.InClusterConfig()
		if err != nil {
			return fmt.Errorf("get in-cluster config (use --k8s-api-server): %w", err)
		}
	}

	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))

	apiClient, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}

	paprikaServer := api.NewPaprikaServer(apiClient)
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer)

	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	mux.Handle("/healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	}))
	mux.Handle("/", api.UIHandler())

	server := &http.Server{Addr: uiAddr, Handler: mux}

	setupLog.Info("Starting API server", "addr", uiAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("api server error: %w", err)
	}
	return nil
}
