// Package observabilitygateway is the wiring layer for the observability
// connector framework: it resolves a configured provider type to a concrete
// connector.Connector. It lives above connector and the per-backend
// subpackages because those subpackages import connector for the shared
// types — wiring them here keeps the dependency arrow one-way.
package observabilitygateway

import (
	"fmt"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscloudtrail"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscloudwatchlogs"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscloudwatchmetrics"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awsxray"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcloudlogging"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcloudmonitoring"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcloudtrace"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/loki"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/mock"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/otlp"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/postgresql"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/prometheus"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/shorted"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/tempo"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/uptime"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/vultrmonitoring"
)

// New builds the Connector for a resolved provider type. An unknown type is
// a caller bug and reported as such; backend reachability and credential
// problems belong to Query so they surface as query results rather than
// construction failures.
func New(providerType string) (connector.Connector, error) {
	constructor, ok := connectors[providerType]
	if !ok {
		return nil, fmt.Errorf("unknown observability provider %q", providerType)
	}
	return constructor(), nil
}

// connectors maps each provider type to its constructor. The map — rather
// than a switch — keeps New a lookup even as the provider set grows; the
// connector subpackages import connector for the shared types, so the
// wiring lives here to keep the dependency arrow one-way.
var connectors = map[string]func() connector.Connector{
	connector.ProviderPrometheus:           prometheus.New,
	connector.ProviderLoki:                 loki.New,
	connector.ProviderTempo:                tempo.New,
	connector.ProviderOTLP:                 otlp.New,
	connector.ProviderShorted:              shorted.New,
	connector.ProviderUptime:               uptime.New,
	connector.ProviderPostgreSQL:           postgresql.New,
	connector.ProviderGCPCloudLogging:      gcpcloudlogging.New,
	connector.ProviderGCPCloudMonitoring:   gcpcloudmonitoring.New,
	connector.ProviderGCPCloudTrace:        gcpcloudtrace.New,
	connector.ProviderAWSCloudWatchLogs:    awscloudwatchlogs.New,
	connector.ProviderAWSCloudWatchMetrics: awscloudwatchmetrics.New,
	connector.ProviderAWSXRay:              awsxray.New,
	connector.ProviderAWSCloudTrail:        awscloudtrail.New,
	connector.ProviderVultrMonitoring:      vultrmonitoring.New,
	connector.ProviderMock:                 mock.New,
}
