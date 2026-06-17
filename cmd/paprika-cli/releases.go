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

func newReleasesCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "releases",
		Short: "Manage releases",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List releases",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return err
			}
			res, err := client.ListReleases(context.Background(), connect.NewRequest(&paprikav1.ListReleasesRequest{
				Namespace: stringPtr(nsFn()),
			}))
			if err != nil {
				return fmt.Errorf("list releases: %w", err)
			}
			return writeReleases(cmd.OutOrStdout(), *output, res.Msg.Releases)
		},
	})

	return cmd
}

func writeReleases(w io.Writer, output string, releases []*paprikav1.Release) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, &paprikav1.ListReleasesResponse{Releases: releases})
	case outputTable:
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintln(tw, "NAMESPACE\tNAME\tPHASE\tTARGET\tPIPELINE\tCURRENT STAGE"); err != nil {
			return fmt.Errorf("write header: %w", err)
		}
		for _, r := range releases {
			if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", r.Namespace, r.Name, r.Phase, r.Target, r.Pipeline, r.CurrentStage); err != nil {
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
