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

// Package main implements the paprika CLI for interacting with the Paprika platform.
package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"

	globalConfigPath string
	globalServer     string
	globalNamespace  string
	globalUsername   string
	globalPassword   string
	globalToken      string
	globalOutput     string
)

func main() {
	if err := run(context.Background(), os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr); err != nil {
		printErrorf("%v", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) error {
	cmd := newRootCmdWithEnv(ctx, getenv)
	cmd.SetArgs(args)
	cmd.SetIn(stdin)
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	if err := cmd.ExecuteContext(ctx); err != nil {
		return fmt.Errorf("execute root command: %w", err)
	}
	return nil
}

func newRootCmd(ctx context.Context) *cobra.Command {
	return newRootCmdWithEnv(ctx, os.Getenv)
}

func newRootCmdWithEnv(ctx context.Context, getenv func(string) string) *cobra.Command {
	root := &cobra.Command{
		Use:   "paprika",
		Short: "Paprika CLI for intelligent Kubernetes deployments",
		Long: `paprika is the command-line interface for the Paprika application delivery platform.

It applies manifest bundles, lists applications, pipelines, releases and stages,
triggers syncs, approves gates, and renders templates against the Paprika API.`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	root.PersistentFlags().StringVar(&globalConfigPath, "config", "", "Path to config file (default ~/.paprika/config.yaml)")
	root.PersistentFlags().StringVar(&globalServer, "server", "", "Paprika API server URL (overrides config)")
	root.PersistentFlags().StringVarP(&globalNamespace, "namespace", "n", "", "Default Kubernetes namespace (overrides config)")
	root.PersistentFlags().StringVar(&globalUsername, "username", "", "Basic auth username (overrides config)")
	root.PersistentFlags().StringVar(&globalPassword, "password", "", "Basic auth password (overrides config)")
	root.PersistentFlags().StringVar(&globalToken, "token", "", "OIDC bearer token (overrides config)")
	root.PersistentFlags().StringVarP(&globalOutput, "output", "o", outputTable, "Output format: table, json, yaml")

	clientFn := func() (v1connect.PaprikaServiceClient, error) {
		cfg, err := loadMergedConfig()
		if err != nil {
			return nil, fmt.Errorf("load config: %w", err)
		}
		return newClient(cfg)
	}
	nsFn := func() string {
		cfg, err := loadMergedConfig()
		if err != nil {
			return ""
		}
		return cfg.Namespace
	}

	root.AddCommand(newApplyCmd(ctx, getenv))
	root.AddCommand(newConfigCmd())
	root.AddCommand(newLoginCmd(ctx))
	root.AddCommand(newStatusCmd(ctx, clientFn, nsFn, &globalOutput))
	root.AddCommand(newVersionCmd())
	root.AddCommand(newAppsCmd(ctx, clientFn, nsFn, &globalOutput))
	root.AddCommand(newPipelinesCmd(ctx, clientFn, nsFn, &globalOutput))
	root.AddCommand(newReleasesCmd(ctx, clientFn, nsFn, &globalOutput))
	root.AddCommand(newStagesCmd(ctx, clientFn, nsFn, &globalOutput))
	root.AddCommand(newGatesCmd(ctx, clientFn, nsFn, &globalOutput))
	root.AddCommand(newRenderCmd(ctx, clientFn, &globalOutput))
	root.AddCommand(newResolveCmd(ctx, clientFn, &globalOutput))

	return root
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the Paprika CLI version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "paprika %s\n", version); err != nil {
				return fmt.Errorf("write version: %w", err)
			}
			if commit != "none" || date != "unknown" {
				if _, err := fmt.Fprintf(cmd.OutOrStdout(), "commit=%s date=%s\n", commit, date); err != nil {
					return fmt.Errorf("write build metadata: %w", err)
				}
			}
			return nil
		},
	}
}

func loadMergedConfig() (*Config, error) {
	path := globalConfigPath
	if path == "" {
		path = defaultConfigPath()
	}

	cfg, err := loadConfig(path)
	if err != nil {
		return nil, err
	}

	if globalServer != "" {
		cfg.Server = globalServer
	}
	if globalNamespace != "" {
		cfg.Namespace = globalNamespace
	}
	if globalUsername != "" {
		cfg.Username = globalUsername
	}
	if globalPassword != "" {
		cfg.Password = globalPassword
	}
	if globalToken != "" {
		cfg.Token = globalToken
	}

	return cfg, nil
}
