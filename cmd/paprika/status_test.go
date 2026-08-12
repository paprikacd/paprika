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
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"sigs.k8s.io/yaml"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type fakeStatusClient struct {
	v1connect.PaprikaServiceClient
	request  *paprikav1.GetSystemStatusRequest
	response *paprikav1.GetSystemStatusResponse
	err      error
	deadline time.Duration
	calls    int
}

func (f *fakeStatusClient) GetSystemStatus(ctx context.Context, request *connect.Request[paprikav1.GetSystemStatusRequest]) (*connect.Response[paprikav1.GetSystemStatusResponse], error) {
	f.calls++
	f.request = request.Msg
	if deadline, ok := ctx.Deadline(); ok {
		f.deadline = time.Until(deadline)
	}
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.response), nil
}

func TestStatusPropagatesNamespaceDefaultLimitAndDeadline(t *testing.T) {
	client := &fakeStatusClient{response: &paprikav1.GetSystemStatusResponse{}}
	clientCreations := 0
	output := outputTable
	cmd := newStatusCmdWithClock(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		clientCreations++
		return client, nil
	}, func() string { return "payments" }, &output, time.Now)
	cmd.SetOut(&bytes.Buffer{})

	flag := cmd.Flags().Lookup("attention-limit")
	if flag == nil {
		t.Fatal("--attention-limit flag is not declared")
	}
	if got, want := flag.DefValue, "20"; got != want {
		t.Fatalf("--attention-limit default = %q, want %q", got, want)
	}
	if err := cmd.Execute(); err != nil {
		t.Fatalf("status command returned error: %v", err)
	}

	if clientCreations != 1 || client.calls != 1 {
		t.Fatalf("client creations/RPC calls = %d/%d, want 1/1", clientCreations, client.calls)
	}
	if got := client.request.GetNamespace(); got != "payments" {
		t.Errorf("request namespace = %q, want payments", got)
	}
	if client.request.Namespace == nil {
		t.Error("request namespace is nil, want configured namespace")
	}
	if got := client.request.GetAttentionLimit(); got != 20 {
		t.Errorf("request attention limit = %d, want 20", got)
	}
	if client.deadline < 14*time.Second || client.deadline > 15*time.Second {
		t.Errorf("RPC deadline remaining = %s, want approximately 15s", client.deadline)
	}
}

func TestStatusAttentionLimitSemantics(t *testing.T) {
	tests := []struct {
		name string
		arg  string
		want uint32
	}{
		{name: "explicit server default", arg: "0", want: 0},
		{name: "minimum", arg: "1", want: 1},
		{name: "maximum", arg: "100", want: 100},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeStatusClient{response: &paprikav1.GetSystemStatusResponse{}}
			output := outputTable
			cmd := newStatusCmdWithClock(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
				return client, nil
			}, func() string { return "" }, &output, time.Now)
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetArgs([]string{"--attention-limit=" + test.arg})

			if err := cmd.Execute(); err != nil {
				t.Fatalf("status command returned error: %v", err)
			}
			if got := client.request.GetAttentionLimit(); got != test.want {
				t.Errorf("request attention limit = %d, want %d", got, test.want)
			}
		})
	}
}

func TestStatusRejectsAttentionLimitAboveMaximumBeforeCreatingClient(t *testing.T) {
	clientCreations := 0
	output := outputTable
	cmd := newStatusCmdWithClock(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		clientCreations++
		return &fakeStatusClient{}, nil
	}, func() string { return "" }, &output, time.Now)
	cmd.SetArgs([]string{"--attention-limit=101"})

	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "must not exceed 100") {
		t.Fatalf("status error = %v, want local maximum guidance", err)
	}
	if clientCreations != 0 {
		t.Fatalf("client was created %d times, want 0", clientCreations)
	}
}

func TestStatusTableOutput(t *testing.T) {
	now := time.Date(2026, time.August, 12, 12, 0, 0, 0, time.UTC)
	client := &fakeStatusClient{response: statusResponseFixture(now)}
	output := outputTable
	cmd := newStatusCmdWithClock(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
		return client, nil
	}, func() string { return "" }, &output, func() time.Time { return now })
	var stdout bytes.Buffer
	cmd.SetOut(&stdout)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("status command returned error: %v", err)
	}
	want := "" +
		"APPLICATIONS  HEALTHY  PROGRESSING  DEGRADED  FAILED  OUT-OF-SYNC  ATTENTION\n" +
		"12            9        1            1         1       2            3\n" +
		"\n" +
		"ATTENTION\n" +
		"NAMESPACE  APPLICATION  PROJECT  HEALTH    SYNC       RELEASE   UPDATED\n" +
		"apps       checkout     default  Failed    OutOfSync  Failed    4m ago\n" +
		"apps       payments     default  Degraded  Synced     Complete  8m ago\n"
	if got := stdout.String(); got != want {
		t.Fatalf("status table output mismatch\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestStatusStructuredOutputUsesProtobufShape(t *testing.T) {
	now := time.Date(2026, time.August, 12, 12, 0, 0, 0, time.UTC)
	for _, format := range []string{outputJSON, outputYAML} {
		t.Run(format, func(t *testing.T) {
			client := &fakeStatusClient{response: statusResponseFixture(now)}
			output := format
			cmd := newStatusCmdWithClock(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
				return client, nil
			}, func() string { return "" }, &output, func() time.Time { return now })
			var stdout bytes.Buffer
			cmd.SetOut(&stdout)

			if err := cmd.Execute(); err != nil {
				t.Fatalf("status command returned error: %v", err)
			}
			encoded := stdout.Bytes()
			if format == outputYAML {
				var err error
				encoded, err = yaml.YAMLToJSON(encoded)
				if err != nil {
					t.Fatalf("convert output YAML to JSON: %v", err)
				}
			}
			var got map[string]any
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatalf("decode structured output: %v", err)
			}
			if got["total"] != "12" || got["attentionTotal"] != "3" {
				t.Fatalf("structured totals = %#v, want protobuf JSON fields", got)
			}
			attention, ok := got["attention"].([]any)
			if !ok || len(attention) != 2 {
				t.Fatalf("structured attention = %#v, want two records", got["attention"])
			}
		})
	}
}

func TestStatusRPCErrorGuidance(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		want      []string
		doNotWant []string
	}{
		{
			name:      "unauthenticated",
			err:       connect.NewError(connect.CodeUnauthenticated, errors.New("expired")),
			want:      []string{"paprika login"},
			doNotWant: []string{"token", "config"},
		},
		{
			name: "unavailable",
			err:  connect.NewError(connect.CodeUnavailable, errors.New("starting")),
			want: []string{"warming up", "unavailable", "retry"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeStatusClient{err: test.err}
			output := outputTable
			cmd := newStatusCmdWithClock(context.Background(), func() (v1connect.PaprikaServiceClient, error) {
				return client, nil
			}, func() string { return "" }, &output, time.Now)
			err := cmd.Execute()
			if err == nil {
				t.Fatal("status command returned nil error")
			}
			message := strings.ToLower(err.Error())
			for _, text := range test.want {
				if !strings.Contains(message, text) {
					t.Errorf("error %q does not contain %q", message, text)
				}
			}
			for _, text := range test.doNotWant {
				if strings.Contains(message, text) {
					t.Errorf("error %q unexpectedly contains %q", message, text)
				}
			}
		})
	}
}

func TestStatusIsRegisteredOnRootCommand(t *testing.T) {
	command, _, err := newRootCmd(context.Background()).Find([]string{"status"})
	if err != nil {
		t.Fatalf("find status command: %v", err)
	}
	if command == nil || command.Name() != "status" {
		t.Fatalf("root status command = %#v, want registered status", command)
	}
}

func statusResponseFixture(now time.Time) *paprikav1.GetSystemStatusResponse {
	return &paprikav1.GetSystemStatusResponse{
		IndexGeneration: 42,
		Total:           12,
		Health: []*paprikav1.FleetHealthBucket{
			{Health: paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY, Count: 9},
			{Health: paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING, Count: 1},
			{Health: paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED, Count: 1},
			{Health: paprikav1.FleetHealth_FLEET_HEALTH_FAILED, Count: 1},
		},
		Sync: []*paprikav1.FleetSyncBucket{
			{Sync: paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED, Count: 10},
			{Sync: paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC, Count: 2},
		},
		AttentionTotal: 3,
		Attention: []*paprikav1.ApplicationSummary{
			{
				Identity:             &paprikav1.FleetObjectKey{Namespace: "apps", Name: "checkout"},
				Project:              &paprikav1.FleetObjectKey{Name: "default"},
				Health:               paprikav1.FleetHealth_FLEET_HEALTH_FAILED,
				Sync:                 paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC,
				ReleaseState:         paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_FAILED,
				LastTransitionUnixMs: now.Add(-4 * time.Minute).UnixMilli(),
			},
			{
				Identity:             &paprikav1.FleetObjectKey{Namespace: "apps", Name: "payments"},
				Project:              &paprikav1.FleetObjectKey{Name: "default"},
				Health:               paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED,
				Sync:                 paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED,
				ReleaseState:         paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_COMPLETE,
				LastTransitionUnixMs: now.Add(-8 * time.Minute).UnixMilli(),
			},
		},
		HasMoreAttention: true,
	}
}
