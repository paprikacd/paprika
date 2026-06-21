// Package mtls provides env-var-gated TLS serving configuration for
// inter-service mTLS between split-plane components.
package mtls

import "os"

const (
	// EnabledEnv enables TLS serving when set to "true".
	EnabledEnv = "PAPRIKA_MTLS_ENABLED"
	// CertEnv is the path to the TLS certificate file.
	CertEnv = "PAPRIKA_TLS_CERT"
	// KeyEnv is the path to the TLS private key file.
	KeyEnv = "PAPRIKA_TLS_KEY"
)

// ServingConfig returns TLS cert/key paths when mTLS serving is enabled.
// It returns enabled=false when EnabledEnv is not "true" or either path is
// empty, so callers fall back to plaintext serving.
func ServingConfig() (cert, key string, enabled bool) {
	if os.Getenv(EnabledEnv) != "true" {
		return "", "", false
	}
	cert = os.Getenv(CertEnv)
	key = os.Getenv(KeyEnv)
	if cert == "" || key == "" {
		return "", "", false
	}
	return cert, key, true
}
