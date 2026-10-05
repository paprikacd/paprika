package main

import (
	"encoding/json"
	"testing"

	"github.com/benebsworth/paprika/internal/arcobserver"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/manager"
)

type observerTestManager struct {
	manager.Manager
	added       manager.Runnable
	configReads int
}

func (m *observerTestManager) GetConfig() *rest.Config {
	m.configReads++
	return &rest.Config{Host: "https://kubernetes.invalid"}
}
func (m *observerTestManager) Add(r manager.Runnable) error { m.added = r; return nil }

func TestARCObserverRegistration_DisabledHasNoClientOrCredential(t *testing.T) {
	t.Setenv("PAPRIKA_ARC_OBSERVER_CONFIG", "")
	t.Setenv("PAPRIKA_ARC_OBSERVER_TOKEN_FILE", "")
	if err := setupARCObserver(nil); err != nil {
		t.Fatal(err)
	}
}

func TestARCObserverRegistration_ExistingManagerIdentityAndLeaderOnly(t *testing.T) {
	cfg := arcobserver.Config{Endpoint: "https://control.example", ProjectID: "project-a", Sources: []arcobserver.Source{{PoolName: "ci-pool", RunnerNamespace: "runners", SystemNamespace: "systems", ControllerDeployment: "controller", ExpectedMaxRunners: 1}}}
	raw, _ := json.Marshal(cfg)
	t.Setenv("PAPRIKA_ARC_OBSERVER_CONFIG", string(raw))
	// Registration must not open this file or contact either endpoint.
	t.Setenv("PAPRIKA_ARC_OBSERVER_TOKEN_FILE", "/nonexistent/mounted-observer-credential")
	m := &observerTestManager{}
	if err := setupARCObserver(m); err != nil {
		t.Fatal(err)
	}
	r, ok := m.added.(*arcobserver.Runner)
	if !ok || !r.NeedLeaderElection() || m.configReads != 1 || r.Config.ProjectID != "project-a" {
		t.Fatal("observer registration changed identity or leadership")
	}
	t.Setenv("PAPRIKA_ARC_OBSERVER_TOKEN_FILE", "")
	if err := setupARCObserver(nil); err == nil {
		t.Fatal("enabled observer accepted missing credential reference")
	}
}
