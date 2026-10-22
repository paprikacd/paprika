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

const healthRequestTimeout = 15 * time.Second

func newHealthCmd(
	ctx context.Context,
	clientFn func() (v1connect.PaprikaServiceClient, error),
	output *string,
) *cobra.Command {
	var failOnDegraded bool
	var stuckReleaseSeconds uint32
	cmd := &cobra.Command{
		Use:   "health",
		Short: "Check Paprika control-plane health after a deployment",
		Long: `Check whether the Paprika control plane is healthy and keeping up.

The report combines server build identity, controller-manager readiness,
application health and reconcile lag, exhausted release retries, and stuck
releases. It is intended as a post-deployment gate:

  paprika health --fail-on-degraded

Exit status is non-zero when the report is failed, or when it is degraded and
--fail-on-degraded is set.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runHealth(ctx, cmd.OutOrStdout(), clientFn, *output, failOnDegraded, stuckReleaseSeconds)
		},
	}
	cmd.Flags().BoolVar(&failOnDegraded, "fail-on-degraded", false,
		"Exit non-zero when the report is degraded")
	cmd.Flags().Uint32Var(&stuckReleaseSeconds, "stuck-release-seconds", 1800,
		"Age after which a non-terminal release is considered stuck (60-86400; 0 uses the server default)")
	return cmd
}

func runHealth(
	ctx context.Context,
	w io.Writer,
	clientFn func() (v1connect.PaprikaServiceClient, error),
	output string,
	failOnDegraded bool,
	stuckReleaseSeconds uint32,
) error {
	if err := validateHealthRequest(output, stuckReleaseSeconds); err != nil {
		return err
	}
	health, err := fetchSystemHealth(ctx, clientFn, stuckReleaseSeconds)
	if err != nil {
		return err
	}
	if err := writeSystemHealth(w, output, health); err != nil {
		return err
	}
	return healthExitError(health.GetStatus(), failOnDegraded)
}

func validateHealthRequest(output string, stuckReleaseSeconds uint32) error {
	if err := validateStatusOutput(output); err != nil {
		return err
	}
	if stuckReleaseSeconds != 0 && (stuckReleaseSeconds < 60 || stuckReleaseSeconds > 86400) {
		return errors.New("stuck-release-seconds must be between 60 and 86400")
	}
	return nil
}

func fetchSystemHealth(
	ctx context.Context,
	clientFn func() (v1connect.PaprikaServiceClient, error),
	stuckReleaseSeconds uint32,
) (*paprikav1.GetSystemHealthResponse, error) {
	client, err := clientFn()
	if err != nil {
		return nil, fmt.Errorf("create client: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, healthRequestTimeout)
	defer cancel()
	response, err := client.GetSystemHealth(requestCtx, connect.NewRequest(&paprikav1.GetSystemHealthRequest{
		StuckReleaseSeconds: stuckReleaseSeconds,
	}))
	if err != nil {
		return nil, healthRPCError(err)
	}
	return response.Msg, nil
}

func healthExitError(status string, failOnDegraded bool) error {
	switch status {
	case "failed":
		return errors.New("system health is failed")
	case "degraded":
		if failOnDegraded {
			return errors.New("system health is degraded")
		}
	}
	return nil
}

func healthRPCError(err error) error {
	//nolint:exhaustive // Only these codes have health-specific recovery guidance.
	switch connect.CodeOf(err) {
	case connect.CodeUnauthenticated:
		return errors.New("authentication required; run 'paprika login'")
	case connect.CodeUnavailable:
		return errors.New("paprika is warming up or unavailable; retry shortly")
	default:
		return fmt.Errorf("get system health: %w", friendlyError(err))
	}
}

func writeSystemHealth(w io.Writer, output string, health *paprikav1.GetSystemHealthResponse) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, health)
	case outputTable:
		return writeSystemHealthTable(w, health)
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}

func writeSystemHealthTable(w io.Writer, health *paprikav1.GetSystemHealthResponse) error {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	if err := writeHealthSummary(tw, health); err != nil {
		return err
	}
	if err := writeHealthChecks(tw, health.GetChecks()); err != nil {
		return err
	}
	if err := writeHealthStale(tw, health.GetStaleApplications()); err != nil {
		return err
	}
	if err := writeHealthStuck(tw, health.GetStuckReleases()); err != nil {
		return err
	}
	if err := tw.Flush(); err != nil {
		return fmt.Errorf("flush health report: %w", err)
	}
	return nil
}

func writeHealthSummary(tw *tabwriter.Writer, health *paprikav1.GetSystemHealthResponse) error {
	if err := writeHealthRow(tw, "STATUS\t%s\n", strings.ToUpper(health.GetStatus())); err != nil {
		return err
	}
	if err := writeHealthRow(tw, "SERVER\t%s (%s, %s)\n",
		health.GetServerVersion(), shortCommit(health.GetServerGitCommit()), health.GetServerBuildDate()); err != nil {
		return err
	}
	if err := writeHealthRow(tw, "APPLICATIONS\t%d total\t%d healthy\t%d progressing\t%d degraded\t%d failed\t%d stale\n",
		health.GetApplicationsTotal(),
		health.GetApplicationsHealthy(),
		health.GetApplicationsProgressing(),
		health.GetApplicationsDegraded(),
		health.GetApplicationsFailed(),
		health.GetApplicationsStale(),
	); err != nil {
		return err
	}
	controller := health.GetController()
	if controller == nil {
		return nil
	}
	return writeHealthRow(tw, "CONTROLLER\t%d/%d ready\t%d restarts\n",
		controller.GetReadyReplicas(), controller.GetDesiredReplicas(), controller.GetRestartCount())
}

func writeHealthChecks(tw *tabwriter.Writer, checks []*paprikav1.SystemHealthCheck) error {
	if err := writeHealthLine(tw, "CHECKS"); err != nil {
		return err
	}
	for _, check := range checks {
		if err := writeHealthRow(tw, "  %s\t%s\t%s\n",
			strings.ToUpper(check.GetStatus()), check.GetName(), check.GetMessage()); err != nil {
			return err
		}
	}
	return nil
}

func writeHealthStale(tw *tabwriter.Writer, stale []*paprikav1.StaleApplication) error {
	if len(stale) == 0 {
		return nil
	}
	if err := writeHealthLine(tw, "STALE APPLICATIONS"); err != nil {
		return err
	}
	for _, app := range stale {
		if err := writeHealthRow(tw, "  %s/%s\tgeneration=%d observed=%d lag=%d\n",
			app.GetApplication().GetNamespace(), app.GetApplication().GetName(),
			app.GetGeneration(), app.GetObservedGeneration(), app.GetLagGenerations()); err != nil {
			return err
		}
	}
	return nil
}

func writeHealthStuck(tw *tabwriter.Writer, stuck []*paprikav1.StuckRelease) error {
	if len(stuck) == 0 {
		return nil
	}
	if err := writeHealthLine(tw, "STUCK RELEASES"); err != nil {
		return err
	}
	for _, release := range stuck {
		if err := writeHealthRow(tw, "  %s/%s\tphase=%s age=%s\n",
			release.GetRelease().GetNamespace(), release.GetRelease().GetName(),
			release.GetPhase(), healthAge(release.GetAgeSeconds())); err != nil {
			return err
		}
	}
	return nil
}

func writeHealthRow(tw *tabwriter.Writer, format string, args ...any) error {
	if _, err := fmt.Fprintf(tw, format, args...); err != nil {
		return fmt.Errorf("write health report: %w", err)
	}
	return nil
}

func writeHealthLine(tw *tabwriter.Writer, line string) error {
	if _, err := fmt.Fprintln(tw, line); err != nil {
		return fmt.Errorf("write health report: %w", err)
	}
	return nil
}

func healthAge(seconds uint64) time.Duration {
	return time.Duration(seconds) * time.Second //nolint:gosec // server-reported age, bounded by the health report
}
