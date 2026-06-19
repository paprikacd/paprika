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

func newResolveCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), output *string) *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "resolve",
		Short: "Resolve a template source to a local path and revision",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}

			specJSON, sourceType, err := readTemplateSpec(file)
			if err != nil {
				return fmt.Errorf("read template spec: %w", err)
			}

			res, err := client.ResolveSource(ctx, connect.NewRequest(&paprikav1.ResolveSourceRequest{
				Type:     sourceType,
				SpecJson: specJSON,
			}))
			if err != nil {
				return fmt.Errorf("resolve source: %w", err)
			}
			return writeResolve(cmd.OutOrStdout(), *output, res.Msg)
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "Template YAML file")
	cobra.CheckErr(cmd.MarkFlagRequired("file"))
	return cmd
}

func writeResolve(w io.Writer, output string, res *paprikav1.ResolveSourceResponse) error {
	switch output {
	case outputJSON, outputYAML:
		return writeProtoOutput(w, output, res)
	case outputTable:
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintf(tw, "Local Path:\t%s\n", res.LocalPath); err != nil {
			return fmt.Errorf("write local path: %w", err)
		}
		if _, err := fmt.Fprintf(tw, "Hash:\t%s\n", res.Hash); err != nil {
			return fmt.Errorf("write hash: %w", err)
		}
		if _, err := fmt.Fprintf(tw, "Revision:\t%s\n", res.Revision); err != nil {
			return fmt.Errorf("write revision: %w", err)
		}
		if err := tw.Flush(); err != nil {
			return fmt.Errorf("flush table: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}
