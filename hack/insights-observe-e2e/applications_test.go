package main

import (
	"os"
	"path/filepath"
	"testing"

	observev1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	corev1 "k8s.io/api/core/v1"
)

func TestApplicationFixtureAnonymousAndCredentialedProviders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.json")
	fixture := `[
		{"name":"anonymous","type":"prometheus","config":{},"credentials":""},
		{"name":"postgres","type":"postgresql","config":{},"credentials":{"password":"test-only"}},
		{"name":"missing","type":"tempo","config":{}}
	]`
	if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	objects, err := applicationFixtureObjects("http://localhost", path, false)
	if err != nil {
		t.Fatal(err)
	}
	providers := map[string]*observev1.ObservabilityProvider{}
	secrets := map[string]*corev1.Secret{}
	for _, object := range objects {
		switch object := object.(type) {
		case *observev1.ObservabilityProvider:
			providers[object.Name] = object
		case *corev1.Secret:
			secrets[object.Name] = object
		}
	}
	if providers["anonymous"] == nil || providers["anonymous"].Spec.CredentialsSecretRef != nil || secrets["anonymous-credentials"] != nil {
		t.Fatal("explicitly anonymous provider must not create a credentials reference or Secret")
	}
	for _, name := range []string{"shorted", "uptime", "postgres", "missing"} {
		provider := providers[name]
		secret := secrets[name+"-credentials"]
		if provider == nil || provider.Spec.CredentialsSecretRef == nil || provider.Spec.CredentialsSecretRef.Name != name+"-credentials" || secret == nil || secret.Labels[observev1.CredentialsSecretLabel] != "true" {
			t.Fatalf("provider %s must retain its labelled credential Secret reference", name)
		}
	}
	if string(secrets["postgres-credentials"].Data["credentials"]) != `{"password":"test-only"}` {
		t.Fatal("PostgreSQL credential document must be preserved")
	}
}
