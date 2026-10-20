package main

// This file is the control plane's side of the satellite relationship: the hub
// that holds live links and the mux that serves them. The satellite agent
// itself lives in main_satellite.go and shares none of this state.

import (
	"fmt"
	"net/http"

	"connectrpc.com/connect"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/satellite"
	"github.com/benebsworth/paprika/internal/satellitecontrol"
)

// satelliteMuxRegistrar mounts both satellite transports: the pooled POST and
// the bidirectional link. hub is shared with the release controller so a task
// can be dispatched down the same connection that carries reports.
//
// Use an uncached client for credential rotation and the report sequence fence.
// Every API replica must read the latest resourceVersion before accepting a
// delta — a cached read could accept a report against a stale baseline.
// newInstrumentedHub builds the control-plane hub and publishes its link gauge.
// A hub is created once per process, so the gauge registers exactly once.
func newInstrumentedHub() *satellitecontrol.Hub {
	hub := satellitecontrol.NewHub()
	metrics.MustRegisterSatelliteLinkGauge(func() []metrics.SatelliteLinkState {
		keys := hub.ConnectedClusters()
		states := make([]metrics.SatelliteLinkState, 0, len(keys))
		for _, key := range keys {
			states = append(states, metrics.SatelliteLinkState{Namespace: key.Namespace, Name: key.Name})
		}
		return states
	})
	return hub
}

func satelliteMuxRegistrar(cfg *rest.Config, scheme *runtime.Scheme, hub *satellitecontrol.Hub) (func(*http.ServeMux), error) {
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create satellite registry client: %w", err)
	}
	if hub == nil {
		// This process owns the only hub it will ever create, so the link gauge
		// registers here. A caller that passes a hub registers it where it built
		// one, which keeps a second registration from resetting the series.
		hub = newInstrumentedHub()
	}
	handler := satellitecontrol.NewHandler(c)
	_, linkHandler := v1connect.NewSatelliteLinkHandler(
		satellitecontrol.NewLinkServer(handler, hub),
		connect.WithReadMaxBytes(satellite.MaxReportBytes),
	)
	return func(mux *http.ServeMux) {
		mux.Handle(satellite.ReportPath, handler)
		mux.Handle(satellitecontrol.LinkPrefix, linkHandler)
	}, nil
}
