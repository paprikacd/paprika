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

func TestDeployVKEFleetAdminGate(t *testing.T) {
	workflow := readWorkflow(t, "deploy-vke.yml")
	values := readRepoFile(t, "deploy", "test-values.yaml")
	operatorDocs := readRepoFile(t, "docs", "testing", "fleet-admin-dashboard.md")

	t.Run("accepts only an exact triggering build or explicit immutable manual inputs", func(t *testing.T) {
		requireWorkflowFragments(t, workflow,
			"commit_sha:",
			"digest:",
			"build_run_id:",
			"required: true",
			`github.event.workflow_run.head_repository.full_name == github.repository`,
			`github.event.workflow_run.head_branch == 'master'`,
			`github.event.workflow_run.conclusion == 'success'`,
			`github.event.workflow_run.head_sha`,
			`github.event.workflow_run.id`,
			`name: image-metadata-${{ steps.source.outputs.commit_sha }}`,
			`run-id: ${{ steps.source.outputs.build_run_id }}`,
			`ref: ${{ steps.source.outputs.commit_sha }}`,
			`fetch-depth: 0`,
			`git rev-parse HEAD`,
			`refs/remotes/origin/master`,
			`git merge-base --is-ancestor "${COMMIT_SHA}" refs/remotes/origin/master`,
			`gh api "/repos/${GITHUB_REPOSITORY}/actions/runs/${BUILD_RUN_ID}"`,
			`.name == "Build & Push"`,
			`.path == ".github/workflows/build-push.yml"`,
			`.event == "push"`,
			`.head_branch == "master"`,
			`.head_sha == $commit_sha`,
			`.status == "completed"`,
			`.conclusion == "success"`,
			`.repository.full_name == $repository`,
			`.head_repository.full_name == $repository`,
			`keys == ["commit_sha", "digest", "platform", "repository"]`,
			`.repository == $repository`,
			`.commit_sha == $commit_sha`,
			`.platform == "linux/amd64"`,
			`($manual_digest == "" or .digest == $manual_digest)`,
			`test("^sha256:[0-9a-f]{64}$")`,
		)
		require.NotContains(t, workflow, "inputs.ref")
		require.NotContains(t, workflow, "IMAGE_TAG")
		require.NotContains(t, workflow, "retain_cluster")
		require.NotContains(t, workflow, "Create equivalent manual metadata")
		requireWorkflowOrdering(t, workflow,
			"Verify checked-out commit is on trusted master history",
			"Validate exact Build & Push run",
			"Download exact build metadata",
			"Setup Docker buildx for immutable inspection",
			"Setup Go",
			"Install browser gate dependencies",
			"Configure Kubernetes OIDC access",
			"Deploy every enabled component with one immutable image",
		)
	})

	t.Run("reinspects outer and amd64 runtime digests before constructing one digest reference", func(t *testing.T) {
		requireWorkflowFragments(t, workflow,
			`docker buildx imagetools inspect "$IMAGE_REF"`,
			`--format '{{json .Manifest}}'`,
			`--format '{{json .Image}}'`,
			`.platform.os != "unknown"`,
			`.platform.os == "linux"`,
			`.platform.architecture == "amd64"`,
			`.os == "linux" and .architecture == "amd64"`,
			`RUNTIME_DIGEST`,
			`ghcr.io/paprikacd/paprika@${DIGEST}`,
		)
		require.NotContains(t, workflow, "ghcr.io/paprikacd/paprika:${{")
	})

	t.Run("captures a real prior revision and performs one atomic all-component upgrade", func(t *testing.T) {
		requireWorkflowFragments(t, workflow,
			"helm status",
			"helm history",
			`helm list --all --namespace "${VKE_NAMESPACE}"`,
			`--filter "^${HELM_RELEASE}$"`,
			`type == "array" and length == 0`,
			`cannot prove that the Helm release is absent`,
			`select(.status == "deployed")`,
			`PREVIOUS_REVISION`,
			`[[ "${PREVIOUS_REVISION}" =~ ^[1-9][0-9]*$ ]]`,
			"--set adminDashboard.enabled=true",
			`--set-string manager.image.repository="${IMAGE_REF}"`,
			`--set-string apiServer.image.repository="${IMAGE_REF}"`,
			`--set-string repoServer.image.repository="${IMAGE_REF}"`,
			`--set-string webhookReceiver.image.repository="${IMAGE_REF}"`,
			"--atomic",
			"--wait",
			"--timeout 5m",
		)
		require.NotContains(t, workflow, ".image.tag=")
		require.Contains(t, values, "deploy-vke.yml overrides every enabled component")
	})

	t.Run("gates runtime identity isolation and the real live browser harness", func(t *testing.T) {
		requireWorkflowFragments(t, workflow,
			`kubectl wait --for=condition=Available`,
			`/readyz`,
			`kubernetes.io/arch`,
			`imageID`,
			`RUNTIME_DIGEST`,
			`--admin-dashboard-enabled`,
			`PAPRIKA_ADMIN_EXPECTED_CONTAINER`,
			`["control-plane"] == "controller-manager"`,
			`select(has_admin(.)) | .name] ==`,
			`select(.name != $expected); unprivileged(.)`,
			`containerPort`,
			`EndpointSlice`,
			`HTTPRoute`,
			`Gateway`,
			`NetworkPolicy`,
			`if (.port | type) == "number" then`,
			`3001 < .port or 3001 > (.endPort // .port)`,
			`FLEET_ADMIN_KUBECONFIG`,
			`FLEET_ADMIN_CONTEXT`,
			`FLEET_ADMIN_TARGET_NAMESPACE`,
			`FLEET_ADMIN_TARGET_RELEASE`,
			`FLEET_ADMIN_PUBLIC_URL`,
			`FLEET_ADMIN_ARTIFACT_ROOT`,
			`node-version: "22"`,
			`bash hack/test-fleet-admin-dashboard.sh`,
		)
		require.NotContains(t, workflow, "node-version-file: ui/.nvmrc")
		require.Contains(t, operatorDocs, `"accessMode": "kubernetes-port-forward-admin"`)
		require.Contains(t, operatorDocs, `config current-context`)
		require.Contains(t, operatorDocs, `build run ID`)
		require.NotContains(t, operatorDocs, `"accessMode": "cluster-admin"`)
	})

	t.Run("always preserves sanitized evidence and recovers a failed post gate", func(t *testing.T) {
		requireWorkflowFragments(t, workflow,
			"Capture sanitized pre-upgrade evidence",
			"helm get values",
			"helm get manifest",
			"fleet_admin_redact_file",
			"if: ${{ always() }}",
			`name: fleet-admin-vke-${{ github.run_id }}-${{ github.run_attempt }}`,
			"helm rollback",
			`"${PREVIOUS_REVISION}"`,
			`--revision "${PREVIOUS_REVISION}"`,
			`restored manifest does not match PREVIOUS_REVISION`,
			`restored values do not match PREVIOUS_REVISION`,
			"helm uninstall",
			`cancel-in-progress: false`,
			`steps.previous.outcome == 'success'`,
			`steps.upgrade.outputs.mutation_started == 'true'`,
			`cancelled()`,
			`steps.upgrade.outcome != 'success'`,
			`steps.runtime.outcome != 'success'`,
			`steps.live.outcome != 'success'`,
			`echo "mutation_started=true"`,
			`release exists after recovery`,
			"Verify restored readiness and authentication",
			`normal unauthenticated`,
			`public unauthenticated`,
		)
		requiredCapture := workflowBetween(
			t,
			workflow,
			"          capture_pre_release_evidence() {",
			"          capture_release_evidence_best_effort() {",
		)
		requireWorkflowFragments(t, requiredCapture,
			"helm status",
			"helm history",
			"helm get values",
			"capture_manifest",
			"workloads.yaml",
			"pods.yaml",
			"images.txt",
			"readiness.txt",
			"events.json",
			"release positively absent",
		)
		require.NotContains(t, requiredCapture, "capture_optional")
		require.NotContains(t, requiredCapture, "|| true")
		require.Contains(t, workflow, `require_release_absent "${EVIDENCE_ROOT}/pre/helm-list.json"`)

		bestEffortCapture := workflowBetween(
			t,
			workflow,
			"          capture_release_evidence_best_effort() {",
			"          EVIDENCE_HELPERS",
		)
		require.Contains(t, bestEffortCapture, "|| true")
		require.Contains(t, workflow, `capture_pre_release_evidence "${EVIDENCE_ROOT}/pre"`)
		require.Contains(t, workflow, `capture_release_evidence_best_effort "${EVIDENCE_ROOT}/post"`)
		assertActionsPinned(t, workflow)
	})
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

func workflowBetween(t *testing.T, workflow, start, end string) string {
	t.Helper()
	startIndex := strings.Index(workflow, start)
	require.NotEqual(t, -1, startIndex, "workflow section start is missing: %s", start)
	endIndex := strings.Index(workflow[startIndex+len(start):], end)
	require.NotEqual(t, -1, endIndex, "workflow section end is missing: %s", end)
	return workflow[startIndex : startIndex+len(start)+endIndex]
}

func requireWorkflowOrdering(t *testing.T, workflow string, fragments ...string) {
	t.Helper()
	lastIndex := -1
	for _, fragment := range fragments {
		index := strings.Index(workflow, fragment)
		require.Greater(t, index, lastIndex, "workflow fragment is missing or out of order: %s", fragment)
		lastIndex = index
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
