package workflows

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"sigs.k8s.io/yaml"
)

var (
	actionUsePattern = regexp.MustCompile(`(?m)^\s*uses:\s*[^@\s]+@([^\s#]+)`)
	digestRefPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$`)
)

func TestBuildPushProducesImmutableAMD64Metadata(t *testing.T) {
	workflow := readWorkflow(t, "build-push.yml")

	requireWorkflowFragments(t, workflow,
		"permissions:\n  contents: read\n  packages: write",
		"id: build",
		"platforms: linux/amd64",
		"ghcr.io/paprikacd/paprika:latest",
		"ghcr.io/paprikacd/paprika:sha-${{ github.sha }}",
		"${{ steps.build.outputs.digest }}",
		`docker buildx imagetools inspect "$image_ref"`,
		`.manifests[]?`,
		`.platform.os != "unknown"`,
		`$platforms[0].os == "linux"`,
		`$platforms[0].architecture == "amd64"`,
		`"repository": $repository`,
		`"commit_sha": $commit_sha`,
		`"digest": $digest`,
		`"platform": $platform`,
		`commit_sha='${{ github.sha }}'`,
		`--arg commit_sha "${commit_sha}"`,
		`keys == ["commit_sha", "digest", "platform", "repository"]`,
		`.repository == $repository`,
		`.commit_sha == $commit_sha`,
		`.platform == "linux/amd64"`,
		`test("^sha256:[0-9a-f]{64}$")`,
		`name: image-metadata-${{ github.sha }}`,
		"path: image-metadata.json",
	)
	require.NotContains(t, workflow, `"tags":`, "metadata must not contain mutable deployment tags")
	require.NotContains(t, workflow, `"token":`, "metadata must not contain credentials")
	assertActionsPinned(t, workflow)
}

func TestChartWorkflowRunsAdminDashboardIsolationGate(t *testing.T) {
	workflow := readWorkflow(t, "test-chart.yml")

	requireWorkflowFragments(t, workflow,
		"permissions: {}",
		"bash hack/test-admin-dashboard-helm.sh",
	)
	assertActionsPinned(t, workflow)
}

func TestUIWorkflowRunsBaseAndAdminFleetAcceptanceAndAlwaysUploadsEvidence(t *testing.T) {
	workflow := readWorkflow(t, "test.yml")
	harness := readRepoFile(t, "hack", "test-fleet-console.sh")

	requireWorkflowFragments(t, harness,
		`"e2e/fleet-console.spec.ts"`,
		`"e2e/fleet-responsive.spec.ts"`,
	)
	requireWorkflowFragments(t, workflow,
		"permissions: {}",
		"PAPRIKA_E2E_EXTRA_SPECS: e2e/fleet-admin-live.spec.ts",
		`PAPRIKA_E2E_ADMIN_SESSION_STUB: "1"`,
		"bash hack/test-fleet-console.sh",
		"if: ${{ always() }}",
		"ui/test-results/playwright-report",
		"ui/test-results/results.json",
	)
	assertActionsPinned(t, workflow)
}

func TestHelmDeploymentImageReferenceRequiresDigest(t *testing.T) {
	validDigest := strings.Repeat("a", 64)
	tests := []struct {
		name      string
		reference string
		wantError string
	}{
		{
			name:      "immutable repository digest",
			reference: "ghcr.io/paprikacd/paprika@sha256:" + validDigest,
		},
		{
			name:      "latest tag",
			reference: "ghcr.io/paprikacd/paprika:latest",
			wantError: "repository@sha256",
		},
		{
			name:      "commit discovery tag",
			reference: "ghcr.io/paprikacd/paprika:sha-deadbeef",
			wantError: "repository@sha256",
		},
		{
			name:      "digest with tag prefix",
			reference: "ghcr.io/paprikacd/paprika:sha-deadbeef@sha256:" + validDigest,
			wantError: "repository@sha256",
		},
		{
			name:      "short digest",
			reference: "ghcr.io/paprikacd/paprika@sha256:deadbeef",
			wantError: "repository@sha256",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateDigestOnlyImageReference(tt.reference)
			if tt.wantError == "" {
				require.NoError(t, err)
				return
			}
			require.ErrorContains(t, err, tt.wantError)
		})
	}
}

func validateDigestOnlyImageReference(reference string) error {
	if !digestRefPattern.MatchString(reference) {
		return fmt.Errorf("image reference %q must be repository@sha256:<64 lowercase hex characters>", reference)
	}
	return nil
}

func readWorkflow(t *testing.T, name string) string {
	t.Helper()
	workflow := readRepoFile(t, ".github", "workflows", name)

	var parsed any
	require.NoError(t, yaml.Unmarshal([]byte(workflow), &parsed), "%s must be valid YAML", name)
	return workflow
}

func readRepoFile(t *testing.T, parts ...string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	require.True(t, ok, "resolve workflow test location")
	pathParts := append([]string{filepath.Dir(currentFile), "..", ".."}, parts...)
	content, err := os.ReadFile(filepath.Clean(filepath.Join(pathParts...)))
	require.NoError(t, err)
	return string(content)
}

func requireWorkflowFragments(t *testing.T, workflow string, fragments ...string) {
	t.Helper()
	for _, fragment := range fragments {
		require.Contains(t, workflow, fragment)
	}
}

func assertActionsPinned(t *testing.T, workflow string) {
	t.Helper()
	matches := actionUsePattern.FindAllStringSubmatch(workflow, -1)
	require.NotEmpty(t, matches, "workflow must use at least one action")
	for _, match := range matches {
		require.Regexp(t, `^[0-9a-f]{40}$`, match[1], "third-party actions must be pinned to full commit SHAs")
	}
}
