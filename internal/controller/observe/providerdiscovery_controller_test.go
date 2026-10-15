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

package observe

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
)

func newReconciler(t *testing.T, objs ...runtime.Object) (*ProviderDiscoveryReconciler, client.Client) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, observabilityv1alpha1.AddToScheme(scheme))
	builder := fake.NewClientBuilder().WithScheme(scheme)
	for _, obj := range objs {
		builder = builder.WithRuntimeObjects(obj)
	}
	c := builder.Build()
	return &ProviderDiscoveryReconciler{client: c, Scheme: scheme, Clock: clock.Real{}}, c
}

// annotatedService builds a Service opted in to discovery plus any extra
// annotations, exposing the given ports.
func annotatedService(name, ns string, annotations map[string]string, ports ...corev1.ServicePort) *corev1.Service {
	if annotations == nil {
		annotations = map[string]string{DiscoverAnnotation: "true"}
	}
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Annotations: annotations},
		Spec:       corev1.ServiceSpec{Ports: ports},
	}
}

func namedPort(name string, port int32) corev1.ServicePort {
	return corev1.ServicePort{Name: name, Port: port}
}

func reconcile(ctx context.Context, t *testing.T, r *ProviderDiscoveryReconciler, namespace, name string) (ctrl.Result, error) {
	t.Helper()
	return r.Reconcile(ctx, ctrl.Request{NamespacedName: types.NamespacedName{Namespace: namespace, Name: name}})
}

func getProvider(ctx context.Context, c client.Client, namespace, name string) (*observabilityv1alpha1.ObservabilityProvider, error) {
	var provider observabilityv1alpha1.ObservabilityProvider
	if err := c.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &provider); err != nil {
		return nil, err
	}
	return &provider, nil
}

func TestDiscoveryCreatesProviderFromAnnotatedService(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name         string
		svcName      string
		namespace    string
		annotations  map[string]string
		ports        []corev1.ServicePort
		wantType     string
		wantEndpoint string
	}{
		{
			name:         "prometheus by name with well-known port",
			svcName:      "prometheus-operated",
			namespace:    "monitoring",
			ports:        []corev1.ServicePort{namedPort("http-web", 9090), namedPort("grpc", 10901)},
			wantType:     "prometheus",
			wantEndpoint: "http://prometheus-operated.monitoring.svc:9090",
		},
		{
			name:         "kube-prometheus-stack full name resolves the http port",
			svcName:      "prom-kube-prometheus-prometheus",
			namespace:    "monitoring",
			ports:        []corev1.ServicePort{namedPort("http", 9090)},
			wantType:     "prometheus",
			wantEndpoint: "http://prom-kube-prometheus-prometheus.monitoring.svc:9090",
		},
		{
			name:         "loki by name with unnamed port falls back to first port",
			svcName:      "loki-gateway",
			namespace:    "monitoring",
			ports:        []corev1.ServicePort{{Port: 3100}},
			wantType:     "loki",
			wantEndpoint: "http://loki-gateway.monitoring.svc:3100",
		},
		{
			name:         "tempo query frontend",
			svcName:      "tempo-query-frontend",
			namespace:    "tracing",
			ports:        []corev1.ServicePort{namedPort("http", 3200), namedPort("grpc", 9095)},
			wantType:     "tempo",
			wantEndpoint: "http://tempo-query-frontend.tracing.svc:3200",
		},
		{
			name:         "otel collector",
			svcName:      "otel-collector",
			namespace:    "observability",
			ports:        []corev1.ServicePort{namedPort("otlp-http", 4318)},
			wantType:     "otlp",
			wantEndpoint: "http://otel-collector.observability.svc:4318",
		},
		{
			name:         "explicit type annotation overrides the name",
			svcName:      "metrics-backend",
			namespace:    "monitoring",
			annotations:  map[string]string{DiscoverAnnotation: "true", TypeAnnotation: "loki"},
			ports:        []corev1.ServicePort{{Port: 3100}},
			wantType:     "loki",
			wantEndpoint: "http://metrics-backend.monitoring.svc:3100",
		},
		{
			name:         "port annotation overrides port selection",
			svcName:      "prometheus-operated",
			namespace:    "monitoring",
			annotations:  map[string]string{DiscoverAnnotation: "true", PortAnnotation: "10902"},
			ports:        []corev1.ServicePort{namedPort("http-web", 9090)},
			wantType:     "prometheus",
			wantEndpoint: "http://prometheus-operated.monitoring.svc:10902",
		},
		{
			name:         "path annotation appends a base path",
			svcName:      "prometheus-operated",
			namespace:    "monitoring",
			annotations:  map[string]string{DiscoverAnnotation: "true", PathAnnotation: "prometheus"},
			ports:        []corev1.ServicePort{namedPort("http-web", 9090)},
			wantType:     "prometheus",
			wantEndpoint: "http://prometheus-operated.monitoring.svc:9090/prometheus",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := annotatedService(tc.svcName, tc.namespace, tc.annotations, tc.ports...)
			r, c := newReconciler(t, svc)

			_, err := reconcile(ctx, t, r, svc.Namespace, svc.Name)
			require.NoError(t, err)

			provider, err := getProvider(ctx, c, svc.Namespace, svc.Name)
			require.NoError(t, err)
			assert.Equal(t, tc.wantType, provider.Spec.Type)
			wantConfig, err := json.Marshal(map[string]string{"endpoint": tc.wantEndpoint})
			require.NoError(t, err)
			assert.JSONEq(t, string(wantConfig), string(provider.Spec.Config.Raw))
			assert.Equal(t, discoveryValue, provider.Labels[discoveredLabel])
			require.Len(t, provider.OwnerReferences, 1)
			assert.Equal(t, svc.Name, provider.OwnerReferences[0].Name)
			require.NotNil(t, provider.OwnerReferences[0].Controller)
			assert.True(t, *provider.OwnerReferences[0].Controller)
		})
	}
}

func TestDiscoverySkipsUnusableServices(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		svc  *corev1.Service
	}{
		{"no discovery annotation", annotatedService("prometheus", "ns", map[string]string{})},
		{"name matches nothing", annotatedService("my-api", "ns", nil, namedPort("http", 8080))},
		{"unknown explicit type", annotatedService("prometheus", "ns", map[string]string{DiscoverAnnotation: "true", TypeAnnotation: "datadog"}, namedPort("http", 9090))},
		{"invalid port annotation", annotatedService("prometheus", "ns", map[string]string{DiscoverAnnotation: "true", PortAnnotation: "not-a-port"}, namedPort("http", 9090))},
		{"out of range port annotation", annotatedService("prometheus", "ns", map[string]string{DiscoverAnnotation: "true", PortAnnotation: "70000"}, namedPort("http", 9090))},
		{"no ports at all", annotatedService("prometheus", "ns", nil)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, c := newReconciler(t, tc.svc)
			_, err := reconcile(ctx, t, r, tc.svc.Namespace, tc.svc.Name)
			require.NoError(t, err)
			_, getErr := getProvider(ctx, c, tc.svc.Namespace, tc.svc.Name)
			assert.True(t, apierrors.IsNotFound(getErr), "no provider should be created")
		})
	}
}

func TestDiscoveryRemovesProviderWhenAnnotationRemoved(t *testing.T) {
	ctx := context.Background()
	svc := annotatedService("prometheus", "ns", nil, namedPort("http-web", 9090))
	r, c := newReconciler(t, svc)
	_, err := reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)
	_, err = getProvider(ctx, c, svc.Namespace, svc.Name)
	require.NoError(t, err, "provider should exist after discovery")

	delete(svc.Annotations, DiscoverAnnotation)
	require.NoError(t, c.Update(ctx, svc))
	_, err = reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)
	_, getErr := getProvider(ctx, c, svc.Namespace, svc.Name)
	assert.True(t, apierrors.IsNotFound(getErr), "provider should be removed with the annotation")
}

func TestDiscoveryNeverDeletesOperatorOwnedProvider(t *testing.T) {
	ctx := context.Background()
	svc := annotatedService("prometheus", "ns", nil, namedPort("http-web", 9090))
	operatorProvider := &observabilityv1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "prometheus", Namespace: "ns"},
		Spec:       observabilityv1alpha1.ObservabilityProviderSpec{Type: "prometheus"},
	}
	r, c := newReconciler(t, svc, operatorProvider)

	delete(svc.Annotations, DiscoverAnnotation)
	require.NoError(t, c.Update(ctx, svc))
	_, err := reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)

	_, getErr := getProvider(ctx, c, "ns", "prometheus")
	assert.NoError(t, getErr, "operator-written provider must survive discovery removal")
}

func TestDiscoveryConvergesDriftedDiscoveredProvider(t *testing.T) {
	ctx := context.Background()
	svc := annotatedService("prometheus", "ns", nil, namedPort("http-web", 9090))
	r, c := newReconciler(t, svc)
	_, err := reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)

	// Change the Service port; the discovered provider must follow.
	svc.Spec.Ports = []corev1.ServicePort{namedPort("http-web", 9091)}
	require.NoError(t, c.Update(ctx, svc))
	_, err = reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)

	provider, err := getProvider(ctx, c, svc.Namespace, svc.Name)
	require.NoError(t, err)
	assert.JSONEq(t, `{"endpoint":"http://prometheus.ns.svc:9091"}`, string(provider.Spec.Config.Raw))
}

func TestDiscoveryLeavesDeOwnedProviderAlone(t *testing.T) {
	ctx := context.Background()
	svc := annotatedService("prometheus", "ns", nil, namedPort("http-web", 9090))
	r, c := newReconciler(t, svc)
	_, err := reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)

	provider, err := getProvider(ctx, c, svc.Namespace, svc.Name)
	require.NoError(t, err)
	delete(provider.Labels, discoveredLabel)
	require.NoError(t, c.Update(ctx, provider))

	svc.Spec.Ports = []corev1.ServicePort{namedPort("http-web", 9091)}
	require.NoError(t, c.Update(ctx, svc))
	_, err = reconcile(ctx, t, r, svc.Namespace, svc.Name)
	require.NoError(t, err)

	after, err := getProvider(ctx, c, svc.Namespace, svc.Name)
	require.NoError(t, err)
	assert.JSONEq(t, `{"endpoint":"http://prometheus.ns.svc:9090"}`, string(after.Spec.Config.Raw),
		"de-owned provider must not converge — the operator owns it now")
}

func TestDiscoveryIgnoresDeletedService(t *testing.T) {
	ctx := context.Background()
	r, _ := newReconciler(t)
	_, err := reconcile(ctx, t, r, "ns", "gone")
	require.NoError(t, err, "a deleted Service reconciles cleanly; ownerReference GC cleans the provider")
}
