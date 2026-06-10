package istio

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var virtualServiceGVR = schema.GroupVersionResource{
	Group:    "networking.istio.io",
	Version:  "v1beta1",
	Resource: "virtualservices",
}

type Router struct {
	client     dynamic.ResourceInterface
	stableSvc  string
	canarySvc  string
	config     *paprikav1.IstioRouterConfig
	vsResource dynamic.ResourceInterface
}

func NewRouter(cfg *paprikav1.IstioRouterConfig, client dynamic.Interface, stableSvc, canarySvc, ns string) *Router {
	return &Router{
		client:     client.Resource(virtualServiceGVR).Namespace(ns),
		stableSvc:  stableSvc,
		canarySvc:  canarySvc,
		config:     cfg,
		vsResource: client.Resource(virtualServiceGVR).Namespace(ns),
	}
}

func (r *Router) Type() string { return "istio" }

func (r *Router) SetWeight(ctx context.Context, weight int32) error {
	vsName, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "set-weight")
	if err != nil {
		return err
	}

	routesToPatch := r.selectRoutes(httpRoutes)
	if len(routesToPatch) == 0 {
		return fmt.Errorf("no matching HTTP routes found in VirtualService %s", vsName)
	}

	patched := r.patchHTTPRoutes(httpRoutes, routesToPatch, weight)
	if !patched {
		return fmt.Errorf("no destinations matched stable service %q or canary service %q in VirtualService %s",
			r.stableSvc, r.canarySvc, vsName)
	}

	return r.updateVirtualService(ctx, vs, httpRoutes, "set-weight")
}

func (r *Router) RemoveCanary(ctx context.Context) error {
	_, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "remove-canary")
	if err != nil {
		return err
	}
	if httpRoutes == nil {
		return nil
	}

	routesToPatch := r.selectRoutes(httpRoutes)
	for _, routeIdx := range routesToPatch {
		route, ok := httpRoutes[routeIdx].(map[string]any)
		if !ok {
			continue
		}
		destinations, ok := route["route"].([]any)
		if !ok {
			continue
		}
		var keep []any
		for _, dest := range destinations {
			d, ok := dest.(map[string]any)
			if !ok {
				keep = append(keep, dest)
				continue
			}
			host, _, _ := unstructured.NestedString(d, "destination", "host")
			if strings.HasPrefix(host, r.canarySvc+".") || host == r.canarySvc {
				continue
			}
			d["weight"] = float64(100)
			keep = append(keep, d)
		}
		route["route"] = keep
		httpRoutes[routeIdx] = route
	}

	return r.updateVirtualService(ctx, vs, httpRoutes, "remove-canary")
}

func (r *Router) getVSWithRoutes(ctx context.Context, _ string) (string, *unstructured.Unstructured, []any, error) { //nolint:gocritic // bare returns on named results would shadow err
	vsName := r.config.VirtualService
	if vsName == "" {
		vsName = servicePrefix(r.stableSvc) + "-vs"
	}

	vs, err := r.vsResource.Get(ctx, vsName, metav1.GetOptions{})
	if err != nil {
		return "", nil, nil, fmt.Errorf("failed to get VirtualService %s: %w", vsName, err)
	}

	httpRoutes, found, _ := unstructured.NestedSlice(vs.Object, "spec", "http")
	if !found {
		return vsName, vs, nil, nil
	}
	return vsName, vs, httpRoutes, nil
}

func (r *Router) patchHTTPRoutes(httpRoutes []any, routesToPatch []int, weight int32) bool {
	patched := false
	for _, routeIdx := range routesToPatch {
		route, ok := httpRoutes[routeIdx].(map[string]any)
		if !ok {
			continue
		}
		destinations, ok := route["route"].([]any)
		if !ok {
			continue
		}
		if modified := r.patchDestinations(destinations, weight); modified {
			route["route"] = destinations
			httpRoutes[routeIdx] = route
			patched = true
		}
	}
	return patched
}

func (r *Router) updateVirtualService(ctx context.Context, vs *unstructured.Unstructured, httpRoutes []any, _ string) error {
	vsName := vs.GetName()
	if httpRoutes != nil {
		if err := unstructured.SetNestedSlice(vs.Object, httpRoutes, "spec", "http"); err != nil {
			return fmt.Errorf("failed to set routes on VirtualService %s: %w", vsName, err)
		}
	}
	_, err := r.vsResource.Update(ctx, vs, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update VirtualService %s: %w", vsName, err)
	}
	return nil
}

func (r *Router) selectRoutes(httpRoutes []any) []int {
	if len(r.config.Routes) > 0 {
		var indices []int
		for idx, route := range httpRoutes {
			routeMap, ok := route.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(routeMap, "name")
			for _, target := range r.config.Routes {
				if name == target {
					indices = append(indices, idx)
				}
			}
		}
		return indices
	}
	if len(httpRoutes) == 1 {
		return []int{0}
	}
	for idx, route := range httpRoutes {
		routeMap, ok := route.(map[string]any)
		if !ok {
			continue
		}
		if _, found, _ := unstructured.NestedString(routeMap, "name"); !found {
			return []int{idx}
		}
	}
	return nil
}

func (r *Router) patchDestinations(destinations []any, weight int32) bool {
	modified := false
	for _, dest := range destinations {
		d, ok := dest.(map[string]any)
		if !ok {
			continue
		}
		host, _, _ := unstructured.NestedString(d, "destination", "host")
		var newWeight float64
		isCanary := strings.HasPrefix(host, r.canarySvc+".") || host == r.canarySvc
		isStable := strings.HasPrefix(host, r.stableSvc+".") || host == r.stableSvc
		switch {
		case isCanary:
			newWeight = float64(weight)
		case isStable:
			newWeight = float64(100 - weight)
		default:
			continue
		}
		d["weight"] = newWeight
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
