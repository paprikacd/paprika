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
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

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
	cobra.CheckErr(initCmd.MarkFlagRequired("server"))

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
