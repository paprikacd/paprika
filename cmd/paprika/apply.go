package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/tools/clientcmd"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type applyOptions struct {
	files           []string
	namespace       string
	name            string
	project         string
	skipPolicies    []string
	policyOverrides []string
	dryRun          bool
	wait            bool
	timeout         time.Duration
	server          string
}

func newApplyCmd(ctx context.Context) *cobra.Command {
	opts := &applyOptions{}
	cmd := &cobra.Command{
		Use:   "apply -f <path> [-f <path>...]",
		Short: "Apply a manifest bundle to Paprika",
		Long:  "Render raw YAML files or directories into a manifest bundle and submit it to the Paprika API server.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runApply(ctx, opts)
		},
	}
	cmd.Flags().StringArrayVarP(&opts.files, "file", "f", nil, "File, directory, or archive to apply (repeatable)")
	cmd.Flags().StringVarP(&opts.namespace, "namespace", "n", "", "Target namespace (defaults to current kubeconfig context)")
	cmd.Flags().StringVar(&opts.name, "name", "", "Application name (defaults to first resource or path name)")
	cmd.Flags().StringVar(&opts.project, "project", "", "AppProject that governs this application (defaults to default)")
	cmd.Flags().StringArrayVar(&opts.skipPolicies, "skip-policy", nil, "Skip a named Policy for this apply")
	cmd.Flags().StringArrayVar(&opts.policyOverrides, "policy-override", nil, "Override a policy action (name=enforce|warn)")
	cmd.Flags().BoolVar(&opts.dryRun, "dry-run", false, "Render and evaluate policies without mutating the cluster")
	cmd.Flags().BoolVar(&opts.wait, "wait", true, "Block and watch until terminal phase")
	cmd.Flags().DurationVar(&opts.timeout, "timeout", 5*time.Minute, "Watch timeout")
	cmd.Flags().StringVar(&opts.server, "server", defaultServer(), "Paprika API server URL")
	cobra.CheckErr(cmd.MarkFlagRequired("file"))
	return cmd
}

func defaultServer() string {
	if s := os.Getenv("PAPRIKA_SERVER"); s != "" {
		return s
	}
	return "http://localhost:3000"
}

//nolint:cyclop // apply reconciles multiple resource types
func runApply(ctx context.Context, opts *applyOptions) error {
	if len(opts.files) == 0 {
		return errors.New("at least one -f path is required")
	}

	bundle, suggestedName, err := loadManifestBundle(opts.files)
	if err != nil {
		return fmt.Errorf("load manifests: %w", err)
	}

	namespace := opts.namespace
	if namespace == "" {
		namespace = currentNamespace()
	}

	appName := opts.name
	if appName == "" {
		appName, err = deriveAppName(bundle, opts.files[0], suggestedName)
		if err != nil {
			return fmt.Errorf("derive application name: %w", err)
		}
	}

	overrides, err := parsePolicyOverrides(opts.policyOverrides)
	if err != nil {
		return fmt.Errorf("parse policy overrides: %w", err)
	}

	client := v1connect.NewPaprikaServiceClient(http.DefaultClient, opts.server)

	resp, err := client.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace:       namespace,
		Name:            appName,
		Project:         opts.project,
		Manifests:       bundle,
		SkipPolicies:    opts.skipPolicies,
		PolicyOverrides: overrides,
		DryRun:          opts.dryRun,
	}))
	if err != nil {
		return fmt.Errorf("apply bundle RPC failed: %w", err)
	}

	if resp.Msg.Blocked {
		printPolicyResults(resp.Msg.PolicyResults)
		return fmt.Errorf("apply blocked: %s", resp.Msg.BlockReason)
	}

	if opts.dryRun {
		fmt.Println("Dry run complete. No resources were created.")
		printPolicyResults(resp.Msg.PolicyResults)
		return nil
	}

	if !opts.wait {
		fmt.Printf("Submitted %s/%s\n", namespace, appName)
		printPolicyResults(resp.Msg.PolicyResults)
		return nil
	}

	return watchApplication(ctx, client, namespace, appName, resp.Msg.Release, resp.Msg.PolicyResults, opts.timeout)
}

func loadManifestBundle(paths []string) (bundle []byte, suggestedName string, err error) {
	var docs []string
	for _, p := range paths {
		loaded, name, loadErr := loadPath(p)
		if loadErr != nil {
			return nil, "", fmt.Errorf("load path %q: %w", p, loadErr)
		}
		if suggestedName == "" {
			suggestedName = name
		}
		docs = append(docs, loaded...)
	}
	if len(docs) == 0 {
		return nil, "", fmt.Errorf("no manifests found in paths: %v", paths)
	}
	return []byte(strings.Join(docs, "\n---\n")), suggestedName, nil
}

func loadPath(p string) (docs []string, suggestedName string, err error) {
	info, err := os.Stat(p)
	if err != nil {
		return nil, "", fmt.Errorf("stat path: %w", err)
	}
	if !info.IsDir() {
		//nolint:gosec // path comes from CLI arg, user's own files
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return nil, "", fmt.Errorf("read file: %w", readErr)
		}
		return []string{string(data)}, fileBaseName(p), nil
	}

	entries, err := os.ReadDir(p)
	if err != nil {
		return nil, "", fmt.Errorf("read directory: %w", err)
	}
	files := yamlFiles(entries, p)

	docs = make([]string, 0, len(files))
	for _, f := range files {
		//nolint:gosec // paths come from os.ReadDir, user's own files
		data, readErr := os.ReadFile(f)
		if readErr != nil {
			return nil, "", fmt.Errorf("read file %q: %w", f, readErr)
		}
		docs = append(docs, string(data))
	}
	return docs, filepath.Base(p), nil
}

func yamlFiles(entries []os.DirEntry, dir string) []string {
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext == ".yaml" || ext == ".yml" {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(files)
	return files
}

func fileBaseName(p string) string {
	return filepath.Base(strings.TrimSuffix(p, filepath.Ext(p)))
}

func deriveAppName(bundle []byte, firstPath, suggestedName string) (string, error) {
	docs := strings.Split(string(bundle), "\n---\n")
	for _, doc := range docs {
		var obj map[string]interface{}
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			continue
		}
		if obj == nil {
			continue
		}
		meta, ok := obj["metadata"].(map[string]interface{})
		if !ok {
			if obj["metadata"] == nil {
				continue
			}
			return "", errors.New("manifest metadata is not an object")
		}
		if meta == nil {
			continue
		}
		if name, ok := meta["name"].(string); ok && name != "" {
			return name, nil
		}
	}
	if suggestedName != "" {
		return suggestedName, nil
	}
	return fileBaseName(firstPath), nil
}

func parsePolicyOverrides(in []string) (map[string]string, error) {
	out := make(map[string]string, len(in))
	for _, raw := range in {
		parts := strings.SplitN(raw, "=", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid policy override %q (expected name=enforce|warn)", raw)
		}
		action := strings.ToLower(parts[1])
		if action != "enforce" && action != "warn" {
			return nil, fmt.Errorf("invalid policy override action %q (expected enforce or warn)", parts[1])
		}
		out[parts[0]] = action
	}
	return out, nil
}

func currentNamespace() string {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	config := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules,
		&clientcmd.ConfigOverrides{},
	)
	ns, _, err := config.Namespace()
	if err != nil || ns == "" {
		return "default"
	}
	return ns
}

func printPolicyResults(results []*paprikav1.PolicyResult) {
	if len(results) == 0 {
		return
	}
	fmt.Println("Policy results:")
	for _, r := range results {
		status := "PASS"
		if !r.Passed {
			status = "FAIL"
		}
		fmt.Printf("  %-30s %s  severity=%s action=%s", r.Name, status, r.Severity, r.Action)
		if r.Message != "" {
			fmt.Printf("  (%s)", r.Message)
		}
		fmt.Println()
	}
}
