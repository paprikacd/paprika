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

//nolint:dupl // boilerplate list subcommand
func newStagesCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "stages",
		Short: "Manage stages",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List stages",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.ListStages(ctx, connect.NewRequest(&paprikav1.ListStagesRequest{
				Namespace: stringPtr(nsFn()),
			}))
			if err != nil {
				return fmt.Errorf("list stages: %w", err)
			}
			return writeStages(cmd.OutOrStdout(), *output, res.Msg.Stages)
		},
	})

	return cmd
}

func writeStages(w io.Writer, output string, stages []*paprikav1.Stage) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, &paprikav1.ListStagesResponse{Stages: stages})
	case outputTable:
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintln(tw, "NAMESPACE\tNAME\tSTAGE\tRING\tPHASE"); err != nil {
			return fmt.Errorf("write header: %w", err)
		}
		for _, s := range stages {
			if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%d\t%s\n", s.Namespace, s.Name, s.StageName, s.Ring, s.Phase); err != nil {
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
