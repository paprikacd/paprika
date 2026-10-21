package main

// This file is the control plane's side of the satellite relationship: the hub
// that holds live links and the mux that serves them. The satellite agent
// itself lives in main_satellite.go and shares none of this state.

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"github.com/redis/go-redis/v9"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/obsstore"
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

func satelliteMuxRegistrar(cfg *rest.Config, scheme *runtime.Scheme, hub *satellitecontrol.Hub, store obsstore.Store) (func(*http.ServeMux), error) {
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
	handler.Store = store
	_, linkHandler := v1connect.NewSatelliteLinkHandler(
		satellitecontrol.NewLinkServer(handler, hub),
		connect.WithReadMaxBytes(satellite.MaxReportBytes),
	)
	return func(mux *http.ServeMux) {
		mux.Handle(satellite.ReportPath, handler)
		mux.Handle(satellitecontrol.LinkPrefix, linkHandler)
	}, nil
}

// newObservationStore builds the configured observation provider.
//
// "kubernetes" (the default) returns nil: Cluster.status is the store, and the
// handler keeps writing only there. The Redis provider is the shared backing
// store that takes the observation list out of the status object once the fleet
// view reads from it.
func newObservationStore(cfg *cliConfig) (obsstore.Store, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.SatelliteObservationStore)) {
	case "", "kubernetes":
		return nil, nil
	case "memory":
		return obsstore.NewMemory(), nil
	case obsstore.RedisStoreName:
		if cfg.SatelliteRedisAddr == "" {
			return nil, errors.New("--satellite-observation-store=redis requires --satellite-redis-addr")
		}
		password, err := readComponentToken(cfg.SatelliteRedisPasswordFile)
		if err != nil {
			return nil, err
		}
		client := redis.NewClient(&redis.Options{
			Addr: cfg.SatelliteRedisAddr, Password: password, DB: cfg.SatelliteRedisDB,
		})
		return obsstore.NewRedis(client, "paprika:satellite"), nil
	default:
		return nil, fmt.Errorf("unknown --satellite-observation-store %q (want kubernetes, memory or redis)", cfg.SatelliteObservationStore)
	}
}
