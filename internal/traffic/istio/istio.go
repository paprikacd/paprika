package istio

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

const (
	ProviderIstio      = "istio"
	ProviderGatewayAPI = "gateway-api"
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

func (r *Router) Type() string { return ProviderIstio }

func (r *Router) SetHeaderRoute(ctx context.Context, header, value, service string) error {
	vsName, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "set-header-route")
	if err != nil {
		return fmt.Errorf("set header route: %w", err)
	}
	if httpRoutes == nil {
		return fmt.Errorf("virtual service %s has no HTTP routes", vsName)
	}

	routesToPatch := r.selectRoutes(httpRoutes)
	if len(routesToPatch) == 0 {
		return fmt.Errorf("no matching HTTP routes found in VirtualService %s", vsName)
	}

	for _, routeIdx := range routesToPatch {
		headerRoute := map[string]any{
			"match": []any{
				map[string]any{
					"headers": map[string]any{
						header: map[string]any{"exact": value},
					},
				},
			},
			"route": []any{
				map[string]any{
					"destination": map[string]any{"host": service},
					"weight":      float64(100),
				},
			},
		}
		httpRoutes = append(httpRoutes[:routeIdx], append([]any{headerRoute}, httpRoutes[routeIdx:]...)...)
		for i := range routesToPatch {
			if routesToPatch[i] > routeIdx {
				routesToPatch[i]++
			}
		}
	}

	return r.updateVirtualService(ctx, vs, httpRoutes, "set-header-route")
}

//nolint:cyclop // route filtering has several small branches.
func (r *Router) RemoveHeaderRoute(ctx context.Context, header string) error {
	_, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "remove-header-route")
	if err != nil {
		return fmt.Errorf("remove header route: %w", err)
	}
	if httpRoutes == nil {
		return nil
	}

	var keep []any
	for _, route := range httpRoutes {
		routeMap, ok := route.(map[string]any)
		if !ok {
			keep = append(keep, route)
			continue
		}
		matches, found, err := unstructured.NestedSlice(routeMap, "match")
		if err != nil {
			return fmt.Errorf("failed to read matches from route: %w", err)
		}
		if !found {
			keep = append(keep, route)
			continue
		}
		hasHeader := false
		for _, m := range matches {
			matchMap, ok := m.(map[string]any)
			if !ok {
				continue
			}
			_, found, err := unstructured.NestedMap(matchMap, "headers", header)
			if err != nil {
				return fmt.Errorf("failed to read headers from match: %w", err)
			}
			if found {
				hasHeader = true
				break
			}
		}
		if !hasHeader {
			keep = append(keep, route)
		}
	}

	return r.updateVirtualService(ctx, vs, keep, "remove-header-route")
}

func (r *Router) SetMirror(ctx context.Context, percent int32) error {
	_, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "set-mirror")
	if err != nil {
		return fmt.Errorf("set mirror: %w", err)
	}
	if httpRoutes == nil {
		return errors.New("virtual service has no HTTP routes")
	}

	routesToPatch := r.selectRoutes(httpRoutes)
	for _, routeIdx := range routesToPatch {
		route, ok := httpRoutes[routeIdx].(map[string]any)
		if !ok {
			continue
		}
		route["mirror"] = map[string]any{
			"host": r.canarySvc,
			"port": map[string]any{"number": float64(80)},
		}
		route["mirrorPercentage"] = map[string]any{"value": float64(percent)}
		httpRoutes[routeIdx] = route
	}

	return r.updateVirtualService(ctx, vs, httpRoutes, "set-mirror")
}

func (r *Router) RemoveMirror(ctx context.Context) error {
	_, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "remove-mirror")
	if err != nil {
		return fmt.Errorf("remove mirror: %w", err)
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
		delete(route, "mirror")
		delete(route, "mirrorPercentage")
		httpRoutes[routeIdx] = route
	}

	return r.updateVirtualService(ctx, vs, httpRoutes, "remove-mirror")
}

func (r *Router) SetWeight(ctx context.Context, weight int32) error {
	vsName, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "set-weight")
	if err != nil {
		return fmt.Errorf("set weight: %w", err)
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

//nolint:cyclop // canary removal has several small branches.
func (r *Router) RemoveCanary(ctx context.Context) error {
	_, vs, httpRoutes, err := r.getVSWithRoutes(ctx, "remove-canary")
	if err != nil {
		return fmt.Errorf("remove canary: %w", err)
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
			host, _, err := unstructured.NestedString(d, "destination", "host")
			if err != nil {
				return fmt.Errorf("failed to read destination host: %w", err)
			}
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

	httpRoutes, found, err := unstructured.NestedSlice(vs.Object, "spec", "http")
	if err != nil {
		return "", nil, nil, fmt.Errorf("failed to read http routes from VirtualService %s: %w", vsName, err)
	}
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

//nolint:cyclop // route selection has several small branches.
func (r *Router) selectRoutes(httpRoutes []any) []int {
	if len(r.config.Routes) > 0 {
		var indices []int
		for idx, route := range httpRoutes {
			routeMap, ok := route.(map[string]any)
			if !ok {
				continue
			}
			name, _, err := unstructured.NestedString(routeMap, "name")
			if err != nil {
				continue
			}
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
		_, found, err := unstructured.NestedString(routeMap, "name")
		if err != nil || !found {
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
		host, _, err := unstructured.NestedString(d, "destination", "host")
		if err != nil {
			continue
		}
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
