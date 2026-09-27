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

// kubectl wrappers shared by every e2e suite (e2e, e2e_core, e2e_split).
// Keeping these tag-free lets the three suite files share one lifecycle
// vocabulary instead of re-inventing exec.Command("kubectl", ...) per spec.
package utils

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Kubectl runs kubectl and returns trimmed stdout.
func Kubectl(args ...string) (string, error) {
	return Run(exec.CommandContext(context.Background(), "kubectl", args...)) //nolint:gosec // test-controlled args
}

// ApplyManifest applies a manifest (JSON or YAML) via stdin. Multi-document
// YAML separated by "---" is allowed — kubectl parses it natively. The one
// shape rejected is unseparated JSON documents: kubectl treats a "{"-led
// stream as a single JSON doc and fails on trailing content, which produced
// opaque parse errors before. Split those into separate ApplyManifest calls.
func ApplyManifest(manifest string) (string, error) {
	for i, doc := range strings.Split(manifest, "\n---") {
		doc = strings.TrimSpace(strings.TrimPrefix(doc, "---"))
		if doc == "" {
			continue
		}
		if doc[0] == '{' {
			var v any
			if err := json.Unmarshal([]byte(doc), &v); err != nil {
				return "", fmt.Errorf("doc %d is not single-object JSON (unseparated JSON docs are rejected — split the applies): %w", i, err)
			}
		}
	}
	cmd := exec.CommandContext(context.Background(), "kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	return Run(cmd)
}

// ManifestID extracts kind/namespace/name from a single-object manifest for
// lifecycle tracking.
type ManifestID struct {
	Kind      string
	Namespace string
	Name      string
}

func ParseManifestID(manifest string) (ManifestID, error) {
	var doc struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(manifest), &doc); err != nil {
		return ManifestID{}, fmt.Errorf("parse manifest: %w", err)
	}
	if doc.Kind == "" || doc.Metadata.Name == "" {
		return ManifestID{}, errors.New("manifest lacks kind/name")
	}
	return ManifestID{Kind: doc.Kind, Namespace: doc.Metadata.Namespace, Name: doc.Metadata.Name}, nil
}

// DeleteNamed deletes a specific object; ignore-missing is the default.
// kubectl resolves lowercase singular kind names via discovery — avoids
// pluralization edge cases (Repository→repositories, ConftestPolicy→
// conftestpolicies).
func DeleteNamed(id ManifestID) error {
	args := []string{"delete", strings.ToLower(id.Kind), id.Name,
		"--ignore-not-found", "--timeout=60s"}
	if id.Namespace != "" {
		args = append(args, "-n", id.Namespace)
	}
	_, err := Kubectl(args...)
	return err
}

// DeleteByLabel deletes every object of each kind matching a selector — the
// "derived resources" sweep used by spec teardowns.
func DeleteByLabel(namespace, label string, kinds ...string) {
	for _, kind := range kinds {
		if _, err := Kubectl("delete", kind, "-n", namespace, "-l", label,
			"--ignore-not-found", "--timeout=30s"); err != nil {
			warnError(err)
		}
	}
}

// StripFinalizers removes all finalizers from every object of the given
// resource types across all namespaces. Use only in suite teardown, after
// the controllers that own those finalizers are gone.
func StripFinalizers(resources ...string) {
	// Multiple passes with a settling gap: resources deleted while
	// controllers were still draining can gain finalizers between sweeps.
	for pass := 0; pass < 3; pass++ {
		remaining := 0
		for _, rsrc := range resources {
			out, err := exec.CommandContext(context.Background(), "kubectl", "get", rsrc, "-A", //nolint:gosec // test-controlled args
				"-o", "jsonpath={range .items[*]}{.metadata.namespace} {.metadata.name}{\"\\n\"}{end}").Output()
			if err != nil {
				continue
			}
			for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				parts := strings.Fields(line)
				if len(parts) != 2 {
					continue
				}
				remaining++
				if err := exec.CommandContext(context.Background(), "kubectl", "patch", //nolint:gosec // test-controlled args
					rsrc, parts[1], "-n", parts[0],
					"--type=merge", "-p", `{"metadata":{"finalizers":[]}}`).Run(); err != nil {
					warnError(err)
				}
			}
		}
		if remaining == 0 {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// WaitAvailable waits for a workload's Available condition.
func WaitAvailable(namespace, kind, name string, timeout time.Duration) error {
	_, err := Kubectl("wait", "--for=condition=available", "-n", namespace,
		fmt.Sprintf("%s/%s", kind, name), fmt.Sprintf("--timeout=%ds", int(timeout.Seconds())))
	return err
}

// GetJSONPath returns the evaluated jsonpath for one object.
func GetJSONPath(namespace, resource, name, jsonpath string) (string, error) {
	args := []string{"get", resource, name, "-o", "jsonpath=" + jsonpath}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	return Kubectl(args...)
}

// GetJSONPathAll evaluates a jsonpath across all objects of a resource in a
// namespace (e.g. "{.items[*].metadata.name}").
func GetJSONPathAll(namespace, resource, jsonpath string) (string, error) {
	args := []string{"get", resource, "-o", "jsonpath=" + jsonpath}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	return Kubectl(args...)
}

// PortForward wraps a `kubectl port-forward` process with a defined stop.
type PortForward struct {
	Cmd    *exec.Cmd
	Stderr *strings.Builder
}

// StartPortForward begins forwarding local:remote to the given target
// (e.g. "deployment/foo" or "svc/bar") and returns once the process started.
// Callers should poll the local port for readiness.
func StartPortForward(namespace, target, mapping string) (*PortForward, error) {
	stderr := &strings.Builder{}
	cmd := exec.CommandContext(context.Background(), "kubectl", "port-forward", "-n", namespace, target, mapping) //nolint:gosec // test-controlled args
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("port-forward start: %w", err)
	}
	return &PortForward{Cmd: cmd, Stderr: stderr}, nil
}

// Stop kills the forward and returns any stderr the process produced.
func (p *PortForward) Stop() string {
	if p == nil || p.Cmd == nil || p.Cmd.Process == nil {
		return ""
	}
	if err := p.Cmd.Process.Kill(); err != nil {
		warnError(err)
	}
	if _, err := p.Cmd.Process.Wait(); err != nil && !strings.Contains(err.Error(), "killed") {
		warnError(err)
	}
	return p.Stderr.String()
}
