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

// Package utils provides test utilities for Paprika e2e tests.
package utils

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2" //nolint:staticcheck // dot-import for Ginkgo table tests
)

const (
	certmanagerVersion = "v1.14.7"
	certmanagerURLTmpl = "https://github.com/cert-manager/cert-manager/releases/download/%s/cert-manager.yaml"

	defaultKindBinary = "kind"
)

func warnError(err error) {
	if _, werr := fmt.Fprintf(GinkgoWriter, "warning: %v\n", err); werr != nil {
		fmt.Println("warning:", err)
	}
}

// Run executes the provided command within this context
func Run(cmd *exec.Cmd) (string, error) {
	dir, dirErr := GetProjectDir()
	if dirErr != nil {
		return "", fmt.Errorf("get project dir: %w", dirErr)
	}
	cmd.Dir = dir

	if err := os.Chdir(cmd.Dir); err != nil {
		warnError(fmt.Errorf("chdir dir: %w", err))
	}

	cmd.Env = append(os.Environ(), "GO111MODULE=on")
	if err := verifyE2EClusterMutation(cmd); err != nil {
		return "", err
	}
	command := strings.Join(cmd.Args, " ")
	if _, err := fmt.Fprintf(GinkgoWriter, "running: %q\n", command); err != nil {
		warnError(err)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%q failed with error %q: %w", command, string(output), err)
	}

	return string(output), nil
}

// verifyE2EClusterMutation keeps suite setup, fixtures, and teardown on their
// dedicated Kind clusters even when the caller's normal kubeconfig is VKE.
func verifyE2EClusterMutation(cmd *exec.Cmd) error {
	name, args := filepath.Base(cmd.Path), cmd.Args[1:]
	if !isClusterMutation(name, args) {
		return nil
	}
	if err := rejectE2EClusterOverrides(name, args); err != nil {
		return err
	}
	kubeconfig := commandFlagValue(args, "--kubeconfig")
	current, err := confirmedE2EContext(cmd, kubeconfig)
	if err != nil {
		return err
	}
	if err := verifyExpectedE2EContext(current, kubeconfig); err != nil {
		return err
	}
	return verifyExplicitE2EContext(name, args, current)
}

func confirmedE2EContext(cmd *exec.Cmd, kubeconfig string) (string, error) {
	probeArgs := []string{}
	if kubeconfig != "" {
		probeArgs = append(probeArgs, "--kubeconfig", kubeconfig)
	}
	probeArgs = append(probeArgs, "config", "current-context")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	//nolint:gosec // fixed kubectl read; kubeconfig path is supplied by the dedicated test fixture.
	probe := exec.CommandContext(ctx, "kubectl", probeArgs...)
	probe.Dir, probe.Env = cmd.Dir, cmd.Env
	output, err := probe.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("refusing e2e cluster mutation: cannot confirm kubectl context: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

func expectedE2EContext() string {
	if expected := os.Getenv("E2E_EXPECTED_CONTEXT"); expected != "" {
		return expected
	}
	cluster := os.Getenv("E2E_KIND_CLUSTER")
	if cluster == "" {
		cluster = os.Getenv("KIND_CLUSTER")
	}
	if cluster == "" {
		return ""
	}
	return "kind-" + cluster
}

func verifyExpectedE2EContext(current, kubeconfig string) error {
	if !safeE2EContext(current) {
		return fmt.Errorf("refusing e2e cluster mutation on context %q: a dedicated Kind context is required", current)
	}
	expected := expectedE2EContext()
	// Explicit fixture configs may select only the management cluster or its
	// known promotion target, never an arbitrary Kind context.
	if kubeconfig != "" && current != expected {
		targetExpected := os.Getenv("E2E_TARGET_EXPECTED_CONTEXT")
		if targetExpected == "" {
			targetExpected = "kind-paprika-promotion-target"
		}
		if current != targetExpected {
			return fmt.Errorf("refusing e2e cluster mutation: explicit kubeconfig context %q does not match %q or %q", current, expected, targetExpected)
		}
		return nil
	}
	if expected != "" && current != expected {
		return fmt.Errorf("refusing e2e cluster mutation on context %q: expected %q", current, expected)
	}
	return nil
}

func verifyExplicitE2EContext(name string, args []string, current string) error {
	contextFlag := "--context"
	if name == "helm" {
		contextFlag = "--kube-context"
	}
	if explicit := commandFlagValue(args, contextFlag); explicit != "" && explicit != current {
		return fmt.Errorf("refusing e2e cluster mutation: %s=%q differs from confirmed context %q", contextFlag, explicit, current)
	}
	if !slices.Contains([]string{"helm", "make"}, name) {
		return nil
	}
	if explicit := os.Getenv("HELM_KUBECONTEXT"); explicit != "" && explicit != current {
		return fmt.Errorf("refusing e2e Helm mutation: HELM_KUBECONTEXT=%q differs from confirmed context %q", explicit, current)
	}
	return nil
}

// Context selection is the only supported transport/identity selection for
// mutating test commands. Server, credential, and impersonation overrides do
// not change current-context, so its confirmation cannot authorize them.
func rejectE2EClusterOverrides(name string, args []string) error {
	if flag := e2eClusterOverrideFlag(name, args); flag != "" {
		return fmt.Errorf("refusing e2e cluster mutation: %s overrides the confirmed context's transport or identity", flag)
	}
	if slices.Contains([]string{"helm", "make"}, name) {
		if err := rejectHelmEnvironmentOverrides(); err != nil {
			return err
		}
	}
	if name == "make" {
		return rejectMakeClusterOverrides(args)
	}
	return nil
}

func e2eClusterOverrideFlag(name string, args []string) string {
	flags := map[string][]string{
		"kubectl": {"--server", "-s", "--cluster", "--user", "--token", "--username", "--password",
			"--client-certificate", "--client-key", "--certificate-authority", "--insecure-skip-tls-verify",
			"--tls-server-name", "--proxy-url", "--as", "--as-group", "--as-uid", "--as-user-extra", "--kuberc"},
		"helm": {"--kube-apiserver", "--kube-token", "--kube-as-user", "--kube-as-group",
			"--kube-ca-file", "--kube-insecure-skip-tls-verify", "--kube-tls-server-name"},
	}
	for _, arg := range args {
		if arg == "--" {
			break // kubectl exec's subsequent arguments belong to the remote command.
		}
		for _, flag := range flags[name] {
			if e2eArgumentOverridesFlag(arg, flag) {
				return flag
			}
		}
	}
	return ""
}

func e2eArgumentOverridesFlag(arg, flag string) bool {
	if arg == flag || strings.HasPrefix(arg, flag+"=") {
		return true
	}
	return flag == "-s" && strings.HasPrefix(arg, "-s") && !strings.HasPrefix(arg, "--")
}

func rejectHelmEnvironmentOverrides() error {
	for _, variable := range []string{"HELM_KUBEAPISERVER", "HELM_KUBETOKEN", "HELM_KUBEASUSER", "HELM_KUBEASGROUPS",
		"HELM_KUBECAFILE", "HELM_KUBETLS_SERVER_NAME", "HELM_KUBEINSECURE_SKIP_TLS_VERIFY"} {
		if os.Getenv(variable) != "" {
			return fmt.Errorf("refusing e2e cluster mutation: %s overrides the confirmed context's transport or identity", variable)
		}
	}
	return nil
}

func rejectMakeClusterOverrides(args []string) error {
	// Make's nested tools must inherit the kubeconfig that the guard confirmed.
	for _, arg := range args {
		variable, _, assigned := strings.Cut(arg, "=")
		if assigned && makeVariableOverridesCluster(variable) {
			return fmt.Errorf("refusing e2e cluster mutation: Make variable %s overrides cluster targeting", variable)
		}
	}
	if os.Getenv("HELM_EXTRA_ARGS") != "" {
		return errors.New("refusing e2e cluster mutation: HELM_EXTRA_ARGS overrides nested Helm arguments")
	}
	return nil
}

func makeVariableOverridesCluster(variable string) bool {
	return slices.Contains([]string{"KUBECONFIG", "KUBECTL", "HELM", "HELM_EXTRA_ARGS"}, variable) || strings.HasPrefix(variable, "HELM_KUBE")
}

func safeE2EContext(context string) bool {
	return strings.HasPrefix(context, "kind-") && context != "kind-deephost"
}

func commandFlagValue(args []string, flag string) string {
	var value string
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			value = args[i+1]
		}
		if strings.HasPrefix(arg, flag+"=") {
			value = strings.TrimPrefix(arg, flag+"=")
		}
	}
	return value
}

func isClusterMutation(name string, args []string) bool {
	switch name {
	case "make":
		return makeTargetsMutateCluster(args)
	case "helm":
		return slices.Contains([]string{"install", "upgrade", "uninstall", "delete", "rollback", "test"}, clusterCommandVerb(args))
	case "kubectl":
		return kubectlMutatesCluster(clusterCommandVerb(args), args)
	default:
		return false
	}
}

func makeTargetsMutateCluster(args []string) bool {
	for _, arg := range args {
		for _, target := range []string{"install", "deploy", "undeploy", "uninstall", "helm-deploy"} {
			if arg == target || strings.HasPrefix(arg, target+"-") {
				return true
			}
		}
	}
	return false
}

func kubectlMutatesCluster(verb string, args []string) bool {
	readOnly := []string{"get", "describe", "logs", "api-resources", "api-versions", "version", "wait", "top", "explain", "cluster-info", "kustomize", "port-forward", "proxy", "config", "auth", "completion"}
	if slices.Contains(readOnly, verb) {
		return false
	}
	if verb == "rollout" {
		for _, arg := range args {
			if slices.Contains([]string{"restart", "undo", "pause", "resume"}, arg) {
				return true
			}
		}
		return false
	}
	// Unknown verbs, including exec/cp, may change target state.
	return true
}

func clusterCommandVerb(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
		if strings.Contains(arg, "=") {
			continue
		}
		switch arg {
		case "--kubeconfig", "--context", "--kube-context", "-n", "--namespace", "-s", "--server", "--token", "--user", "--cluster", "--as", "--as-group", "--request-timeout", "-v", "--v", "--kube-apiserver", "--kube-token", "--kube-as-user", "--kube-as-group", "--kube-ca-file", "--kube-tls-server-name":
			i++
		}
	}
	return ""
}

// UninstallCertManager uninstalls the cert manager
func UninstallCertManager() {
	url := fmt.Sprintf(certmanagerURLTmpl, certmanagerVersion)
	//nolint:gosec,noctx // test utility executing kubectl commands
	cmd := exec.Command("kubectl", "delete", "-f", url)
	if _, err := Run(cmd); err != nil {
		warnError(err)
	}

	// Delete leftover leases in kube-system (not cleaned by default)
	kubeSystemLeases := []string{
		"cert-manager-cainjector-leader-election",
		"cert-manager-controller",
	}
	for _, lease := range kubeSystemLeases {
		//nolint:gosec,noctx // test utility executing kubectl commands
		cmd = exec.Command("kubectl", "delete", "lease", lease,
			"-n", "kube-system", "--ignore-not-found", "--force", "--grace-period=0")
		if _, err := Run(cmd); err != nil {
			warnError(err)
		}
	}
}

// InstallCertManager installs the cert manager bundle.
func InstallCertManager() error {
	url := fmt.Sprintf(certmanagerURLTmpl, certmanagerVersion)
	//nolint:gosec,noctx // test utility executing kubectl commands
	cmd := exec.Command("kubectl", "apply", "-f", url)
	if _, err := Run(cmd); err != nil {
		return err
	}
	// Wait for cert-manager-webhook to be ready, which can take time if cert-manager
	// was re-installed after uninstalling on a cluster.
	//nolint:noctx // test utility executing kubectl commands
	cmd = exec.Command("kubectl", "wait", "deployment.apps/cert-manager-webhook",
		"--for", "condition=Available",
		"--namespace", "cert-manager",
		"--timeout", "5m",
	)

	_, err := Run(cmd)
	return err
}

// IsCertManagerCRDsInstalled checks if any Cert Manager CRDs are installed
// by verifying the existence of key CRDs related to Cert Manager.
func IsCertManagerCRDsInstalled() bool {
	// List of common Cert Manager CRDs
	certManagerCRDs := []string{
		"certificates.cert-manager.io",
		"issuers.cert-manager.io",
		"clusterissuers.cert-manager.io",
		"certificaterequests.cert-manager.io",
		"orders.acme.cert-manager.io",
		"challenges.acme.cert-manager.io",
	}

	// Execute the kubectl command to get all CRDs
	//nolint:noctx // test utility executing kubectl commands
	cmd := exec.Command("kubectl", "get", "crds")
	output, err := Run(cmd)
	if err != nil {
		return false
	}

	// Check if any of the Cert Manager CRDs are present
	crdList := GetNonEmptyLines(output)
	for _, crd := range certManagerCRDs {
		for _, line := range crdList {
			if strings.Contains(line, crd) {
				return true
			}
		}
	}

	return false
}

// LoadImageToKindClusterWithName loads a local docker image to the specified kind cluster.
// It first tries `kind load docker-image`; if that fails (e.g. due to containerd lease
// issues with Docker Desktop), it falls back to `docker save` + `kind load image-archive`.
func LoadImageToKindClusterWithName(name, cluster string) error {
	kindBinary := defaultKindBinary
	if v, ok := os.LookupEnv("KIND"); ok {
		kindBinary = v
	}

	//nolint:gosec,noctx // test utility executing kind commands
	cmd := exec.Command(kindBinary, "load", "docker-image", name, "--name", cluster)
	if _, err := Run(cmd); err == nil {
		return nil
	}

	tmpTar, err := os.CreateTemp("", "kind-image-*.tar")
	if err != nil {
		return fmt.Errorf("create temporary image tar: %w", err)
	}
	tarPath := tmpTar.Name()
	if cerr := tmpTar.Close(); cerr != nil {
		return fmt.Errorf("close temporary image tar: %w", cerr)
	}
	//nolint:errcheck // best-effort temporary file cleanup
	defer func() { _ = os.Remove(tarPath) }()

	//nolint:gosec,noctx // test utility executing docker commands
	saveCmd := exec.Command("docker", "save", "-o", tarPath, name)
	if _, saveErr := Run(saveCmd); saveErr != nil {
		return fmt.Errorf("save docker image %q to tar: %w", name, saveErr)
	}

	//nolint:gosec,noctx // test utility executing kind commands
	cmd = exec.Command(kindBinary, "load", "image-archive", tarPath, "--name", cluster)
	_, err = Run(cmd)
	return err
}

// GetNonEmptyLines converts given command output string into individual objects
// according to line breakers, and ignores the empty elements in it.
func GetNonEmptyLines(output string) []string {
	var res []string
	elements := strings.SplitSeq(output, "\n")
	for element := range elements {
		if element != "" {
			res = append(res, element)
		}
	}

	return res
}

// GetProjectDir will return the directory where the project is
func GetProjectDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return wd, fmt.Errorf("failed to get current working directory: %w", err)
	}
	wd = strings.ReplaceAll(wd, "/test/e2e", "")
	return wd, nil
}

// UncommentCode searches for target in the file and remove the comment prefix
// of the target content. The target content may span multiple lines.
func UncommentCode(filename, target, prefix string) error {
	content, err := os.ReadFile(filename) // #nosec G304 -- test utility
	if err != nil {
		return fmt.Errorf("failed to read file %q: %w", filename, err)
	}

	idx := bytes.Index(content, []byte(target))
	if idx < 0 {
		return fmt.Errorf("unable to find the code %q to be uncommented", target)
	}

	out, err := buildUncommentedContent(content, idx, target, prefix)
	if err != nil {
		return err
	}

	if err := os.WriteFile(filename, out.Bytes(), 0o600); err != nil {
		return fmt.Errorf("failed to write file %q: %w", filename, err)
	}

	return nil
}

func buildUncommentedContent(content []byte, idx int, target, prefix string) (*bytes.Buffer, error) {
	out := new(bytes.Buffer)
	if _, err := out.Write(content[:idx]); err != nil {
		return nil, fmt.Errorf("failed to write to output: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewBufferString(target))
	if !scanner.Scan() {
		return out, nil
	}

	if err := writeUncommentedLines(out, scanner, prefix); err != nil {
		return nil, err
	}

	if _, err := out.Write(content[idx+len(target):]); err != nil {
		return nil, fmt.Errorf("failed to write to output: %w", err)
	}
	return out, nil
}

func writeUncommentedLines(out *bytes.Buffer, scanner *bufio.Scanner, prefix string) error {
	for {
		if _, err := out.WriteString(strings.TrimPrefix(scanner.Text(), prefix)); err != nil {
			return fmt.Errorf("failed to write to output: %w", err)
		}
		// Avoid writing a newline in case the previous line was the last in target.
		if !scanner.Scan() {
			return nil
		}
		if _, err := out.WriteString("\n"); err != nil {
			return fmt.Errorf("failed to write to output: %w", err)
		}
	}
}
