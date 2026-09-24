package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// OperationalLink is an operator-configured destination, never a fetched URL.
type OperationalLink struct {
	// +kubebuilder:validation:Enum=dashboard;logs;traces;runbook;cost;repository;custom
	Kind string `json:"kind"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=100
	Label string `json:"label"`
	// +kubebuilder:validation:Pattern=`^https?://`
	// +kubebuilder:validation:MaxLength=2048
	URL string `json:"url"`
}

// OperationalValue is public application metadata, not a place for credentials.
// +kubebuilder:validation:MaxLength=256
type OperationalValue string

// ApplicationOperations supplies the application's operational context.
type ApplicationOperations struct {
	// +optional
	// +kubebuilder:validation:MaxLength=128
	Owner string `json:"owner,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxLength=128
	OwnerLabel string `json:"ownerLabel,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxLength=128
	OnCall string `json:"onCall,omitempty"`
	// +optional
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=4
	Tier int32 `json:"tier,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxItems=20
	Links []OperationalLink `json:"links,omitempty"`
	// Metadata is displayed verbatim; it must not contain secrets.
	// +optional
	// +kubebuilder:validation:MaxProperties=16
	Metadata map[string]OperationalValue `json:"metadata,omitempty"`
}

// AvailabilitySLO measures scheduled HTTP probe observations. Missed or invalid
// observations remain unknown, and never count as successful uptime.
type AvailabilitySLO struct {
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=99.9999
	TargetPercentage float64 `json:"targetPercentage"`
	// +kubebuilder:validation:Enum="1h";"24h";"7d";"30d"
	Window string `json:"window"`
}

// SLOHistory is a bounded, durable ring of scheduled observations. Two bits per
// interval encode missed (0), healthy (1), unhealthy (2), or invalid (3). At the
// minimum 10-second interval, a 30-day ring uses 64,800 bytes (86,400 in JSON).
// It survives controller restarts and does not require an external metrics DB.
type SLOHistory struct {
	ConfigurationHash string      `json:"configurationHash"`
	FirstObservedAt   metav1.Time `json:"firstObservedAt"`
	LastSlot          int64       `json:"lastSlot"`
	// +kubebuilder:validation:MaxLength=86400
	Samples []byte `json:"samples"`
}
