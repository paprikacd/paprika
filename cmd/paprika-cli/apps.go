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
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func newAppsCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "apps",
		Short: "Manage applications",
	}

	cmd.AddCommand(listAppsCmd(clientFn, nsFn, output))
	cmd.AddCommand(getAppCmd(clientFn, nsFn, output))
	cmd.AddCommand(syncAppCmd(clientFn, nsFn, output))
	return cmd
}

func listAppsCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List applications",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return err
			}
			res, err := client.ListApplications(context.Background(), connect.NewRequest(&paprikav1.ListApplicationsRequest{
				Namespace: stringPtr(nsFn()),
			}))
			if err != nil {
				return fmt.Errorf("list applications: %w", err)
			}
			return writeApplications(cmd.OutOrStdout(), *output, res.Msg.Applications)
		},
	}
}

func getAppCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	return &cobra.Command{
		Use:   "get NAME",
		Short: "Get an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return err
			}
			res, err := client.GetApplication(context.Background(), connect.NewRequest(&paprikav1.GetApplicationRequest{
				Name:      args[0],
				Namespace: nsFn(),
			}))
			if err != nil {
				return fmt.Errorf("get application: %w", err)
			}
			return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
		},
	}
}

func syncAppCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	var watch bool
	var timeoutSeconds int
	cmd := &cobra.Command{
		Use:   "sync NAME",
		Short: "Trigger a sync for an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return err
			}
			res, err := client.SyncApplication(context.Background(), connect.NewRequest(&paprikav1.SyncApplicationRequest{
				Name:      args[0],
				Namespace: nsFn(),
			}))
			if err != nil {
				return fmt.Errorf("sync application: %w", err)
			}

			if watch {
				return watchApplication(cmd, client, args[0], nsFn(), timeoutSeconds)
			}
			return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
		},
	}
	cmd.Flags().BoolVarP(&watch, "watch", "w", false, "Watch the application until it reaches a terminal phase")
	cmd.Flags().IntVar(&timeoutSeconds, "timeout", 300, "Timeout in seconds when watching")
	return cmd
}

func watchApplication(cmd *cobra.Command, client v1connect.PaprikaServiceClient, name, namespace string, timeoutSeconds int) error {
	ctx, cancel := context.WithTimeout(cmd.Context(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	lastPhase := ""
	for {
		res, err := client.GetApplication(ctx, connect.NewRequest(&paprikav1.GetApplicationRequest{
			Name:      name,
			Namespace: namespace,
		}))
		if err != nil {
			return fmt.Errorf("watch application: %w", err)
		}

		app := res.Msg.Application
		if app.Phase != lastPhase {
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "[%s] phase: %s\n", time.Now().Format(time.RFC3339), app.Phase); err != nil {
				return fmt.Errorf("write output: %w", err)
			}
			lastPhase = app.Phase
		}

		switch app.Phase {
		case "Healthy", "Degraded", "Failed", "RolledBack":
			return writeApplication(cmd.OutOrStdout(), outputTable, app)
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("watch timed out after %d seconds", timeoutSeconds)
		case <-ticker.C:
		}
	}
}

func writeApplications(w io.Writer, output string, apps []*paprikav1.Application) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, &paprikav1.ListApplicationsResponse{Applications: apps})
	case outputTable:
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintln(tw, "NAMESPACE\tNAME\tPHASE\tCURRENT STAGE\tSYNCED\tHEALTH"); err != nil {
			return fmt.Errorf("write header: %w", err)
		}
		for _, a := range apps {
			if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%v\t%s\n", a.Namespace, a.Name, a.Phase, a.CurrentStage, a.Synced, a.Health); err != nil {
				return fmt.Errorf("write row: %w", err)
			}
		}
		if err := tw.Flush(); err != nil {
			return fmt.Errorf("flush table: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}

func writeApplication(w io.Writer, output string, app *paprikav1.Application) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, app)
	case outputTable:
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		writeAppDetail(tw, app)
		if err := tw.Flush(); err != nil {
			return fmt.Errorf("flush table: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}

func writeAppDetail(tw *tabwriter.Writer, app *paprikav1.Application) {
	_, _ = fmt.Fprintf(tw, "Name:\t%s\n", app.Name)
	_, _ = fmt.Fprintf(tw, "Namespace:\t%s\n", app.Namespace)
	_, _ = fmt.Fprintf(tw, "Phase:\t%s\n", app.Phase)
	_, _ = fmt.Fprintf(tw, "Current Stage:\t%s\n", app.CurrentStage)
	_, _ = fmt.Fprintf(tw, "Revision:\t%s\n", app.Revision)
	_, _ = fmt.Fprintf(tw, "Synced:\t%v\n", app.Synced)
	_, _ = fmt.Fprintf(tw, "Health:\t%s\n", app.Health)
	if len(app.Stages) > 0 {
		_, _ = fmt.Fprintln(tw, "\nStages:")
		_, _ = fmt.Fprintln(tw, "NAME\tRING\tPHASE\tRELEASE\tREVISION")
		for _, s := range app.Stages {
			_, _ = fmt.Fprintf(tw, "%s\t%d\t%s\t%s\t%s\n", s.Name, s.Ring, s.Phase, s.Release, s.Revision)
		}
	}
	if len(app.Resources) > 0 {
		_, _ = fmt.Fprintln(tw, "\nResources:")
		_, _ = fmt.Fprintln(tw, "KIND\tNAMESPACE\tNAME\tSTATUS")
		for _, r := range app.Resources {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Kind, r.Namespace, r.Name, r.Status)
		}
	}
	if len(app.Gates) > 0 {
		_, _ = fmt.Fprintln(tw, "\nGates:")
		_, _ = fmt.Fprintln(tw, "NAME\tSTAGE\tSTATUS\tAPPROVED BY")
		for _, g := range app.Gates {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", g.Name, g.Stage, g.Status, g.ApprovedBy)
		}
	}
}
