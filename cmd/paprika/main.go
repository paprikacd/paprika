package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func main() {
	if err := newRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "paprika",
		Short: "Paprika CLI for intelligent Kubernetes deployments",
		Long:  "paprika is a kubectl-like CLI that submits rendered manifest bundles to the Paprika platform and watches rollout health.",
	}
	root.AddCommand(newApplyCmd())
	return root
}
