package utils

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Every executable used here is a temporary shell fixture. Restricting PATH
// to this directory ensures a regression cannot call the real cluster tools.
func fakeClusterTools(t *testing.T) (executed, probed string) {
	t.Helper()
	dir := t.TempDir()
	executed = filepath.Join(dir, "executed")
	probed = filepath.Join(dir, "probed")
	script := `#!/bin/sh
case "$*" in
  *"config current-context"*)
    printf '%s\n' "$*" >> "$FAKE_PROBED"
    case "$*" in
      *remote.kubeconfig*) printf '%s\n' "$FAKE_TARGET_CONTEXT" ;;
      *) printf '%s\n' "$FAKE_CONTEXT" ;;
    esac
    exit 0
    ;;
esac
printf '%s %s\n' "${0##*/}" "$*" >> "$FAKE_EXECUTED"
if [ "$1" = get ] && [ "$FAKE_LIST_FINALIZERS" = true ] && [ ! -f "$FAKE_LISTED" ]; then
  printf 'paprika-system fixture-release\n'
  printf 'listed\n' > "$FAKE_LISTED"
fi
`
	for _, binary := range []string{"kubectl", "helm", "make"} {
		path := filepath.Join(dir, binary)
		if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
			t.Fatal(err)
		}
		//nolint:gosec // owner-executable shell fixtures inside t.TempDir; no shared write access.
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("FAKE_EXECUTED", executed)
	t.Setenv("FAKE_PROBED", probed)
	t.Setenv("FAKE_LISTED", filepath.Join(dir, "listed"))
	t.Setenv("FAKE_CONTEXT", "kind-paprika-test-e2e")
	t.Setenv("FAKE_TARGET_CONTEXT", "kind-paprika-promotion-target")
	t.Setenv("FAKE_LIST_FINALIZERS", "")
	t.Setenv("E2E_EXPECTED_CONTEXT", "kind-paprika-test-e2e")
	t.Setenv("E2E_TARGET_EXPECTED_CONTEXT", "kind-paprika-promotion-target")
	for _, variable := range []string{"HELM_EXTRA_ARGS", "HELM_KUBECONTEXT", "HELM_KUBEAPISERVER", "HELM_KUBETOKEN", "HELM_KUBEASUSER", "HELM_KUBEASGROUPS",
		"HELM_KUBECAFILE", "HELM_KUBETLS_SERVER_NAME", "HELM_KUBEINSECURE_SKIP_TLS_VERIFY"} {
		t.Setenv(variable, "")
	}
	return executed, probed
}

func fakeToolLog(t *testing.T, path string) string {
	t.Helper()
	//nolint:gosec // path names only fixture-created logs in t.TempDir.
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func fakeClusterCommand(t *testing.T, tool string, args ...string) *exec.Cmd {
	t.Helper()
	//nolint:gosec // table-controlled arguments; fakeClusterTools restricts PATH to t.TempDir executables.
	return exec.CommandContext(t.Context(), tool, args...)
}

func TestClusterGuardAllowsOnlyConfirmedManagementOrRemoteContext(t *testing.T) {
	cases := []struct {
		name, tool, context, target string
		args                        []string
		allowed                     bool
	}{
		{"management", "kubectl", "kind-paprika-test-e2e", "", []string{"apply", "-f", "fixture.yaml"}, true},
		{"remote", "kubectl", "kind-paprika-test-e2e", "kind-paprika-promotion-target", []string{"--kubeconfig", "/fixture/remote.kubeconfig", "delete", "namespace", "fixture"}, true},
		{"production", "kubectl", "vke-production", "", []string{"patch", "release", "fixture"}, false},
		{"deephost", "kubectl", "kind-deephost", "", []string{"delete", "namespace", "fixture"}, false},
		{"unrelated-kind", "kubectl", "kind-other-project", "", []string{"apply", "-f", "fixture.yaml"}, false},
		{"unrelated-remote", "kubectl", "kind-paprika-test-e2e", "kind-other-project", []string{"--kubeconfig=/fixture/remote.kubeconfig", "delete", "namespace", "fixture"}, false},
		{"mismatched-context", "kubectl", "kind-paprika-test-e2e", "", []string{"--context=vke-production", "delete", "namespace", "fixture"}, false},
		{"last-context-wins", "kubectl", "kind-paprika-test-e2e", "", []string{"--context=vke-production", "--context=kind-paprika-test-e2e", "apply", "-f", "fixture.yaml"}, true},
		{"helm-management", "helm", "kind-paprika-test-e2e", "", []string{"upgrade", "fixture", "chart"}, true},
		{"helm-wrong-context", "helm", "kind-paprika-test-e2e", "", []string{"upgrade", "fixture", "chart", "--kube-context=vke-production"}, false},
		{"make-deploy", "make", "kind-paprika-test-e2e", "", []string{"deploy", "IMG=fixture:v1"}, true},
		{"exec-remote-command-flags", "kubectl", "kind-paprika-test-e2e", "", []string{"exec", "fixture", "--", "curl", "--user", "fixture-user", "https://service.invalid"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			executed, probed := fakeClusterTools(t)
			t.Setenv("FAKE_CONTEXT", tc.context)
			t.Setenv("FAKE_TARGET_CONTEXT", tc.target)
			_, err := Run(fakeClusterCommand(t, tc.tool, tc.args...))
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v, error=%v", tc.allowed, err)
			}
			if fakeToolLog(t, probed) == "" {
				t.Fatal("mutation was not preceded by a context probe")
			}
			if ran := fakeToolLog(t, executed) != ""; ran != tc.allowed {
				t.Fatalf("mutation executed=%v, allowed=%v", ran, tc.allowed)
			}
		})
	}
}

func TestClusterGuardRejectsTransportAndIdentityOverridesBeforeExecution(t *testing.T) {
	cases := []struct {
		name, tool string
		args       []string
	}{
		{"server-separated", "kubectl", []string{"--server", "https://other.invalid", "apply", "-f", "fixture.yaml"}},
		{"server-equals", "kubectl", []string{"delete", "namespace", "fixture", "--server=https://other.invalid"}},
		{"server-shorthand", "kubectl", []string{"-s", "https://other.invalid", "apply", "-f", "fixture.yaml"}},
		{"server-short-attached", "kubectl", []string{"-shttps://other.invalid", "delete", "namespace", "fixture"}},
		{"cluster", "kubectl", []string{"--cluster=vke", "delete", "namespace", "fixture"}},
		{"user", "kubectl", []string{"--user", "vke-admin", "patch", "release", "fixture"}},
		{"token", "kubectl", []string{"apply", "-f", "fixture.yaml", "--token=fixture-secret"}},
		{"client-key", "kubectl", []string{"apply", "-f", "fixture.yaml", "--client-key=/fixture/key"}},
		{"proxy", "kubectl", []string{"apply", "-f", "fixture.yaml", "--proxy-url=http://other.invalid"}},
		{"impersonation", "kubectl", []string{"apply", "-f", "fixture.yaml", "--as=vke-admin"}},
		{"helm-endpoint", "helm", []string{"--kube-apiserver", "https://other.invalid", "upgrade", "fixture", "chart"}},
		{"helm-token", "helm", []string{"upgrade", "fixture", "chart", "--kube-token=fixture-secret"}},
		{"helm-impersonation", "helm", []string{"upgrade", "fixture", "chart", "--kube-as-user=vke-admin"}},
		{"helm-ca", "helm", []string{"upgrade", "fixture", "chart", "--kube-ca-file=/fixture/ca"}},
		{"helm-tls-name", "helm", []string{"upgrade", "fixture", "chart", "--kube-tls-server-name=other.invalid"}},
		{"make-kubeconfig", "make", []string{"deploy", "KUBECONFIG=/fixture/other.kubeconfig"}},
		{"make-command", "make", []string{"deploy", "KUBECTL=kubectl --context=vke"}},
		{"make-helm-flags", "make", []string{"helm-deploy", "HELM_EXTRA_ARGS=--kube-apiserver=https://other.invalid"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			executed, probed := fakeClusterTools(t)
			_, err := Run(fakeClusterCommand(t, tc.tool, tc.args...))
			if err == nil {
				t.Fatal("override was accepted")
			}
			if strings.Contains(err.Error(), "fixture-secret") {
				t.Fatal("rejection exposed the credential value")
			}
			if fakeToolLog(t, executed) != "" || fakeToolLog(t, probed) != "" {
				t.Fatal("override must be rejected before any command runs")
			}
		})
	}
}

func TestClusterGuardRejectsHelmEnvironmentOverrides(t *testing.T) {
	for _, variable := range []string{"HELM_KUBEAPISERVER", "HELM_KUBETOKEN", "HELM_KUBEASUSER", "HELM_KUBEASGROUPS", "HELM_KUBECAFILE", "HELM_KUBETLS_SERVER_NAME", "HELM_KUBEINSECURE_SKIP_TLS_VERIFY"} {
		t.Run(variable, func(t *testing.T) {
			for _, tool := range []string{"helm", "make"} {
				t.Run(tool, func(t *testing.T) {
					executed, probed := fakeClusterTools(t)
					t.Setenv(variable, "fixture-secret")
					args := []string{"upgrade", "fixture", "chart"}
					if tool == "make" {
						args = []string{"helm-deploy"}
					}
					_, err := Run(fakeClusterCommand(t, tool, args...))
					if err == nil || !strings.Contains(err.Error(), variable) {
						t.Fatalf("expected %s rejection, got %v", variable, err)
					}
					if strings.Contains(err.Error(), "fixture-secret") {
						t.Fatal("rejection exposed the credential value")
					}
					if fakeToolLog(t, executed) != "" || fakeToolLog(t, probed) != "" {
						t.Fatal("environment override must be rejected before any command runs")
					}
				})
			}
		})
	}
}

func TestClusterGuardValidatesInheritedHelmContext(t *testing.T) {
	for _, tool := range []string{"helm", "make"} {
		t.Run(tool, func(t *testing.T) {
			for _, context := range []string{"kind-paprika-test-e2e", "vke-production"} {
				t.Run(context, func(t *testing.T) {
					executed, _ := fakeClusterTools(t)
					t.Setenv("HELM_KUBECONTEXT", context)
					args := []string{"upgrade", "fixture", "chart"}
					if tool == "make" {
						args = []string{"helm-deploy"}
					}
					_, err := Run(fakeClusterCommand(t, tool, args...))
					allowed := context == "kind-paprika-test-e2e"
					if (err == nil) != allowed || (fakeToolLog(t, executed) != "") != allowed {
						t.Fatalf("context=%s, allowed=%v, error=%v", context, allowed, err)
					}
				})
			}
		})
	}
}

func TestClusterGuardReadOnlyCommandsKeepTheirTargetingArguments(t *testing.T) {
	executed, probed := fakeClusterTools(t)
	t.Setenv("HELM_KUBETOKEN", "fixture-secret")
	for _, cmd := range []*exec.Cmd{
		fakeClusterCommand(t, "kubectl", "--server=https://other.invalid", "get", "nodes"),
		fakeClusterCommand(t, "helm", "template", "fixture", "chart"),
	} {
		if _, err := Run(cmd); err != nil {
			t.Fatal(err)
		}
	}
	if fakeToolLog(t, probed) != "" || len(strings.Split(strings.TrimSpace(fakeToolLog(t, executed)), "\n")) != 2 {
		t.Fatal("read-only commands must execute without mutation context probes")
	}
}

func TestStripFinalizersRechecksContextBeforePatching(t *testing.T) {
	for _, context := range []string{"kind-paprika-test-e2e", "vke-production"} {
		t.Run(context, func(t *testing.T) {
			executed, probed := fakeClusterTools(t)
			t.Setenv("FAKE_CONTEXT", context)
			t.Setenv("FAKE_LIST_FINALIZERS", "true")
			StripFinalizers("releases.pipelines.paprika.io")
			if fakeToolLog(t, probed) == "" {
				t.Fatal("finalizer patch must confirm context")
			}
			patched := strings.Contains(fakeToolLog(t, executed), "kubectl patch releases.pipelines.paprika.io fixture-release")
			if patched != (context == "kind-paprika-test-e2e") {
				t.Fatalf("context=%s patch executed=%v", context, patched)
			}
		})
	}
}
