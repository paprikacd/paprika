package mtls

import (
	"testing"
)

func TestServingConfig(t *testing.T) {
	tests := []struct {
		name        string
		env         map[string]string
		wantCert    string
		wantKey     string
		wantEnabled bool
	}{
		{
			name:        "disabled when env unset",
			env:         nil,
			wantEnabled: false,
		},
		{
			name:        "disabled when not true",
			env:         map[string]string{EnabledEnv: "false"},
			wantEnabled: false,
		},
		{
			name:        "disabled when cert missing",
			env:         map[string]string{EnabledEnv: "true", KeyEnv: "/k"},
			wantEnabled: false,
		},
		{
			name:        "disabled when key missing",
			env:         map[string]string{EnabledEnv: "true", CertEnv: "/c"},
			wantEnabled: false,
		},
		{
			name:        "enabled with cert and key",
			env:         map[string]string{EnabledEnv: "true", CertEnv: "/etc/paprika/tls/tls.crt", KeyEnv: "/etc/paprika/tls/tls.key"},
			wantCert:    "/etc/paprika/tls/tls.crt",
			wantKey:     "/etc/paprika/tls/tls.key",
			wantEnabled: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for k := range enabledEnvKeys {
				t.Setenv(k, "")
			}
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			cert, key, enabled := ServingConfig()
			if enabled != tc.wantEnabled {
				t.Fatalf("enabled = %v, want %v", enabled, tc.wantEnabled)
			}
			if cert != tc.wantCert || key != tc.wantKey {
				t.Fatalf("cert=%q key=%q, want cert=%q key=%q", cert, key, tc.wantCert, tc.wantKey)
			}
		})
	}
}

var enabledEnvKeys = map[string]struct{}{EnabledEnv: {}, CertEnv: {}, KeyEnv: {}}
