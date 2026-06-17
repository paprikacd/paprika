package gatewayapi

import (
	"context"
	"errors"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// errNotSupported indicates the provider does not support header or mirror operations.
var errNotSupported = errors.New("traffic provider does not support this operation")

var httpRouteGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "httproutes",
}

type Router struct {
	client    dynamic.ResourceInterface
	stableSvc string
	canarySvc string
	config    *paprikav1.GatewayAPIRouterConfig
}

func NewRouter(cfg *paprikav1.GatewayAPIRouterConfig, client dynamic.Interface, stableSvc, canarySvc, ns string) *Router {
	return &Router{
		client:    client.Resource(httpRouteGVR).Namespace(ns),
		stableSvc: stableSvc,
		canarySvc: canarySvc,
		config:    cfg,
	}
}

func (r *Router) Type() string { return "gateway-api" }

func (r *Router) SetHeaderRoute(ctx context.Context, header, value, service string) error {
	return fmt.Errorf("gateway-api header routing: %w", errNotSupported)
}

func (r *Router) RemoveHeaderRoute(ctx context.Context, header string) error {
	return fmt.Errorf("gateway-api header routing: %w", errNotSupported)
}

func (r *Router) SetMirror(ctx context.Context, percent int32) error {
	return fmt.Errorf("gateway-api traffic mirroring: %w", errNotSupported)
}

func (r *Router) RemoveMirror(ctx context.Context) error {
	return fmt.Errorf("gateway-api traffic mirroring: %w", errNotSupported)
}

func (r *Router) SetWeight(ctx context.Context, weight int32) error {
	routeName, hr, rules, err := r.getHTTPRouteWithRules(ctx)
	if err != nil {
		return err
	}
	if rules == nil {
		return fmt.Errorf("HTTPRoute %s has no rules", routeName)
	}

	patched := false
	for _, rule := range rules {
		ruleMap, ok := rule.(map[string]any)
		if !ok {
			continue
		}
		backends, ok := ruleMap["backendRefs"].([]any)
		if !ok {
			continue
		}
		if modified := r.patchBackends(backends, weight); modified {
			ruleMap["backendRefs"] = backends
			patched = true
		}
	}

	if !patched {
		return fmt.Errorf("no backendRefs matched stable service %q or canary service %q in HTTPRoute %s",
			r.stableSvc, r.canarySvc, routeName)
	}

	return r.updateHTTPRoute(ctx, hr, rules)
}

func (r *Router) RemoveCanary(ctx context.Context) error {
	_, hr, rules, err := r.getHTTPRouteWithRules(ctx)
	if err != nil {
		return err
	}
	if rules == nil {
		return nil
	}

	for _, rule := range rules {
		ruleMap, ok := rule.(map[string]any)
		if !ok {
			continue
		}
		backends, ok := ruleMap["backendRefs"].([]any)
		if !ok {
			continue
		}
		var keep []any
		for _, be := range backends {
			b, ok := be.(map[string]any)
			if !ok {
				keep = append(keep, be)
				continue
			}
			name, _, _ := unstructured.NestedString(b, "name")
			if name == r.canarySvc {
				continue
			}
			if name == r.stableSvc {
				b["weight"] = float64(100)
			}
			keep = append(keep, b)
		}
		ruleMap["backendRefs"] = keep
	}

	return r.updateHTTPRoute(ctx, hr, rules)
}

func (r *Router) getHTTPRouteWithRules(ctx context.Context) (string, *unstructured.Unstructured, []any, error) { //nolint:gocritic // bare returns on named results would shadow err
	routeName := r.config.HTTPRoute
	if routeName == "" {
		routeName = servicePrefix(r.stableSvc) + "-httproute"
	}

	hr, err := r.client.Get(ctx, routeName, metav1.GetOptions{})
	if err != nil {
		return "", nil, nil, fmt.Errorf("failed to get HTTPRoute %s: %w", routeName, err)
	}

	rules, found, _ := unstructured.NestedSlice(hr.Object, "spec", "rules")
	if !found || len(rules) == 0 {
		return routeName, hr, nil, nil
	}
	return routeName, hr, rules, nil
}

func (r *Router) updateHTTPRoute(ctx context.Context, hr *unstructured.Unstructured, rules []any) error {
	routeName := hr.GetName()
	if rules != nil {
		if err := unstructured.SetNestedSlice(hr.Object, rules, "spec", "rules"); err != nil {
			return fmt.Errorf("failed to set rules on HTTPRoute %s: %w", routeName, err)
		}
	}
	_, err := r.client.Update(ctx, hr, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update HTTPRoute %s: %w", routeName, err)
	}
	return nil
}

func (r *Router) patchBackends(backends []any, weight int32) bool {
	modified := false
	for _, be := range backends {
		b, ok := be.(map[string]any)
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(b, "name")
		var newWeight float64
		switch name {
		case r.canarySvc:
			newWeight = float64(weight)
		case r.stableSvc:
			newWeight = float64(100 - weight)
		default:
			continue
		}
		b["weight"] = newWeight
		modified = true
	}
	return modified
}

func servicePrefix(svc string) string {
	if idx := strings.Index(svc, "-stable"); idx > 0 {
		return svc[:idx]
	}
	if idx := strings.Index(svc, "-canary"); idx > 0 {
		return svc[:idx]
	}
	return svc
}
