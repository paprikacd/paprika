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

// Package main implements the paprika CLI for interacting with the Paprika API service.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

var (
	globalConfigPath string
	globalServer     string
	globalNamespace  string
	globalUsername   string
	globalPassword   string
	globalToken      string
	globalOutput     string
)

func main() {
	if err := newRootCmd().Execute(); err != nil {
		printErrorf("%v", err)
		os.Exit(1)
	}
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "paprika",
		Short: "Paprika CLI — interact with the Paprika API service",
		Long: `paprika is the command-line interface for the Paprika application delivery platform.

It lists applications, pipelines, releases and stages, triggers syncs, approves gates,
and renders templates against the Paprika Connect-RPC API.`,
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

	root.AddCommand(newConfigCmd())
	root.AddCommand(newAppsCmd(clientFn, nsFn, &globalOutput))
	root.AddCommand(newPipelinesCmd(clientFn, nsFn, &globalOutput))
	root.AddCommand(newReleasesCmd(clientFn, nsFn, &globalOutput))
	root.AddCommand(newStagesCmd(clientFn, nsFn, &globalOutput))
	root.AddCommand(newGatesCmd(clientFn, nsFn, &globalOutput))
	root.AddCommand(newRenderCmd(clientFn, &globalOutput))
	root.AddCommand(newResolveCmd(clientFn, &globalOutput))

	return root
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

func newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Manage paprika CLI configuration",
	}

	initCmd := &cobra.Command{
		Use:   "init",
		Short: "Initialize or update the CLI config file",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := &Config{
				Server:    globalServer,
				Namespace: globalNamespace,
				Username:  globalUsername,
				Password:  globalPassword,
				Token:     globalToken,
			}
			if cfg.Server == "" {
				return errors.New("--server is required")
			}
			path := globalConfigPath
			if path == "" {
				path = defaultConfigPath()
			}
			if err := cfg.Save(path); err != nil {
				return fmt.Errorf("save config: %w", err)
			}
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "Config written to %s\n", path); err != nil {
				return fmt.Errorf("write output: %w", err)
			}
			return nil
		},
	}
	initCmd.Flags().StringVar(&globalServer, "server", "", "Paprika API server URL")
	initCmd.Flags().StringVarP(&globalNamespace, "namespace", "n", "", "Default namespace")
	initCmd.Flags().StringVar(&globalUsername, "username", "", "Basic auth username")
	initCmd.Flags().StringVar(&globalPassword, "password", "", "Basic auth password")
	initCmd.Flags().StringVar(&globalToken, "token", "", "OIDC bearer token")
	_ = initCmd.MarkFlagRequired("server")

	viewCmd := &cobra.Command{
		Use:   "view",
		Short: "View the current CLI config file",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := globalConfigPath
			if path == "" {
				path = defaultConfigPath()
			}
			data, err := os.ReadFile(path)
			if err != nil {
				if os.IsNotExist(err) {
					return fmt.Errorf("config not found at %s; run 'paprika config init'", path)
				}
				return fmt.Errorf("read config: %w", err)
			}
			if _, err := fmt.Fprint(cmd.OutOrStdout(), string(data)); err != nil {
				return fmt.Errorf("write output: %w", err)
			}
			return nil
		},
	}

	cmd.AddCommand(initCmd, viewCmd)
	return cmd
}
