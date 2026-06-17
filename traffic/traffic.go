package traffic

import (
	"context"
	"errors"
	"fmt"

	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/traffic/gatewayapi"
	"github.com/benebsworth/paprika/traffic/istio"
)

// ErrNotSupported indicates the traffic provider does not support an operation.
var ErrNotSupported = errors.New("traffic provider does not support this operation")

// Router manages traffic splitting between stable and canary backends.
//
//go:generate mockgen -destination=mocks/mock_traffic.go -package=mocks . Router
type Router interface {
	// SetWeight routes weight% to the canary and (100-weight)% to the stable backend.
	SetWeight(ctx context.Context, weight int32) error
	// RemoveCanary reverts to 100% stable and cleans up canary routing rules.
	RemoveCanary(ctx context.Context) error
	// SetHeaderRoute routes requests matching a header (or cookie) to a service.
	SetHeaderRoute(ctx context.Context, header, value, service string) error
	// RemoveHeaderRoute removes a previously configured header route.
	RemoveHeaderRoute(ctx context.Context, header string) error
	// SetMirror mirrors percent of traffic to the canary backend.
	SetMirror(ctx context.Context, percent int32) error
	// RemoveMirror removes traffic mirroring.
	RemoveMirror(ctx context.Context) error
	// Type returns the provider name ("istio" or "gateway-api").
	Type() string
}

// NewRouter creates a Router implementation based on the TrafficRouter config.
func NewRouter(cfg *paprikav1.TrafficRouter, client dynamic.Interface, stableSvc, canarySvc, ns string) (Router, error) {
	switch cfg.Provider {
	case "istio":
		if cfg.Istio == nil {
			return nil, errors.New("traffic router provider istio requires non-nil istio config")
		}
		return istio.NewRouter(cfg.Istio, client, stableSvc, canarySvc, ns), nil
	case "gateway-api":
		if cfg.GatewayAPI == nil {
			return nil, errors.New("traffic router provider gateway-api requires non-nil gateway-api config")
		}
		return gatewayapi.NewRouter(cfg.GatewayAPI, client, stableSvc, canarySvc, ns), nil
	default:
		return nil, fmt.Errorf("unsupported traffic router provider: %s", cfg.Provider)
	}
}
