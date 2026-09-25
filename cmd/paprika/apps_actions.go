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
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// restartableKinds maps accepted workload kind spellings (lowered) to the
// canonical Kind the API expects. Matches the restart_workload allowlist.
var restartableKinds = map[string]string{
	"deployment":  "Deployment",
	"deploy":      "Deployment",
	"statefulset": "StatefulSet",
	"sts":         "StatefulSet",
	"daemonset":   "DaemonSet",
	"ds":          "DaemonSet",
}

func restartAppCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	var yes bool
	var resourceNamespace string
	cmd := &cobra.Command{
		Use:   "restart NAME KIND/RESOURCE",
		Short: "Rolling-restart a workload the application manages",
		Long: "Rolling-restart a Deployment, StatefulSet, or DaemonSet managed by the " +
			"application. Without --yes the call dry-runs: the server patches the " +
			"resource server-side with DryRun=All and prints the unified diff.",
		Example: `  paprika apps restart my-app deployment/web
  paprika apps restart my-app deployment/web --yes`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			kindPart, name, err := splitKindName(args[1])
			if err != nil {
				return err
			}
			kind, ok := restartableKinds[strings.ToLower(kindPart)]
			if !ok {
				return fmt.Errorf("kind %q cannot be restarted; allowed: Deployment, StatefulSet, DaemonSet", kindPart)
			}
			resNS := resourceNamespace
			if resNS == "" {
				resNS = nsFn()
			}
			patch := fmt.Sprintf(
				`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`,
				time.Now().UTC().Format(time.RFC3339))

			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.ApplyResourcePatch(ctx, connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
				Namespace:         nsFn(),
				Name:              args[0],
				Group:             "apps",
				Version:           "v1",
				Kind:              kind,
				ResourceName:      name,
				ResourceNamespace: resNS,
				PatchType:         paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH,
				Patch:             patch,
				Confirm:           yes,
				Reason:            "paprika-cli restart",
			}))
			if err != nil {
				return fmt.Errorf("restart %s/%s: %w", kind, name, friendlyError(err))
			}
			return writePatchResult(cmd.OutOrStdout(), *output, res.Msg)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Apply the restart (without it, the call is a dry-run diff)")
	cmd.Flags().StringVar(&resourceNamespace, "resource-namespace", "",
		"Namespace of the workload (defaults to the app namespace)")
	return cmd
}

func rollbackAppCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "rollback NAME",
		Short: "Roll the application's release back to the previous revision",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !yes {
				return errors.New("rollback is destructive; re-run with --yes to confirm")
			}
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.RollbackRelease(ctx, connect.NewRequest(&paprikav1.RollbackReleaseRequest{
				Name:      args[0],
				Namespace: nsFn(),
			}))
			if err != nil {
				return fmt.Errorf("rollback %s: %w", args[0], friendlyError(err))
			}
			if *output == outputJSON || *output == outputYAML {
				return writeProtoOutput(cmd.OutOrStdout(), *output, res.Msg)
			}
			if _, err = fmt.Fprintf(cmd.OutOrStdout(), "Rolled back %s to release %s\n",
				args[0], res.Msg.GetRelease().GetName()); err != nil {
				return fmt.Errorf("write output: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm the rollback")
	return cmd
}

func ignoreDiffAppCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ignore-diff",
		Short: "Manage scoped ignore-difference rules for an application",
	}
	cmd.AddCommand(ignoreDiffWriteCmd(ctx, clientFn, nsFn, output, false))
	cmd.AddCommand(ignoreDiffWriteCmd(ctx, clientFn, nsFn, output, true))
	return cmd
}

func ignoreDiffWriteCmd(ctx context.Context, clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string, remove bool) *cobra.Command {
	var kind, resourceName, resourceNamespace, group, reason string
	var fields []string
	verb := "add"
	if remove {
		verb = "remove"
	}
	cmd := &cobra.Command{
		Use:   verb + " APP --kind KIND --field JSON_POINTER [--field ...]",
		Short: verb + " ignore-difference rules",
		Example: `  paprika apps ignore-diff add my-app --kind Deployment --field /spec/replicas
  paprika apps ignore-diff remove my-app --kind Deployment --field /spec/replicas`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if kind == "" {
				return errors.New("--kind is required (scope the rule to a resource kind; use --resource-name for a specific instance)")
			}
			if len(fields) == 0 {
				return errors.New("at least one --field JSON pointer is required (e.g. /spec/replicas)")
			}
			for _, f := range fields {
				if !strings.HasPrefix(f, "/") {
					return fmt.Errorf("--field %q is not a JSON pointer — pointers start with / (e.g. /spec/template/spec/containers/0/image)", f)
				}
			}
			client, err := clientFn()
			if err != nil {
				return fmt.Errorf("create client: %w", err)
			}
			res, err := client.IgnoreDriftedField(ctx, connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
				Namespace:         nsFn(),
				Name:              args[0],
				Group:             group,
				Kind:              kind,
				ResourceName:      resourceName,
				ResourceNamespace: resourceNamespace,
				JsonPointers:      fields,
				Reason:            reason,
				Remove:            remove,
			}))
			if err != nil {
				return fmt.Errorf("ignore-diff %s: %w", verb, friendlyError(err))
			}
			return writeIgnoreRules(cmd.OutOrStdout(), *output, res.Msg)
		},
	}
	cmd.Flags().StringVar(&kind, "kind", "", "Resource kind the rule scopes to (required)")
	cmd.Flags().StringVar(&group, "group", "", "API group to scope to (empty = all groups with that kind)")
	cmd.Flags().StringVar(&resourceName, "resource-name", "", "Specific resource name (empty = every matching kind)")
	cmd.Flags().StringVar(&resourceNamespace, "resource-namespace", "", "Specific resource namespace")
	cmd.Flags().StringArrayVar(&fields, "field", nil, "JSON pointer to ignore (repeatable, e.g. /spec/replicas)")
	cmd.Flags().StringVar(&reason, "reason", "", "Reason recorded on the rule's audit metadata")
	return cmd
}

// parseResourceSelectors turns --resource strings into ResourceSelectors.
// Accepted forms, matching `argocd app sync --resource` conventions:
//
//	KIND/NAME                  e.g. deployment/web
//	GROUP:KIND:NAME            e.g. apps:Deployment:web
//	GROUP:KIND:NAMESPACE:NAME  e.g. apps:Deployment:prod:web
//
// defaultNS fills the selector namespace when the selector itself doesn't
// carry one (the server falls back to the release namespace when empty).
func parseResourceSelectors(raw []string, defaultNS string) ([]*paprikav1.ResourceSelector, error) {
	out := make([]*paprikav1.ResourceSelector, 0, len(raw))
	for _, r := range raw {
		sel, err := parseResourceSelector(r)
		if err != nil {
			return nil, err
		}
		if sel.Namespace == "" {
			sel.Namespace = defaultNS
		}
		out = append(out, sel)
	}
	return out, nil
}

func parseResourceSelector(s string) (*paprikav1.ResourceSelector, error) {
	if strings.Contains(s, "/") {
		kind, name, err := splitKindName(s)
		if err != nil {
			return nil, err
		}
		return &paprikav1.ResourceSelector{Kind: kind, Name: name}, nil
	}
	parts := strings.Split(s, ":")
	switch len(parts) {
	case 3:
		return &paprikav1.ResourceSelector{Group: parts[0], Kind: parts[1], Name: parts[2]}, nil
	case 4:
		return &paprikav1.ResourceSelector{Group: parts[0], Kind: parts[1], Namespace: parts[2], Name: parts[3]}, nil
	default:
		return nil, fmt.Errorf("invalid --resource %q — expected KIND/NAME, GROUP:KIND:NAME, or GROUP:KIND:NAMESPACE:NAME", s)
	}
}

func splitKindName(s string) (kind, name string, err error) {
	parts := strings.SplitN(s, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("invalid resource %q — expected KIND/NAME", s)
	}
	return parts[0], parts[1], nil
}

func writeSyncResourcesResult(w io.Writer, output string, res *paprikav1.SyncResourcesResponse, confirmed bool) error {
	if output == outputJSON || output == outputYAML {
		return writeProtoOutput(w, output, res)
	}
	for _, u := range res.Unmatched {
		if err := writelnOut(w, fmt.Sprintf("unmatched selector: %s/%s %s/%s",
			u.Group, u.Kind, u.Namespace, u.Name)); err != nil {
			return err
		}
	}
	var msg string
	switch {
	case res.Accepted:
		msg = fmt.Sprintf("Sync accepted for %d resource(s)", res.SelectedCount)
	case res.DryRun:
		msg = fmt.Sprintf("Dry run: %d resource(s) would sync (re-run with --yes to execute)", res.SelectedCount)
	default:
		msg = "Sync was not accepted by the server"
	}
	return writelnOut(w, msg)
}

func writelnOut(w io.Writer, s string) error {
	if _, err := fmt.Fprintln(w, s); err != nil {
		return fmt.Errorf("write output: %w", err)
	}
	return nil
}

func writePatchResult(w io.Writer, output string, res *paprikav1.ApplyResourcePatchResponse) error {
	if output == outputJSON || output == outputYAML {
		return writeProtoOutput(w, output, res)
	}
	for _, block := range []string{res.Diff, prefixLine("Warning: ", res.Warning), patchTailLine(res)} {
		if block == "" {
			continue
		}
		if err := writelnOut(w, block); err != nil {
			return err
		}
	}
	return nil
}

func prefixLine(prefix, s string) string {
	if s == "" {
		return ""
	}
	return prefix + s
}

func patchTailLine(res *paprikav1.ApplyResourcePatchResponse) string {
	switch {
	case res.DryRun:
		return "Dry run only — re-run with --yes to apply"
	case res.Applied:
		return "Applied at " + time.UnixMilli(res.AppliedAtUnixMs).Format(time.RFC3339)
	}
	return ""
}

func writeIgnoreRules(w io.Writer, output string, res *paprikav1.IgnoreDriftedFieldResponse) error {
	if output == outputJSON || output == outputYAML {
		return writeProtoOutput(w, output, res)
	}
	if len(res.Rules) == 0 {
		return writelnOut(w, "No ignore-difference rules configured")
	}
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	dw := &detailWriter{tw: tw}
	dw.writeln("SCOPE\tFIELDS\tCREATED BY\tREASON")
	for _, rule := range res.Rules {
		dw.writef("%s\t%s\t%s\t%s\n", ignoreRuleScope(rule),
			strings.Join(rule.JsonPointers, ", "), rule.CreatedBy, rule.Reason)
	}
	if err := tw.Flush(); err != nil {
		return fmt.Errorf("write output: %w", err)
	}
	return dw.err
}

func ignoreRuleScope(rule *paprikav1.IgnoredFieldRule) string {
	scope := rule.Kind
	if rule.Group != "" {
		scope = rule.Group + "/" + rule.Kind
	}
	if rule.Namespace != "" || rule.Name != "" {
		scope += " " + rule.Namespace + "/" + rule.Name
	}
	return scope
}
