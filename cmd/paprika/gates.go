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

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func writeGateStatuses(w io.Writer, output string, gates []*paprikav1.GateStatus) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, &paprikav1.ListGateStatusResponse{Gates: gates})
	case outputTable:
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintln(tw, "NAME\tSTAGE\tTYPE\tSTATUS\tAPPROVED BY\tMESSAGE"); err != nil {
			return fmt.Errorf("write header: %w", err)
		}
		for _, g := range gates {
			if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", g.Name, g.Stage, g.Type, g.Status, g.ApprovedBy, g.Message); err != nil {
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

func newGatesCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "gates",
		Short: "Manage approval gates",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "approve APP GATE",
		Short: "Approve a gate for an application",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.ApproveGate(ctx, connect.NewRequest(&paprikav1.ApproveGateRequest{
				Name:      args[0],
				Namespace: nsFn(),
				Gate:      args[1],
			}))
			if err != nil {
				return fmt.Errorf("approve gate: %w", err)
			}
			return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "reject APP GATE",
		Short: "Reject a gate for an application",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.RejectGate(ctx, connect.NewRequest(&paprikav1.RejectGateRequest{
				Name:      args[0],
				Namespace: nsFn(),
				Gate:      args[1],
			}))
			if err != nil {
				return fmt.Errorf("reject gate: %w", err)
			}
			return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "list APP",
		Short: "List approval gates for an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.ListGateStatus(ctx, connect.NewRequest(&paprikav1.ListGateStatusRequest{
				Name:      args[0],
				Namespace: nsFn(),
			}))
			if err != nil {
				return fmt.Errorf("list gate status: %w", err)
			}
			return writeGateStatuses(cmd.OutOrStdout(), *output, res.Msg.Gates)
		},
	})

	return cmd
}
