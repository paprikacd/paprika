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

func newAppsCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "apps",
		Short: "Manage applications",
	}

	cmd.AddCommand(listAppsCmd(ctx, clientFn, nsFn, output))
	cmd.AddCommand(getAppCmd(ctx, clientFn, nsFn, output))
	cmd.AddCommand(syncAppCmd(ctx, clientFn, nsFn, output))
	return cmd
}

func listAppsCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List applications",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.ListApplications(ctx, connect.NewRequest(&paprikav1.ListApplicationsRequest{
				Namespace: stringPtr(nsFn()),
			}))
			if err != nil {
				return fmt.Errorf("list applications: %w", err)
			}
			return writeApplications(cmd.OutOrStdout(), *output, res.Msg.Applications)
		},
	}
}

func getAppCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	return &cobra.Command{
		Use:   "get NAME",
		Short: "Get an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.GetApplication(ctx, connect.NewRequest(&paprikav1.GetApplicationRequest{
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

func syncAppCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	var watch bool
	var timeoutSeconds int
	cmd := &cobra.Command{
		Use:   "sync NAME",
		Short: "Trigger a sync for an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.SyncApplication(ctx, connect.NewRequest(&paprikav1.SyncApplicationRequest{
				Name:      args[0],
				Namespace: nsFn(),
			}))
			if err != nil {
				return fmt.Errorf("sync application: %w", err)
			}

			if watch {
				return watchApplicationLoop(ctx, cmd, client, args[0], nsFn(), timeoutSeconds)
			}
			return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
		},
	}
	cmd.Flags().BoolVarP(&watch, "watch", "w", false, "Watch the application until it reaches a terminal phase")
	cmd.Flags().IntVar(&timeoutSeconds, "timeout", 300, "Timeout in seconds when watching")
	return cmd
}

func watchApplicationLoop(ctx context.Context, cmd *cobra.Command, client v1connect.PaprikaServiceClient, name, namespace string, timeoutSeconds int) error {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
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
		if err := writeAppDetail(tw, app); err != nil {
			return fmt.Errorf("write application detail: %w", err)
		}
		if err := tw.Flush(); err != nil {
			return fmt.Errorf("flush table: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}

type detailWriter struct {
	tw  *tabwriter.Writer
	err error
}

func (w *detailWriter) writef(format string, args ...any) {
	if w.err != nil {
		return
	}
	_, w.err = fmt.Fprintf(w.tw, format, args...)
}

func (w *detailWriter) writeln(args ...any) {
	if w.err != nil {
		return
	}
	_, w.err = fmt.Fprintln(w.tw, args...)
}

func writeAppDetail(tw *tabwriter.Writer, app *paprikav1.Application) error {
	dw := &detailWriter{tw: tw}
	dw.writef("Name:\t%s\n", app.Name)
	dw.writef("Namespace:\t%s\n", app.Namespace)
	dw.writef("Phase:\t%s\n", app.Phase)
	dw.writef("Current Stage:\t%s\n", app.CurrentStage)
	dw.writef("Revision:\t%s\n", app.Revision)
	dw.writef("Synced:\t%v\n", app.Synced)
	dw.writef("Health:\t%s\n", app.Health)
	if len(app.Stages) > 0 {
		dw.writeln("\nStages:")
		dw.writeln("NAME\tRING\tPHASE\tRELEASE\tREVISION")
		for _, s := range app.Stages {
			dw.writef("%s\t%d\t%s\t%s\t%s\n", s.Name, s.Ring, s.Phase, s.Release, s.Revision)
		}
	}
	if len(app.Resources) > 0 {
		dw.writeln("\nResources:")
		dw.writeln("KIND\tNAMESPACE\tNAME\tSTATUS")
		for _, r := range app.Resources {
			dw.writef("%s\t%s\t%s\t%s\n", r.Kind, r.Namespace, r.Name, r.Status)
		}
	}
	if len(app.Gates) > 0 {
		dw.writeln("\nGates:")
		dw.writeln("NAME\tSTAGE\tSTATUS\tAPPROVED BY")
		for _, g := range app.Gates {
			dw.writef("%s\t%s\t%s\t%s\n", g.Name, g.Stage, g.Status, g.ApprovedBy)
		}
	}
	return dw.err
}
