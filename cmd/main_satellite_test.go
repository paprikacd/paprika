package main

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func TestSatelliteSubcommandConfiguration(t *testing.T) {
	var actual *cliConfig
	cmd, _, _ := newManagerCommand(func(_ context.Context, cfg *cliConfig) error { actual = cfg; return nil })
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"satellite", "--satellite-control-plane-url=https://central.example", "--satellite-cluster-name=east", "--satellite-cluster-namespace=tenants", "--satellite-token-file=/var/run/token", "--satellite-heartbeat-interval=15s", "--satellite-batch-interval=1s"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if actual.Mode != "satellite" || actual.SatelliteClusterName != "east" || actual.SatelliteClusterNamespace != "tenants" || actual.SatelliteControlPlaneURL != "https://central.example" || actual.SatelliteTokenFile != "/var/run/token" || actual.SatelliteHeartbeatInterval != 15*time.Second || actual.SatelliteBatchInterval != time.Second {
		t.Fatalf("configuration dropped: %+v", actual)
	}
}
