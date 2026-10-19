// Package satellite collects a cluster's operational state and reports compact
// application deltas to the Paprika control plane. Credentials, manifests and
// arbitrary Kubernetes labels never enter the reporting protocol.
package satellite

import (
	"time"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

const (
	ProtocolVersion = 1
	ReportPath      = "/api/satellite/report"
	// MaxReportBytes bounds the uncompressed JSON accepted by the control plane.
	MaxReportBytes  = 1 << 20
	MaxApplications = 2000
)

// Application is an observed application instance within one cluster. Identity
// optionally overrides its logical name within Namespace. It never changes the
// namespace boundary, so equal names in separate namespaces remain separate.
type Application struct {
	Namespace      string `json:"namespace"`
	Name           string `json:"name"`
	Identity       string `json:"identity,omitempty"`
	Project        string `json:"project,omitempty"`
	Health         string `json:"health,omitempty"`
	Phase          string `json:"phase,omitempty"`
	OutOfSync      uint32 `json:"outOfSync,omitempty"`
	SyncKnown      bool   `json:"syncKnown,omitempty"`
	ResourceCount  uint32 `json:"resourceCount,omitempty"`
	SourceRevision string `json:"sourceRevision,omitempty"`
}

// Key identifies the observed instance for replacement/deletion. Logical
// Identity is deliberately excluded because changing it must replace one
// instance rather than leave an orphaned logical application behind.
func (a *Application) Key() string { return a.Namespace + "/" + a.Name }

// Report carries an atomic initial snapshot followed by monotonically ordered
// application deltas. Inventory is a full aggregate on every report. A new
// session starts with Sequence=1 and Snapshot=true; retries send exactly the
// same session/sequence/body, so delivery may be acknowledged idempotently.
type Report struct {
	ProtocolVersion     int                               `json:"protocolVersion"`
	ClusterNamespace    string                            `json:"clusterNamespace"`
	ClusterName         string                            `json:"clusterName"`
	ClusterUID          string                            `json:"clusterUid"`
	DisplayName         string                            `json:"displayName,omitempty"`
	SessionID           string                            `json:"sessionId"`
	Sequence            uint64                            `json:"sequence"`
	Snapshot            bool                              `json:"snapshot"`
	ObservedAt          time.Time                         `json:"observedAt"`
	Version             string                            `json:"version,omitempty"`
	KubernetesVersion   string                            `json:"kubernetesVersion,omitempty"`
	Inventory           clustersv1alpha1.ClusterInventory `json:"inventory"`
	Applications        []Application                     `json:"applications,omitempty"`
	DeletedApplications []string                          `json:"deletedApplications,omitempty"`
}

// Config is the satellite's outbound connection and batching configuration.
// TokenFile is read for every report so a mounted Secret can rotate in place.
type Config struct {
	ControlPlaneURL   string
	ClusterName       string
	ClusterNamespace  string
	DisplayName       string
	TokenFile         string
	CAFile            string
	HeartbeatInterval time.Duration
	BatchInterval     time.Duration
}
