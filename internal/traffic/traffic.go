package traffic

import (
	"context"
	"errors"
	"fmt"

	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/traffic/gatewayapi"
	"github.com/benebsworth/paprika/internal/traffic/istio"
)

// Traffic router provider identifiers.
const (
	ProviderIstio      = "istio"
	ProviderGatewayAPI = "gateway-api"
)

// ErrNotSupported indicates the traffic provider does not support an operation.
var ErrNotSupported = errors.New("traffic provider does not support this operation")

// WeightRouter manages stable/canary weight splitting.
type WeightRouter interface {
	SetWeight(ctx context.Context, weight int32) error
	RemoveCanary(ctx context.Context) error
}

// HeaderRouter manages header-based routing.
type HeaderRouter interface {
	SetHeaderRoute(ctx context.Context, header, value, service string) error
	RemoveHeaderRoute(ctx context.Context, header string) error
}

// MirrorRouter manages traffic mirroring.
type MirrorRouter interface {
	SetMirror(ctx context.Context, percent int32) error
	RemoveMirror(ctx context.Context) error
}

// Provider identifies a traffic router implementation.
type Provider interface {
	Type() string
}

// routerImpl is the union of the fine-grained traffic router roles. It is kept
// unexported so that callers depend on the smallest role interface practical
// instead of a single producer-side composed interface.
type routerImpl interface {
	WeightRouter
	HeaderRouter
	MirrorRouter
	Provider
}

// Router is a concrete traffic router that delegates to a provider-specific
// implementation. The exported methods are promoted from the embedded role
// interfaces, so consumers can define their own composed interfaces or depend
// on individual roles such as WeightRouter.
type Router struct {
	routerImpl
}

//go:generate mockgen -destination=mocks/mock_traffic.go -package=mocks -typed . WeightRouter,HeaderRouter,MirrorRouter,Provider

// NewRouter creates a Router implementation based on the TrafficRouter config.
func NewRouter(cfg *paprikav1.TrafficRouter, client dynamic.Interface, stableSvc, canarySvc, ns string) (*Router, error) {
	var impl routerImpl
	switch cfg.Provider {
	case ProviderIstio:
		if cfg.Istio == nil {
			return nil, errors.New("traffic router provider istio requires non-nil istio config")
		}
		impl = istio.NewRouter(cfg.Istio, client, stableSvc, canarySvc, ns)
	case ProviderGatewayAPI:
		if cfg.GatewayAPI == nil {
			return nil, errors.New("traffic router provider gateway-api requires non-nil gateway-api config")
		}
		impl = gatewayapi.NewRouter(cfg.GatewayAPI, client, stableSvc, canarySvc, ns)
	default:
		return nil, fmt.Errorf("unsupported traffic router provider: %s", cfg.Provider)
	}
	return &Router{routerImpl: impl}, nil
}
