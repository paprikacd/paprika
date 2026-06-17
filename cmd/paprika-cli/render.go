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
	"os"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func newRenderCmd(clientFn func() (v1connect.PaprikaServiceClient, error), output *string) *cobra.Command {
	var file, valuesFile string
	cmd := &cobra.Command{
		Use:   "render",
		Short: "Render a template into manifests",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := clientFn()
			if err != nil {
				return err
			}

			specJSON, sourceType, err := readTemplateSpec(file)
			if err != nil {
				return err
			}

			valuesJSON, err := readValues(valuesFile)
			if err != nil {
				return err
			}

			res, err := client.Render(context.Background(), connect.NewRequest(&paprikav1.RenderRequest{
				Type:       sourceType,
				SpecJson:   specJSON,
				ValuesJson: valuesJSON,
			}))
			if err != nil {
				return fmt.Errorf("render: %w", err)
			}

			if _, err := cmd.OutOrStdout().Write(res.Msg.Manifests); err != nil {
				return fmt.Errorf("write manifests: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "Template YAML file")
	cmd.Flags().StringVarP(&valuesFile, "values", "v", "", "Values JSON file")
	_ = cmd.MarkFlagRequired("file")
	return cmd
}

func readValues(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read values file: %w", err)
	}
	return data, nil
}
