/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type fakeHealthClient struct {
	v1connect.PaprikaServiceClient
	request  *paprikav1.GetSystemHealthRequest
	response *paprikav1.GetSystemHealthResponse
	err      error
	calls    int
}

func (f *fakeHealthClient) GetSystemHealth(
	_ context.Context,
	request *connect.Request[paprikav1.GetSystemHealthRequest],
) (*connect.Response[paprikav1.GetSystemHealthResponse], error) {
	f.calls++
	f.request = request.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.response), nil
}

func TestHealthDefaultsAndRendersEvidence(t *testing.T) {
	client := &fakeHealthClient{response: healthFixture("degraded")}
	output := outputTable
	cmd := newHealthCmd(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		return client, nil
	}, &output)
	var out bytes.Buffer
	cmd.SetOut(&out)

	if flag := cmd.Flags().Lookup("stuck-release-seconds"); flag == nil || flag.DefValue != "1800" {
		t.Fatalf("--stuck-release-seconds default = %v, want 1800", flag)
	}
	if err := cmd.Execute(); err != nil {
		t.Fatalf("health command returned error: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("RPC calls = %d, want 1", client.calls)
	}
	if client.request.GetStuckReleaseSeconds() != 1800 {
		t.Fatalf("default request seconds = %d, want 1800", client.request.GetStuckReleaseSeconds())
	}

	rendered := out.String()
	for _, want := range []string{
		"STATUS", "DEGRADED", "SERVER", "v0.4.1", "APPLICATIONS", "CONTROLLER",
		"CHECKS", "STALE APPLICATIONS", "tenant/checkout", "STUCK RELEASES", "tenant/checkout-release",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("health output missing %q:\n%s", want, rendered)
		}
	}
}

func TestHealthFailsOnFailedStatus(t *testing.T) {
	client := &fakeHealthClient{response: healthFixture("failed")}
	output := outputTable
	cmd := newHealthCmd(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		return client, nil
	}, &output)
	cmd.SetOut(&bytes.Buffer{})

	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("health error = %v, want a failed-status error", err)
	}
}

func TestHealthFailOnDegradedIsOptIn(t *testing.T) {
	client := &fakeHealthClient{response: healthFixture("degraded")}
	output := outputTable
	cmd := newHealthCmd(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		return client, nil
	}, &output)
	cmd.SetOut(&bytes.Buffer{})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("degraded health without strict flag returned error: %v", err)
	}

	cmd = newHealthCmd(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		return client, nil
	}, &output)
	cmd.SetOut(&bytes.Buffer{})
	if err := cmd.Flags().Set("fail-on-degraded", "true"); err != nil {
		t.Fatal(err)
	}
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "degraded") {
		t.Fatalf("strict health error = %v, want a degraded-status error", err)
	}
}

func TestHealthRejectsOutOfRangeStuckReleaseSeconds(t *testing.T) {
	client := &fakeHealthClient{response: healthFixture("healthy")}
	output := outputTable
	cmd := newHealthCmd(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		return client, nil
	}, &output)
	cmd.SetOut(&bytes.Buffer{})
	if err := cmd.Flags().Set("stuck-release-seconds", "30"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "between 60 and 86400") {
		t.Fatalf("health error = %v, want a stuck-release-seconds range error", err)
	}
	if client.calls != 0 {
		t.Fatalf("RPC calls = %d, want 0 for a rejected request", client.calls)
	}
}

func healthFixture(status string) *paprikav1.GetSystemHealthResponse {
	return &paprikav1.GetSystemHealthResponse{
		Status:                              status,
		ServerVersion:                       "v0.4.1",
		ServerGitCommit:                     "b984a8468fbe6146e4d37ac24ebf4b3c848b30bd",
		ServerBuildDate:                     "2026-10-22T04:10:51Z",
		ApplicationsTotal:                   25,
		ApplicationsHealthy:                 23,
		ApplicationsProgressing:             1,
		ApplicationsDegraded:                1,
		ApplicationsStale:                   1,
		ApplicationsReleaseRetriesExhausted: 1,
		ReleasesStuck:                       1,
		StaleApplications: []*paprikav1.StaleApplication{{
			Application:        &paprikav1.FleetObjectKey{Namespace: "tenant", Name: "checkout"},
			Generation:         3,
			ObservedGeneration: 2,
			LagGenerations:     1,
		}},
		StuckReleases: []*paprikav1.StuckRelease{{
			Release:    &paprikav1.FleetObjectKey{Namespace: "tenant", Name: "checkout-release"},
			Phase:      "Canarying",
			AgeSeconds: 3600,
		}},
		Controller: &paprikav1.ControllerHealth{
			Present: true, DesiredReplicas: 1, ReadyReplicas: 1, AvailableReplicas: 1, Ready: true,
		},
		Checks: []*paprikav1.SystemHealthCheck{
			{Name: "server", Status: "pass", Message: "v0.4.1"},
			{Name: "application_reconcile", Status: "warn", Message: "1 application behind"},
		},
	}
}
