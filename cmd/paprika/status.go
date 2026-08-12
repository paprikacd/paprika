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
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	defaultStatusAttentionLimit uint32 = 20
	maximumStatusAttentionLimit uint32 = 100
	statusRequestTimeout               = 15 * time.Second
)

func newStatusCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	return newStatusCmdWithClock(ctx, clientFn, nsFn, output, time.Now)
}

func newStatusCmdWithClock(
	ctx context.Context,
	clientFn func() (v1connect.PaprikaServiceClient, error),
	nsFn func() string,
	output *string,
	now func() time.Time,
) *cobra.Command {
	var attentionLimit uint32
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show authorized system status",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if attentionLimit > maximumStatusAttentionLimit {
				return fmt.Errorf("attention limit must not exceed %d", maximumStatusAttentionLimit)
			}

			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			requestCtx, cancel := context.WithTimeout(ctx, statusRequestTimeout)
			defer cancel()
			response, err := client.GetSystemStatus(requestCtx, connect.NewRequest(&paprikav1.GetSystemStatusRequest{
				Namespace:      stringPtr(nsFn()),
				AttentionLimit: attentionLimit,
			}))
			if err != nil {
				return statusRPCError(err)
			}
			return writeSystemStatus(cmd.OutOrStdout(), *output, response.Msg, now())
		},
	}
	cmd.Flags().Uint32Var(&attentionLimit, "attention-limit", defaultStatusAttentionLimit, "Maximum applications requiring attention to show (maximum 100; 0 uses server default)")
	return cmd
}

func statusRPCError(err error) error {
	//nolint:exhaustive // Only these codes have status-specific recovery guidance.
	switch connect.CodeOf(err) {
	case connect.CodeUnauthenticated:
		return errors.New("authentication required; run 'paprika login'")
	case connect.CodeUnavailable:
		return errors.New("paprika is warming up or unavailable; retry shortly")
	default:
		return fmt.Errorf("get system status: %w", err)
	}
}

func writeSystemStatus(w io.Writer, output string, status *paprikav1.GetSystemStatusResponse, now time.Time) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, status)
	case outputTable:
		return writeSystemStatusTable(w, status, now)
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}

func writeSystemStatusTable(w io.Writer, status *paprikav1.GetSystemStatusResponse, now time.Time) error {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "APPLICATIONS\tHEALTHY\tPROGRESSING\tDEGRADED\tFAILED\tOUT-OF-SYNC\tATTENTION"); err != nil {
		return fmt.Errorf("write status header: %w", err)
	}
	if _, err := fmt.Fprintf(tw, "%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
		status.GetTotal(),
		healthBucketCount(status.GetHealth(), paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY),
		healthBucketCount(status.GetHealth(), paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING),
		healthBucketCount(status.GetHealth(), paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED),
		healthBucketCount(status.GetHealth(), paprikav1.FleetHealth_FLEET_HEALTH_FAILED),
		syncBucketCount(status.GetSync(), paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC),
		status.GetAttentionTotal(),
	); err != nil {
		return fmt.Errorf("write status totals: %w", err)
	}

	if len(status.GetAttention()) > 0 {
		if _, err := fmt.Fprintln(tw, "\nATTENTION"); err != nil {
			return fmt.Errorf("write attention heading: %w", err)
		}
		if _, err := fmt.Fprintln(tw, "NAMESPACE\tAPPLICATION\tPROJECT\tHEALTH\tSYNC\tRELEASE\tUPDATED"); err != nil {
			return fmt.Errorf("write attention header: %w", err)
		}
		for _, application := range status.GetAttention() {
			if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
				application.GetIdentity().GetNamespace(),
				application.GetIdentity().GetName(),
				application.GetProject().GetName(),
				statusHealthName(application.GetHealth()),
				statusSyncName(application.GetSync()),
				statusReleaseName(application.GetReleaseState()),
				formatRelativeUpdate(now, application.GetLastTransitionUnixMs()),
			); err != nil {
				return fmt.Errorf("write attention row: %w", err)
			}
		}
	}

	if err := tw.Flush(); err != nil {
		return fmt.Errorf("flush status table: %w", err)
	}
	return nil
}

func healthBucketCount(buckets []*paprikav1.FleetHealthBucket, health paprikav1.FleetHealth) uint64 {
	for _, bucket := range buckets {
		if bucket.GetHealth() == health {
			return bucket.GetCount()
		}
	}
	return 0
}

func syncBucketCount(buckets []*paprikav1.FleetSyncBucket, syncState paprikav1.FleetSyncState) uint64 {
	for _, bucket := range buckets {
		if bucket.GetSync() == syncState {
			return bucket.GetCount()
		}
	}
	return 0
}

func statusHealthName(health paprikav1.FleetHealth) string {
	return statusEnumName(health.String(), "FLEET_HEALTH_")
}

func statusSyncName(syncState paprikav1.FleetSyncState) string {
	return statusEnumName(syncState.String(), "FLEET_SYNC_STATE_")
}

func statusReleaseName(release paprikav1.FleetReleaseState) string {
	return statusEnumName(release.String(), "FLEET_RELEASE_STATE_")
}

func statusEnumName(value, prefix string) string {
	words := strings.Split(strings.ToLower(strings.TrimPrefix(value, prefix)), "_")
	for i, word := range words {
		if word != "" {
			words[i] = strings.ToUpper(word[:1]) + word[1:]
		}
	}
	return strings.Join(words, "")
}

func formatRelativeUpdate(now time.Time, unixMilliseconds int64) string {
	if unixMilliseconds <= 0 {
		return "-"
	}
	elapsed := now.Sub(time.UnixMilli(unixMilliseconds))
	if elapsed < 0 {
		elapsed = 0
	}
	switch {
	case elapsed < time.Minute:
		return fmt.Sprintf("%ds ago", int64(elapsed/time.Second))
	case elapsed < time.Hour:
		return fmt.Sprintf("%dm ago", int64(elapsed/time.Minute))
	case elapsed < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int64(elapsed/time.Hour))
	default:
		return fmt.Sprintf("%dd ago", int64(elapsed/(24*time.Hour)))
	}
}
