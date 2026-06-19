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

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

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

	return cmd
}
