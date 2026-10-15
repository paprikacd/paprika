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

// Package observe holds the controllers behind the observability gateway's
// Kubernetes integration. ProviderDiscoveryReconciler is the only one today:
// it materializes annotated Services as ObservabilityProvider CRs so an
// in-cluster Prometheus, Loki, or Tempo registers itself with the gateway
// without anyone hand-writing provider YAML.
package observe

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
)

// Service annotations that opt a Service in to observability provider
// discovery and shape the provider the gateway gets. Everything is opt-in:
// a Service without DiscoverAnnotation is never touched.
const (
	// DiscoverAnnotation opts the Service into discovery. Value must be "true".
	DiscoverAnnotation = "observability.paprika.io/discover"
	// TypeAnnotation overrides connector type inference with an explicit
	// connector type (prometheus, loki, tempo, otlp).
	TypeAnnotation = "observability.paprika.io/type"
	// PortAnnotation overrides port selection with an explicit port number.
	PortAnnotation = "observability.paprika.io/port"
	// PathAnnotation appends a base path to the endpoint, for backends served
	// under a sub-path (e.g. Prometheus behind /prometheus). A leading slash
	// is added when missing.
	PathAnnotation = "observability.paprika.io/path"
)

// discoveredLabel marks ObservabilityProvider CRs this controller created, so
// deletion and convergence never touch a provider an operator wrote by hand.
// Removing the label from a CR hands ownership to the operator permanently.
const (
	discoveredLabel = "observability.paprika.io/discovered"
	discoveryValue  = "service"
)

// wellKnownPorts names the Service ports each connector prefers, in order,
// before falling back to the Service's first port. Charts serving these
// backends converge on these names across kube-prometheus-stack, loki, and
// tempo distributions.
var wellKnownPorts = map[string][]string{
	"prometheus": {"http-web", "web", "http"},
	"loki":       {"http-metrics", "http", "metrics"},
	// grafana/tempo's chart names its HTTP API port tempo-prom-metrics (the
	// query-frontend name appears in the tempo-distributed chart).
	"tempo": {"http", "tempo-query-frontend", "tempo-prom-metrics"},
	"otlp":  {"otlp-http", "http"},
}

// ProviderDiscoveryReconciler reconciles annotated Services into
// ObservabilityProvider CRs. The gateway's query path reads only CRs, so
// discovery keeps the CR-as-system-of-record invariant: a discovered
// provider is a normal provider an operator can inspect, edit, and delete,
// and the Service's ownerReference cascade-cleans it when the backend goes
// away.
type ProviderDiscoveryReconciler struct {
	client client.Client
	Scheme *runtime.Scheme
	Clock  clock.Clock
}

// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch
// +kubebuilder:rbac:groups=observability.paprika.io,resources=observabilityproviders,verbs=get;list;watch;create;update;patch;delete
// The gateway's status prober shares this identity (discovery runs inside the
// gateway pod): it probes every provider and writes the reachability verdict
// through the status subresource.
// +kubebuilder:rbac:groups=observability.paprika.io,resources=observabilityproviders/status,verbs=get;update;patch

// Reconcile materializes (or removes) the ObservabilityProvider for one
// Service. Un-annotated Services reconcile to "no provider": the only CRs
// ever deleted here carry the discovered label and are owned by this exact
// Service, so a name collision with an operator-written provider is safe.
//
//nolint:cyclop // sequential guard branches: get, classify, create-or-converge.
func (r *ProviderDiscoveryReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, spanErr error) {
	ctx, endSpan := observability.ReconcileSpan(ctx, "ProviderDiscovery", req)
	defer func() { endSpan(spanErr) }()

	result := "success"
	start := metrics.Timer(r.Clock)
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("providerdiscovery", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("providerdiscovery").Observe(metrics.Since(r.Clock, start))
	}()

	logger := log.FromContext(ctx)

	var svc corev1.Service
	if err := r.client.Get(ctx, req.NamespacedName, &svc); err != nil {
		result = "error"
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("getting service: %w", err)
		}
		// The Service is gone; its ownerReference garbage-collects any
		// provider this controller created, so there is nothing to do.
		return ctrl.Result{}, nil
	}

	var provider observabilityv1alpha1.ObservabilityProvider
	getErr := r.client.Get(ctx, types.NamespacedName{Namespace: svc.Namespace, Name: svc.Name}, &provider)
	exists := getErr == nil
	if !exists && !apierrors.IsNotFound(getErr) {
		result = "error"
		return ctrl.Result{}, fmt.Errorf("getting observability provider: %w", getErr)
	}

	if svc.Annotations[DiscoverAnnotation] != "true" {
		if exists && provider.Labels[discoveredLabel] == discoveryValue && metav1.IsControlledBy(&provider, &svc) {
			if err := r.client.Delete(ctx, &provider); err != nil {
				result = "error"
				return ctrl.Result{}, fmt.Errorf("deleting stale discovered provider: %w", err)
			}
			logger.Info("Removed discovered observability provider (discovery annotation removed)",
				"service", svc.Name, "namespace", svc.Namespace)
		}
		return ctrl.Result{}, nil
	}

	providerType, endpoint, ok := resolveEndpoint(ctx, &svc)
	if !ok {
		// resolveEndpoint logged the specific reason. Not requeued: nothing
		// will change until the Service itself changes.
		return ctrl.Result{}, nil
	}

	if !exists {
		if err := r.createProvider(ctx, &svc, providerType, endpoint); err != nil {
			result = "error"
			return ctrl.Result{}, err
		}
		logger.Info("Discovered observability provider from service",
			"service", svc.Name, "namespace", svc.Namespace, "type", providerType, "endpoint", endpoint)
		return ctrl.Result{}, nil
	}

	// The provider exists. Operators take ownership by dropping the
	// discovered label; from then on this controller leaves the CR alone.
	if provider.Labels[discoveredLabel] != discoveryValue {
		return ctrl.Result{}, nil
	}
	if provider.Spec.Type != providerType || endpointOf(provider.Spec.Config.Raw) != endpoint {
		provider.Spec.Type = providerType
		provider.Spec.Config = runtime.RawExtension{Raw: endpointConfig(endpoint)}
		if err := r.client.Update(ctx, &provider); err != nil {
			result = "error"
			return ctrl.Result{}, fmt.Errorf("converging discovered provider: %w", err)
		}
		logger.Info("Converged discovered observability provider",
			"service", svc.Name, "namespace", svc.Namespace, "type", providerType, "endpoint", endpoint)
	}
	return ctrl.Result{}, nil
}

// createProvider builds the discovered CR with the discovered label and a
// controller ownerReference on the Service (same namespace, so the reference
// is valid and cascade-deletes with the backend).
func (r *ProviderDiscoveryReconciler) createProvider(ctx context.Context, svc *corev1.Service, providerType, endpoint string) error {
	provider := &observabilityv1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{
			Name:      svc.Name,
			Namespace: svc.Namespace,
			Labels:    map[string]string{discoveredLabel: discoveryValue},
		},
		Spec: observabilityv1alpha1.ObservabilityProviderSpec{
			Type:   providerType,
			Config: runtime.RawExtension{Raw: endpointConfig(endpoint)},
		},
	}
	if err := controllerutil.SetControllerReference(svc, provider, r.Scheme); err != nil {
		return fmt.Errorf("setting owner reference: %w", err)
	}
	if err := r.client.Create(ctx, provider); err != nil {
		return fmt.Errorf("creating discovered provider: %w", err)
	}
	return nil
}

// resolveEndpoint maps an annotated Service onto a connector type and an
// in-cluster HTTP endpoint. It reports false — with the reason logged — when
// the type cannot be determined or the Service exposes no usable port.
func resolveEndpoint(ctx context.Context, svc *corev1.Service) (providerType, endpoint string, ok bool) {
	logger := log.FromContext(ctx)

	providerType = svc.Annotations[TypeAnnotation]
	if providerType == "" {
		providerType = inferType(svc.Name)
	}
	if _, known := wellKnownPorts[providerType]; !known {
		if svc.Annotations[TypeAnnotation] != "" {
			logger.Info("Skipping observability discovery: unknown connector type",
				"type", svc.Annotations[TypeAnnotation], "service", svc.Name, "namespace", svc.Namespace,
				"annotation", TypeAnnotation)
		} else {
			logger.Info("Skipping observability discovery: service name matches no known backend and no type annotation",
				"service", svc.Name, "namespace", svc.Namespace, "annotation", TypeAnnotation)
		}
		return "", "", false
	}

	port, ok := resolvePort(ctx, svc, providerType)
	if !ok {
		logger.Info("Skipping observability discovery: no usable port",
			"service", svc.Name, "namespace", svc.Namespace, "type", providerType)
		return "", "", false
	}

	path := svc.Annotations[PathAnnotation]
	if path != "" && !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	return providerType, fmt.Sprintf("http://%s.%s.svc:%d%s", svc.Name, svc.Namespace, port, path), true
}

// inferType recognizes the backends the connectors speak from the Service
// name — kube-prometheus-stack, loki, tempo, and otel-collector chart
// services all name themselves after the backend. Longest/most-specific
// matches first is unnecessary: the substrings are disjoint.
func inferType(name string) string {
	name = strings.ToLower(name)
	switch {
	case strings.Contains(name, "prometheus"):
		return "prometheus"
	case strings.Contains(name, "loki"):
		return "loki"
	case strings.Contains(name, "tempo"):
		return "tempo"
	case strings.Contains(name, "otel"):
		return "otlp"
	default:
		return ""
	}
}

// resolvePort picks the Service port an annotation names, else the first
// well-known port name for the connector type, else the first declared port.
// An invalid port annotation is a hard reject, not a fall-through: a typo'd
// override must not silently resolve to a different port.
func resolvePort(ctx context.Context, svc *corev1.Service, providerType string) (int32, bool) {
	if raw, present := svc.Annotations[PortAnnotation]; present {
		return parsePortAnnotation(ctx, svc, raw)
	}
	for _, want := range wellKnownPorts[providerType] {
		for _, p := range svc.Spec.Ports {
			if p.Name == want && p.Port > 0 {
				return p.Port, true
			}
		}
	}
	if len(svc.Spec.Ports) > 0 && svc.Spec.Ports[0].Port > 0 {
		return svc.Spec.Ports[0].Port, true
	}
	return 0, false
}

// parsePortAnnotation resolves the port annotation to a valid port number,
// rejecting (with a log) values that do not parse or fall outside the TCP
// range.
func parsePortAnnotation(ctx context.Context, svc *corev1.Service, raw string) (int32, bool) {
	port, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || port <= 0 || port > 65535 {
		log.FromContext(ctx).Info("Skipping observability discovery: invalid port annotation",
			"service", svc.Name, "namespace", svc.Namespace, "annotation", PortAnnotation, "value", raw)
		return 0, false
	}
	return int32(port), true
}

// endpointConfig builds the opaque connector config document the connectors
// validate: exactly one key, the endpoint URL. strconv.Quote cannot fail,
// unlike json.Marshal on a map.
func endpointConfig(endpoint string) json.RawMessage {
	return json.RawMessage(`{"endpoint":` + strconv.Quote(endpoint) + `}`)
}

// endpointOf extracts the endpoint from a provider's opaque config document,
// returning "" when the document does not carry one. Convergence compares
// against this, so an operator-shaped config with extra keys is left alone.
func endpointOf(config json.RawMessage) string {
	var doc map[string]string
	if err := json.Unmarshal(config, &doc); err != nil {
		return ""
	}
	return doc["endpoint"]
}

// SetupWithManager sets up the controller with the Manager. Every Service is
// watched — annotation removal must reconcile too, so there is no annotation
// predicate — and owned providers map back to their Service so a deleted
// discovered CR is re-materialized.
func (r *ProviderDiscoveryReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if r.Clock == nil {
		r.Clock = clock.Real{}
	}
	if r.Scheme == nil {
		r.Scheme = mgr.GetScheme()
	}
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Service{}).
		Owns(&observabilityv1alpha1.ObservabilityProvider{}).
		Named("observability-providerdiscovery").
		Complete(r); err != nil {
		return fmt.Errorf("failed to setup ProviderDiscovery controller: %w", err)
	}
	return nil
}
