package cicontract

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type workflowFile struct {
	name     string
	document map[string]any
	triggers map[string]any
	jobs     map[string]any
}

type validationJobContract struct {
	id               string
	commands         []string
	workingDirectory string
}

type workflowRunStep struct {
	run              string
	workingDirectory string
	failureEnforcing bool
}

var pinnedActionRevisions = map[string]string{
	"actions/checkout":                   "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
	"actions/upload-artifact":            "bbbca2ddaa5d8feaa63e36b76fdaad77386f024f",
	"actions/setup-go":                   "4a3601121dd01d1626a1e23e37211e3254c1c06c",
	"actions/setup-node":                 "249970729cb0ef3589644e2896645e5dc5ba9c38",
	"azure/setup-helm":                   "59b1c81c6280f5abebb1fb1bc585696daa7dfb42",
	"docker/build-push-action":           "ca052bb54ab0790a636c9b5f226502c73d547a25",
	"docker/login-action":                "abd2ef45e78c5afb21d64d4ca52ee8550d9572c7",
	"docker/setup-buildx-action":         "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
	"google-github-actions/auth":         "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
	"google-github-actions/setup-gcloud": "aa5489c8933f4cc7a4f7d45035b3b1440c9c10db",
	"go-task/setup-task":                 "70f2430ad412f838533de8c0515c749ffb2b8bd3",
	"goreleaser/goreleaser-action":       "f06c13b6b1a9625abc9e6e439d9c05a8f2190e94",
	"peaceiris/actions-gh-pages":         "84c30a85c19949d7eee79c4ff27748b70285e453",
}

var localReusableWorkflowUses = map[string]map[string]string{
	"ci.yml": {
		"deploy-vke": "./.github/workflows/deploy-vke.yml",
	},
	"deploy-vke-manual.yml": {
		"deploy": "./.github/workflows/deploy-vke.yml",
	},
}

func TestWorkflowContract(t *testing.T) {
	t.Run("canonical CI triggers fast validation jobs in parallel", testCanonicalCIValidation)
	t.Run("canonical CI protects running master and keeps only the latest pending run", testCanonicalCIConcurrency)
	t.Run("canonical CI pins third-party actions", testCanonicalCIActionPins)
	t.Run("canonical CI bounds job runtime", testCanonicalCIJobTimeouts)
	t.Run("canonical CI validates the CLI release contract", testCLIReleaseContractJob)
	t.Run("canonical CI validates distribution entrypoints", testDistributionContractsJob)
	t.Run("generated drift detects stale and untracked output", testGeneratedDriftDetection)
	t.Run("publication is gated and exposes an immutable amd64 image digest", testPublication)
	t.Run("legacy image publisher is removed", testLegacyPublisherRemoved)
	t.Run("CI gates reusable VKE deployment on trusted published output", testCIDeployVKE)
	t.Run("VKE is callable only and has a trusted manual wrapper", testVKETriggers)
	t.Run("VKE callers propagate only the required deployment secrets", testVKESecretPropagation)
	t.Run("VKE checks out the trusted caller commit and selects an image digest", testVKEProvenance)
	t.Run("VKE validates the immutable image reference before privileged operations", testVKEImageValidation)
	t.Run("VKE deploy applies one immutable reference to every component", testVKEComponentImageReferences)
	t.Run("VKE post-deploy validation uses the race-free pod checker", testVKEPodConditionValidation)
	t.Run("downstream workflows pin third-party actions", testDownstreamActionPins)
	t.Run("downstream jobs bound their runtime", testDownstreamJobTimeouts)
	t.Run("tagged release is pinned and least privilege", testTaggedReleaseWorkflow)
	t.Run("privileged manual entrypoints use typed default-branch dispatch", testPrivilegedManualEntrypoints)
	t.Run("legacy deployments consume repository dispatch payload digests", testLegacyDeployments)
	t.Run("Helm publishing validates and renders before packaging", testHelmPublishing)
	t.Run("GitHub Pages publishing uses a trusted manual entrypoint", testGitHubPagesPublishing)
	t.Run("full e2e runs on a schedule and on demand", testE2ETriggers)
	t.Run("full e2e isolates application and demo build caches", testE2ECacheScopes)
	t.Run("full e2e verifies the Kind download", testE2EKindChecksum)
	t.Run("VKE chart values render the complete token exchange boundary", testGitHubActionsTokenExchangeChartWiring)
	t.Run("active workflows never target main", testNoMainBranchTargets)
}

func testCanonicalCIValidation(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	if got := scalarString(workflow.document["name"]); got != "CI" {
		t.Errorf("ci.yml workflow name = %q, want %q", got, "CI")
	}
	for _, event := range []string{"push", "pull_request"} {
		if _, ok := workflow.triggers[event]; !ok {
			t.Errorf("ci.yml must declare the %s trigger", event)
		}
	}
	push := requireMappingValue(t, workflow.triggers, "push", "ci.yml triggers")
	if branches := stringList(push["branches"]); !exactly(branches, "master") {
		t.Errorf("ci.yml push.branches = %v, want exactly [master]", branches)
	}

	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart", "release-contract", "distribution-contracts", "fleet-ui-smoke", "fleet-scale", "cluster-integration", "publish"} {
		if _, ok := workflow.jobs[jobID]; !ok {
			t.Errorf("ci.yml is missing required job ID %q", jobID)
		}
	}

	contracts := []validationJobContract{
		{id: "go-test", commands: []string{
			"make test-race",
			"bash hack/test-check-vke-pod-conditions.sh",
			"bash hack/test-github-actions-oidc-token.sh",
			"bash hack/test-github-actions-vke-token.sh",
		}},
		{id: "go-lint", commands: []string{"make lint-config", "make lint"}},
		{id: "ui", commands: []string{"npm ci", "npm test", "npm run lint", "npm run build"}, workingDirectory: "ui"},
		{id: "generated", commands: []string{"make generate-proto", "git diff --exit-code"}},
		{id: "chart", commands: []string{
			"bash hack/compare-helm-chart.sh --self-test",
			"helm lint charts/chart/",
			"helm template paprika charts/chart/",
			"helm template paprika charts/chart/ --values deploy/test-values.yaml",
		}},
		{id: "fleet-scale", commands: []string{"bash hack/test-fleet-scale.sh"}},
		{id: "cluster-integration", commands: []string{
			"kind create cluster --name paprika-ci-integration",
			"kind load docker-image \"${IMG}\" --name paprika-ci-integration",
			"bash hack/test-split-metrics.sh",
			"make helm-deploy",
			"make helm-status",
			"kubectl wait --for=condition=available deployment/paprika-controller-manager -n paprika-system --timeout=120s",
		}},
	}
	for _, contract := range contracts {
		assertValidationJob(t, workflow, contract)
	}

	fleetUI := validationJobContract{id: "fleet-ui-smoke"}
	assertValidationJob(t, workflow, fleetUI)
	fleetUIJob := requireMappingValue(t, workflow.jobs, fleetUI.id, "ci.yml jobs")
	for _, command := range []string{"npm ci", "npm run build", "npx playwright install --with-deps chromium", "npm run test:e2e -- fleet-console.spec.ts"} {
		if !hasRunCommand(fleetUIJob, command, "ui") {
			t.Errorf("ci.yml validation job %q must actively run exact command %q in ui and enforce its failure", fleetUI.id, command)
		}
	}
	if !hasRunCommand(fleetUIJob, "go build -o bin/fleet-console-fixture ./test/fleetconsole", "") {
		t.Errorf("ci.yml validation job %q must build the real fleet fixture", fleetUI.id)
	}
}

func testCanonicalCIConcurrency(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	concurrency := requireMappingValue(t, workflow.document, "concurrency", "ci.yml")
	if group := scalarString(concurrency["group"]); group != "ci-${{ github.workflow }}-${{ github.ref }}" {
		t.Errorf("ci.yml concurrency.group = %q, want the exact shared workflow/ref group", group)
	}
	if cancel := normalizeExpression(scalarString(concurrency["cancel-in-progress"])); cancel != "github.event_name == 'pull_request'" {
		t.Errorf("ci.yml concurrency.cancel-in-progress = %q after normalization, want exact PR-only cancellation so a running master deployment is never cancelled", cancel)
	}
	if queue, configured := concurrency["queue"]; configured {
		t.Errorf("ci.yml concurrency.queue = %q, want queue omitted so GitHub keeps its intentional newest-pending default", queue)
	}
}

func testCanonicalCIActionPins(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	assertWorkflowActionPins(t, workflow)
	assertLocalReusableWorkflowUses(t, workflow)
}

func testCanonicalCIJobTimeouts(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart", "release-contract", "distribution-contracts", "fleet-ui-smoke", "cluster-integration", "publish"} {
		job := requireMappingValue(t, workflow.jobs, jobID, "ci.yml jobs")
		timeout, ok := job["timeout-minutes"].(int)
		if !ok || timeout < 5 || timeout > 30 {
			t.Errorf("ci.yml job %q timeout-minutes = %v, want an integer from 5 through 30", jobID, job["timeout-minutes"])
		}
	}
	fleetScale := requireMappingValue(t, workflow.jobs, "fleet-scale", "ci.yml jobs")
	if timeout, ok := fleetScale["timeout-minutes"].(int); !ok || timeout != 90 {
		t.Errorf("ci.yml job %q timeout-minutes = %v, want exactly 90", "fleet-scale", fleetScale["timeout-minutes"])
	}
}

func testCLIReleaseContractJob(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	assertValidationJob(t, workflow, validationJobContract{id: "release-contract", commands: []string{
		"bash hack/test-cli-release-contract.sh",
		"bash hack/test-find-github-release.sh",
		"bash hack/test-verify-release-archives.sh",
		"goreleaser build --snapshot --clean --id cli",
	}})
	job := requireMappingValue(t, workflow.jobs, "release-contract", "ci.yml jobs")
	step := requireUsesStep(t, job, "goreleaser/goreleaser-action@", "ci.yml release-contract job")
	if got := scalarString(requireMappingValue(t, step, "with", "ci.yml GoReleaser install step")["version"]); got != "v2.16.0" {
		t.Errorf("ci.yml GoReleaser version = %q, want v2.16.0", got)
	}
	publish := requireMappingValue(t, workflow.jobs, "publish", "ci.yml jobs")
	if !contains(stringList(publish["needs"]), "release-contract") {
		t.Error("ci.yml publish job must need release-contract")
	}
}

func testDistributionContractsJob(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	assertValidationJob(t, workflow, validationJobContract{id: "distribution-contracts", commands: []string{
		"bash hack/test-cli-install.sh",
		"bash hack/test-taskfile-contract.sh",
		"bash hack/test-landing-install.sh",
	}})
	job := requireMappingValue(t, workflow.jobs, "distribution-contracts", "ci.yml jobs")
	setup := requireUsesStep(t, job, "go-task/setup-task@", "ci.yml distribution-contracts job")
	if got := scalarString(requireMappingValue(t, setup, "with", "ci.yml Task install step")["version"]); got != "3.52.0" {
		t.Errorf("ci.yml Task version = %q, want 3.52.0", got)
	}
	publish := requireMappingValue(t, workflow.jobs, "publish", "ci.yml jobs")
	if !contains(stringList(publish["needs"]), "distribution-contracts") {
		t.Error("ci.yml publish job must need distribution-contracts")
	}
}

func testGeneratedDriftDetection(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	generated := requireMappingValue(t, workflow.jobs, "generated", "ci.yml jobs")
	commands := []string{
		"command -v protoc-gen-go",
		"command -v protoc-gen-connect-go",
		"command -v ui/node_modules/.bin/protoc-gen-es",
		"command -v ui/node_modules/.bin/protoc-gen-connect-es",
		"rm -rf -- internal/api/paprika ui/src/gen",
		"make generate-proto",
		"git diff --exit-code",
		"git status --porcelain --untracked-files=all",
		`test -z "$(git status --porcelain --untracked-files=all)"`,
	}
	positions := make([]int, len(commands))
	for index, command := range commands {
		positions[index] = runCommandPosition(generated, command)
		if positions[index] < 0 {
			t.Errorf("ci.yml generated job must actively run exact command %q and enforce its failure", command)
		}
	}
	for index := 1; index < len(positions); index++ {
		if positions[index-1] >= 0 && positions[index] >= 0 && positions[index-1] >= positions[index] {
			t.Errorf("ci.yml generated commands must run in order; %q must precede %q", commands[index-1], commands[index])
		}
	}
}

func assertValidationJob(t *testing.T, workflow workflowFile, contract validationJobContract) {
	t.Helper()
	job, ok := workflow.jobs[contract.id].(map[string]any)
	if !ok {
		t.Errorf("ci.yml validation job %q must be a mapping", contract.id)
		return
	}
	if scalarString(job["runs-on"]) == "" {
		t.Errorf("ci.yml validation job %q must declare runs-on", contract.id)
	}
	if needs := stringList(job["needs"]); len(needs) != 0 {
		t.Errorf("ci.yml validation job %q must run in parallel without needs; got %v", contract.id, needs)
	}
	if !continueOnErrorSafe(job) {
		t.Errorf("ci.yml validation job %q continue-on-error must be absent or boolean false", contract.id)
	}
	if len(workflowRunSteps(job)) == 0 {
		t.Errorf("ci.yml validation job %q must declare structured run steps", contract.id)
	}

	for _, command := range contract.commands {
		if !hasRunCommand(job, command, contract.workingDirectory) {
			t.Errorf("ci.yml validation job %q must actively run exact command %q and enforce its failure", contract.id, command)
		}
	}
}

func assertWorkflowActionPins(t *testing.T, workflow workflowFile) {
	t.Helper()
	for jobID, value := range workflow.jobs {
		job, ok := value.(map[string]any)
		if !ok {
			continue
		}
		for index, value := range anyList(job["steps"]) {
			step, ok := value.(map[string]any)
			if !ok {
				continue
			}
			uses := scalarString(step["uses"])
			if uses == "" || strings.HasPrefix(uses, "./") {
				continue
			}
			action, revision, found := strings.Cut(uses, "@")
			wantRevision, allowed := pinnedActionRevisions[action]
			if !found || !allowed || revision != wantRevision {
				t.Errorf("%s job %q step %d uses %q, want an allowlisted action and exact revision", workflow.name, jobID, index+1, uses)
			}
		}
	}
}

func assertLocalReusableWorkflowUses(t *testing.T, workflow workflowFile) {
	t.Helper()
	wantUses := localReusableWorkflowUses[workflow.name]
	found := make(map[string]bool, len(wantUses))
	for jobID, value := range workflow.jobs {
		job, ok := value.(map[string]any)
		if !ok {
			continue
		}
		uses := scalarString(job["uses"])
		if uses == "" {
			continue
		}
		want, allowed := wantUses[jobID]
		if !allowed || uses != want || !strings.HasPrefix(uses, "./.github/workflows/") {
			t.Errorf("%s job %q uses %q, want an explicitly allowlisted local reusable workflow", workflow.name, jobID, uses)
			continue
		}
		found[jobID] = true
	}
	for jobID, want := range wantUses {
		if !found[jobID] {
			t.Errorf("%s job %q must use local reusable workflow %q", workflow.name, jobID, want)
		}
	}
}

func assertActionRevision(t *testing.T, workflow workflowFile, action, wantRevision string) {
	t.Helper()
	found := false
	for _, value := range workflow.jobs {
		job, ok := value.(map[string]any)
		if !ok {
			continue
		}
		for _, stepValue := range anyList(job["steps"]) {
			step, ok := stepValue.(map[string]any)
			if !ok {
				continue
			}
			uses := scalarString(step["uses"])
			gotAction, gotRevision, hasRevision := strings.Cut(uses, "@")
			if !hasRevision || gotAction != action {
				continue
			}
			found = true
			if gotRevision != wantRevision {
				t.Errorf("%s uses %s@%s, want revision %s", workflow.name, action, gotRevision, wantRevision)
			}
		}
	}
	if !found {
		t.Errorf("%s must use %s", workflow.name, action)
	}
}

func assertJobTimeout(t *testing.T, workflowName, jobID string, job map[string]any, minimum, maximum int) {
	t.Helper()
	timeout, ok := job["timeout-minutes"].(int)
	if !ok || timeout < minimum || timeout > maximum {
		t.Errorf("%s job %q timeout-minutes = %v, want an integer from %d through %d", workflowName, jobID, job["timeout-minutes"], minimum, maximum)
	}
}

func assertExactImageReferenceInput(t *testing.T, trigger map[string]any, context string) {
	t.Helper()
	inputs := requireMappingValue(t, trigger, "inputs", context)
	if got := sortedKeys(inputs); !exactly(got, "image_ref") {
		t.Errorf("%s inputs = %v, want exactly [image_ref]", context, got)
	}
	imageReference := requireMappingValue(t, inputs, "image_ref", context+" inputs")
	description := strings.ToLower(scalarString(imageReference["description"]))
	if !strings.Contains(description, "image") || !strings.Contains(description, "digest") {
		t.Errorf("%s image_ref description must mention an image digest; got %q", context, imageReference["description"])
	}
	if required, ok := imageReference["required"].(bool); !ok || !required {
		t.Errorf("%s image_ref.required = %v, want true", context, imageReference["required"])
	}
	if inputType := scalarString(imageReference["type"]); inputType != "string" {
		t.Errorf("%s image_ref.type = %q, want string", context, inputType)
	}
	if defaultValue, ok := imageReference["default"]; ok {
		t.Errorf("%s image_ref must not declare a default; got %q", context, defaultValue)
	}
}

func assertImageReferenceEnvironment(t *testing.T, job map[string]any, context, wantExpression string) {
	t.Helper()
	environment := requireMappingValue(t, job, "env", context)
	if got := normalizeExpression(scalarString(environment["IMAGE_REFERENCE"])); got != wantExpression {
		t.Errorf("%s env.IMAGE_REFERENCE = %q after normalization, want %s", context, got, wantExpression)
	}
	if _, mutableTag := environment["IMAGE_TAG"]; mutableTag {
		t.Errorf("%s must not declare IMAGE_TAG", context)
	}
}

func assertImageReferenceValidator(t *testing.T, job map[string]any, context string, privilegedStepNames []string) {
	t.Helper()
	const digestPattern = `^ghcr\.io/paprikacd/paprika@sha256:[0-9a-f]{64}$`
	validator, validatorIndex := requireNamedStepAt(t, job, "Validate image reference", context)
	run := scalarString(validator["run"])
	wantCondition := `if [[ ! "${IMAGE_REFERENCE}" =~ ` + digestPattern + ` ]]; then`
	if !containsActiveShellLine(run, wantCondition) {
		t.Errorf("%s validator must enforce exact digest grammar %q", context, digestPattern)
	}
	if !containsActiveShellFragment(run, "::error::") || !containsActiveShellLine(run, "exit 1") {
		t.Errorf("%s validator must fail clearly for an invalid image reference", context)
	}
	if !stepFailureEnforcing(validator) {
		t.Errorf("%s validator must be unconditional and failure-enforcing", context)
	}
	for _, stepName := range privilegedStepNames {
		_, index := requireNamedStepAt(t, job, stepName, context)
		if validatorIndex >= index {
			t.Errorf("%s must validate the image reference before %q", context, stepName)
		}
	}

	validatorPattern := regexp.MustCompile(digestPattern)
	validDigest := "ghcr.io/paprikacd/paprika@sha256:" + strings.Repeat("a", 64)
	if !validatorPattern.MatchString(validDigest) {
		t.Fatalf("contract digest validator unexpectedly rejects valid reference %q", validDigest)
	}
	invalidReferences := []string{
		"ghcr.io/paprikacd/paprika:latest",
		"sha-0123456789abcdef",
		"ghcr.io/other/paprika@sha256:" + strings.Repeat("a", 64),
		validDigest + ",manager.image.tag=latest",
		validDigest + " ",
		" " + validDigest,
		"ghcr.io/paprikacd/paprika@sha256:" + strings.Repeat("A", 64),
		"ghcr.io/paprikacd/paprika@sha256:" + strings.Repeat("a", 63),
	}
	for _, imageReference := range invalidReferences {
		if validatorPattern.MatchString(imageReference) {
			t.Errorf("contract digest validator must reject adversarial reference %q", imageReference)
		}
	}
}

func testPublication(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	publish := requireMappingValue(t, workflow.jobs, "publish", "ci.yml jobs")

	needs := stringList(publish["needs"])
	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart", "fleet-ui-smoke", "fleet-scale", "cluster-integration"} {
		if !contains(needs, jobID) {
			t.Errorf("ci.yml publish.needs = %v, want dependency on %q", needs, jobID)
		}
	}

	wantCondition := "github.event_name == 'push' && github.ref == 'refs/heads/master'"
	if condition := normalizeExpression(scalarString(publish["if"])); condition != wantCondition {
		t.Errorf("ci.yml publish.if = %q after normalization, want %q", condition, wantCondition)
	}

	if permission(workflow, publish, "packages") != "write" {
		t.Errorf("ci.yml publish job must have packages: write permission")
	}

	buildPush, ok := findFailureEnforcingUsesStep(publish, "docker/build-push-action@")
	if !ok {
		t.Fatal("ci.yml publish job must contain an unconditional docker/build-push-action step that enforces failure")
	}
	if id := scalarString(buildPush["id"]); id != "build-push" {
		t.Errorf("ci.yml docker/build-push-action step id = %q, want build-push", id)
	}
	outputs := requireMappingValue(t, publish, "outputs", "ci.yml publish job")
	if got := normalizeExpression(scalarString(outputs["digest"])); got != "steps.build-push.outputs.digest" {
		t.Errorf("ci.yml publish.outputs.digest = %q after normalization, want steps.build-push.outputs.digest", got)
	}
	with := requireMappingValue(t, buildPush, "with", "ci.yml docker/build-push-action step")
	if push, ok := with["push"].(bool); !ok || !push {
		t.Errorf("ci.yml docker/build-push-action with.push = %v, want true", with["push"])
	}
	if platforms := delimitedValues(with["platforms"]); !exactly(platforms, "linux/amd64") {
		t.Errorf("ci.yml docker/build-push-action platforms = %v, want exactly [linux/amd64]", platforms)
	}
	tags := delimitedValues(with["tags"])
	for _, tag := range []string{
		"ghcr.io/paprikacd/paprika:latest",
		"ghcr.io/paprikacd/paprika:sha-${{ github.sha }}",
	} {
		if !contains(tags, tag) {
			t.Errorf("ci.yml docker/build-push-action tags = %v, want %q", tags, tag)
		}
	}
}

func testCIDeployVKE(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	deploy := requireMappingValue(t, workflow.jobs, "deploy-vke", "ci.yml jobs")
	if needs := stringList(deploy["needs"]); !exactly(needs, "publish") {
		t.Errorf("ci.yml deploy-vke.needs = %v, want exactly [publish]", needs)
	}
	wantCondition := "github.event_name == 'push' && github.ref == 'refs/heads/master'"
	if condition := normalizeExpression(scalarString(deploy["if"])); condition != wantCondition {
		t.Errorf("ci.yml deploy-vke.if = %q after normalization, want %q", condition, wantCondition)
	}
	if uses := scalarString(deploy["uses"]); uses != "./.github/workflows/deploy-vke.yml" {
		t.Errorf("ci.yml deploy-vke.uses = %q, want local reusable VKE workflow", uses)
	}
	with := requireMappingValue(t, deploy, "with", "ci.yml deploy-vke job")
	wantImageReference := "ghcr.io/paprikacd/paprika@${{ needs.publish.outputs.digest }}"
	if imageReference := scalarString(with["image_ref"]); imageReference != wantImageReference {
		t.Errorf("ci.yml deploy-vke.with.image_ref = %q, want %q", imageReference, wantImageReference)
	}
	permissions := requireMappingValue(t, deploy, "permissions", "ci.yml deploy-vke job")
	if got := sortedKeys(permissions); len(got) != 2 || !contains(got, "contents") || !contains(got, "id-token") {
		t.Errorf("ci.yml deploy-vke permissions = %v, want exactly contents and id-token", got)
	}
	if scalarString(permissions["contents"]) != "read" || scalarString(permissions["id-token"]) != "write" {
		t.Errorf("ci.yml deploy-vke permissions = %v, want contents: read and id-token: write", permissions)
	}
	if _, hasSteps := deploy["steps"]; hasSteps {
		t.Error("ci.yml deploy-vke must call the reusable workflow instead of declaring steps")
	}
	if _, hasRunner := deploy["runs-on"]; hasRunner {
		t.Error("ci.yml deploy-vke reusable workflow call must not declare runs-on")
	}
}

func testLegacyPublisherRemoved(t *testing.T) {
	path := filepath.Join(repositoryRoot(t), ".github", "workflows", "build-push.yml")
	if _, err := os.Stat(path); err == nil {
		t.Error("build-push.yml must be removed so CI is the only image publisher")
	} else if !os.IsNotExist(err) {
		t.Fatalf("inspect build-push.yml: %v", err)
	}
}

func testVKETriggers(t *testing.T) {
	workflow := loadWorkflow(t, "deploy-vke.yml")
	if got := sortedKeys(workflow.triggers); !exactly(got, "workflow_call") {
		t.Errorf("deploy-vke.yml triggers = %v, want exactly workflow_call", got)
	}
	if _, exists := workflow.triggers["workflow_run"]; exists {
		t.Error("deploy-vke.yml must not expose a workflow_run trigger")
	}
	trigger := requireMappingValue(t, workflow.triggers, "workflow_call", "deploy-vke.yml triggers")
	assertExactImageReferenceInput(t, trigger, "deploy-vke.yml workflow_call")

	manual := loadWorkflow(t, "deploy-vke-manual.yml")
	assertExactRepositoryDispatch(t, manual, "deploy-vke")
	permissions := requireMappingValue(t, manual.document, "permissions", "deploy-vke-manual.yml")
	if got := sortedKeys(permissions); len(got) != 2 || scalarString(permissions["contents"]) != "read" || scalarString(permissions["id-token"]) != "write" {
		t.Errorf("deploy-vke-manual.yml permissions = %v, want exactly contents: read and id-token: write", permissions)
	}
	deploy := requireMappingValue(t, manual.jobs, "deploy", "deploy-vke-manual.yml jobs")
	with := requireMappingValue(t, deploy, "with", "deploy-vke-manual.yml deploy job")
	if got := normalizeExpression(scalarString(with["image_ref"])); got != "github.event.client_payload.image_ref" {
		t.Errorf("deploy-vke-manual.yml image_ref = %q after normalization, want github.event.client_payload.image_ref", got)
	}
	assertLocalReusableWorkflowUses(t, manual)
}

func testVKESecretPropagation(t *testing.T) {
	secretNames := []string{
		"VKE_AUTH_TOKEN_SECRET",
		"VKE_BASIC_PASSWORD_HASH",
		"VKE_OIDC_CLIENT_ID",
		"VKE_OIDC_CLIENT_SECRET",
	}

	reusable := loadWorkflow(t, "deploy-vke.yml")
	trigger := requireMappingValue(t, reusable.triggers, "workflow_call", "deploy-vke.yml triggers")
	declarations := requireMappingValue(t, trigger, "secrets", "deploy-vke.yml workflow_call")
	if got := sortedKeys(declarations); !sameStrings(got, secretNames) {
		t.Errorf("deploy-vke.yml workflow_call.secrets = %v, want exactly %v", got, secretNames)
	}
	for _, name := range secretNames {
		declaration := requireMappingValue(t, declarations, name, "deploy-vke.yml workflow_call secrets")
		if required, ok := declaration["required"].(bool); !ok || !required {
			t.Errorf("deploy-vke.yml workflow_call.secrets.%s.required = %v, want true", name, declaration["required"])
		}
	}

	callers := map[string]string{
		"ci.yml":                "deploy-vke",
		"deploy-vke-manual.yml": "deploy",
	}
	for workflowName, jobID := range callers {
		workflow := loadWorkflow(t, workflowName)
		job := requireMappingValue(t, workflow.jobs, jobID, workflowName+" jobs")
		secretMappings := requireMappingValue(t, job, "secrets", workflowName+" "+jobID+" job")
		if got := sortedKeys(secretMappings); !sameStrings(got, secretNames) {
			t.Errorf("%s %s.secrets = %v, want exactly %v", workflowName, jobID, got, secretNames)
		}
		for _, name := range secretNames {
			want := "secrets." + name
			if got := normalizeExpression(scalarString(secretMappings[name])); got != want {
				t.Errorf("%s %s.secrets.%s = %q after normalization, want %q", workflowName, jobID, name, got, want)
			}
		}
	}

	deploy := vkeDeployJob(t)
	step := requireNamedStep(t, deploy, "Deploy Paprika chart", "deploy-vke.yml deploy job")
	run := scalarString(step["run"])
	validationLines := []string{
		"missing=0",
		"for name in VKE_OIDC_CLIENT_ID VKE_OIDC_CLIENT_SECRET VKE_AUTH_TOKEN_SECRET VKE_BASIC_PASSWORD_HASH; do",
		`if [ -z "${!name:-}" ]; then`,
		`echo "::error::$name is required"`,
		"missing=1",
		`if [ "$missing" -ne 0 ]; then`,
		"exit 1",
	}
	for _, line := range validationLines {
		if !containsActiveShellLine(run, line) {
			t.Errorf("deploy-vke.yml Deploy Paprika chart must actively run secret validation line %q", line)
		}
	}
	activeRun := activeShellText(run)
	validationPosition := strings.Index(activeRun, validationLines[1])
	helmPosition := strings.Index(activeRun, "helm upgrade --install")
	if validationPosition < 0 || helmPosition < 0 || validationPosition >= helmPosition {
		t.Error("deploy-vke.yml must reject missing deployment secrets before running Helm")
	}
}

func testVKEProvenance(t *testing.T) {
	workflow := loadWorkflow(t, "deploy-vke.yml")
	deploy := requireMappingValue(t, workflow.jobs, "deploy", "deploy-vke.yml jobs")
	if concurrency := scalarString(workflow.document["concurrency"]); concurrency != "deploy-vke" {
		t.Errorf("deploy-vke.yml concurrency = %q, want deploy-vke", concurrency)
	}
	if environment := scalarString(deploy["environment"]); environment != "vke-production" {
		t.Errorf("deploy-vke.yml deploy.environment = %q, want vke-production", environment)
	}
	if permission(workflow, deploy, "contents") != "read" || permission(workflow, deploy, "id-token") != "write" {
		t.Error("deploy-vke.yml deploy job needs contents: read and id-token: write permissions")
	}
	checkoutRef, foundCheckout := checkoutRef(deploy)
	if !foundCheckout {
		t.Fatal("deploy-vke.yml deploy job has no actions/checkout step")
	}
	if got := normalizeExpression(checkoutRef); got != "github.sha" {
		t.Errorf("deploy-vke.yml checkout ref = %q after normalization, want github.sha", got)
	}
	assertImageReferenceEnvironment(t, deploy, "deploy-vke.yml deploy job", "inputs.image_ref")
	wantGate := "(github.event_name == 'push' || github.event_name == 'repository_dispatch') && github.ref == 'refs/heads/master'"
	if condition := normalizeExpression(scalarString(deploy["if"])); condition != wantGate {
		t.Errorf("deploy-vke.yml deploy.if = %q after normalization, want exact trusted event/ref gate %q", condition, wantGate)
	}
}

func testVKEImageValidation(t *testing.T) {
	assertImageReferenceValidator(t, vkeDeployJob(t), "deploy-vke.yml deploy job", []string{
		"Setup Helm",
		"Configure Kubernetes OIDC access",
		"Deploy Paprika chart",
	})
}

func testVKEComponentImageReferences(t *testing.T) {
	deploy := vkeDeployJob(t)
	step := requireNamedStep(t, deploy, "Deploy Paprika chart", "deploy-vke.yml deploy job")
	run := scalarString(step["run"])
	for _, component := range []string{"manager", "apiServer", "repoServer", "webhookReceiver"} {
		want := `--set-string ` + component + `.image.repository="${IMAGE_REFERENCE}" \`
		if !containsActiveShellLine(run, want) {
			t.Errorf("deploy-vke.yml must deploy %s using only the quoted immutable IMAGE_REFERENCE repository", component)
		}
	}
	if strings.Contains(activeShellText(run), ".image.tag") || strings.Contains(activeShellText(run), "IMAGE_TAG") {
		t.Error("deploy-vke.yml must not deploy mutable image tags")
	}
	if containsActiveShellFragment(run, "${{ secrets.") {
		t.Error("deploy-vke.yml must map secrets through the step environment instead of interpolating them into shell syntax")
	}
	stepEnv := requireMappingValue(t, step, "env", "deploy-vke.yml Deploy Paprika chart step")
	// #nosec G101 -- These are GitHub expression names asserted by the contract, not credential values.
	secretValues := map[string]string{
		"VKE_OIDC_CLIENT_ID":      "secrets.VKE_OIDC_CLIENT_ID",
		"VKE_AUTH_TOKEN_SECRET":   "secrets.VKE_AUTH_TOKEN_SECRET",
		"VKE_BASIC_PASSWORD_HASH": "secrets.VKE_BASIC_PASSWORD_HASH",
	}
	for environmentName, expression := range secretValues {
		if got := normalizeExpression(scalarString(stepEnv[environmentName])); got != expression {
			t.Errorf("deploy-vke.yml Deploy Paprika chart env.%s = %q after normalization, want %q", environmentName, got, expression)
		}
		if !containsActiveShellFragment(run, `="${`+environmentName+`}"`) {
			t.Errorf("deploy-vke.yml must pass %s through a quoted shell environment expansion", environmentName)
		}
	}
	// The OIDC client secret is materialized as a Kubernetes Secret through
	// stdin, rather than passed through a Helm value or process argument.
	if got := normalizeExpression(scalarString(stepEnv["VKE_OIDC_CLIENT_SECRET"])); got != "secrets.VKE_OIDC_CLIENT_SECRET" {
		t.Errorf("deploy-vke.yml Deploy Paprika chart env.VKE_OIDC_CLIENT_SECRET = %q after normalization, want %q", got, "secrets.VKE_OIDC_CLIENT_SECRET")
	}
	if !containsActiveShellFragment(run, `printf '%s' "${VKE_OIDC_CLIENT_SECRET}"`) {
		t.Error("deploy-vke.yml must send VKE_OIDC_CLIENT_SECRET to kubectl through quoted stdin")
	}
	if !containsActiveShellFragment(run, `--from-file=client-secret=/dev/stdin`) {
		t.Error("deploy-vke.yml must create the OIDC Secret from stdin instead of a process argument")
	}
	if strings.Contains(activeShellText(run), "latest") {
		t.Error("deploy-vke.yml deployment must not consume latest")
	}
}

func testVKEPodConditionValidation(t *testing.T) {
	deploy := vkeDeployJob(t)
	step := requireNamedStep(t, deploy, "Check pod conditions", "deploy-vke.yml deploy job")
	if run := strings.TrimSpace(scalarString(step["run"])); run != "bash hack/check-vke-pod-conditions.sh" {
		t.Errorf("deploy-vke.yml Check pod conditions run = %q, want only the tested race-free checker", run)
	}
}

func testDownstreamActionPins(t *testing.T) {
	for _, name := range []string{
		"deploy-vke.yml",
		"deploy-vke-manual.yml",
		"deploy-gke.yml",
		"deploy-cloudrun.yml",
		"helm-publish.yml",
		"test-e2e.yml",
		"gh-pages.yml",
		"release.yml",
	} {
		name := name
		t.Run(name, func(t *testing.T) {
			workflow := loadWorkflow(t, name)
			assertWorkflowActionPins(t, workflow)
			assertLocalReusableWorkflowUses(t, workflow)
		})
	}

	const (
		checkoutRevision    = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
		setupGoRevision     = "4a3601121dd01d1626a1e23e37211e3254c1c06c"
		setupHelmRevision   = "59b1c81c6280f5abebb1fb1bc585696daa7dfb42"
		setupBuildxRevision = "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c"
		buildPushRevision   = "ca052bb54ab0790a636c9b5f226502c73d547a25"
	)
	assertActionRevision(t, loadWorkflow(t, "deploy-vke.yml"), "actions/checkout", checkoutRevision)
	assertActionRevision(t, loadWorkflow(t, "deploy-vke.yml"), "actions/setup-go", setupGoRevision)
	assertActionRevision(t, loadWorkflow(t, "deploy-vke.yml"), "azure/setup-helm", setupHelmRevision)
	assertActionRevision(t, loadWorkflow(t, "helm-publish.yml"), "actions/checkout", checkoutRevision)
	assertActionRevision(t, loadWorkflow(t, "helm-publish.yml"), "azure/setup-helm", setupHelmRevision)
	assertActionRevision(t, loadWorkflow(t, "test-e2e.yml"), "docker/setup-buildx-action", setupBuildxRevision)
	assertActionRevision(t, loadWorkflow(t, "test-e2e.yml"), "docker/build-push-action", buildPushRevision)
	assertActionRevision(t, loadWorkflow(t, "gh-pages.yml"), "peaceiris/actions-gh-pages", pinnedActionRevisions["peaceiris/actions-gh-pages"])
}

func testDownstreamJobTimeouts(t *testing.T) {
	contracts := map[string]map[string][2]int{
		"deploy-vke.yml":      {"deploy": {5, 30}},
		"deploy-gke.yml":      {"deploy": {5, 30}},
		"deploy-cloudrun.yml": {"deploy": {5, 30}},
		"helm-publish.yml":    {"publish": {5, 30}},
		"test-e2e.yml":        {"test-e2e": {30, 60}},
		"gh-pages.yml":        {"deploy": {5, 15}},
		"release.yml":         {"preflight": {5, 15}, "artifacts": {5, 30}, "helm": {5, 20}, "verify-publish": {5, 20}},
	}
	for workflowName, jobs := range contracts {
		workflow := loadWorkflow(t, workflowName)
		for jobID, bounds := range jobs {
			job := requireMappingValue(t, workflow.jobs, jobID, workflowName+" jobs")
			assertJobTimeout(t, workflowName, jobID, job, bounds[0], bounds[1])
		}
	}
}

func testTaggedReleaseWorkflow(t *testing.T) {
	workflow := loadWorkflow(t, "release.yml")
	assertReleaseWorkflowBoundary(t, workflow)
	assertExactReleaseResolver(t)
	assertReleaseArchiveVerifier(t)
	goreleaserConfig := loadYAMLDocument(t, filepath.Join(repositoryRoot(t), ".goreleaser.yaml"))
	releaseConfig := requireMappingValue(t, goreleaserConfig, "release", ".goreleaser.yaml")
	if useExisting, ok := releaseConfig["use_existing_draft"].(bool); !ok || !useExisting {
		t.Errorf(".goreleaser.yaml release.use_existing_draft = %v, want true for safe draft reruns", releaseConfig["use_existing_draft"])
	}
	if _, declared := workflow.document["permissions"]; declared {
		t.Error("release.yml must scope permissions per job, not globally")
	}
	concurrency := requireMappingValue(t, workflow.document, "concurrency", "release.yml")
	if got := scalarString(concurrency["group"]); got != "release-${{ github.ref_name }}" {
		t.Errorf("release.yml concurrency.group = %q, want exact same-tag serialization", got)
	}
	if cancel, ok := concurrency["cancel-in-progress"].(bool); !ok || cancel {
		t.Errorf("release.yml concurrency.cancel-in-progress = %v, want false", concurrency["cancel-in-progress"])
	}
	assertReleasePreflightJob(t, workflow)
	assertReleaseArtifactsJob(t, workflow)
	assertReleaseHelmJob(t, workflow)
	assertReleaseVerifyPublishJob(t, workflow)
}

func assertReleaseWorkflowBoundary(t *testing.T, workflow workflowFile) {
	t.Helper()
	for _, text := range allStrings(workflow.document) {
		if strings.Contains(text, "/releases/tags/") || strings.Contains(text, "/releases/latest") ||
			strings.Contains(text, "gh release view") || strings.Contains(text, "gh release download") ||
			strings.Contains(text, "--method DELETE") || strings.Contains(text, "gh release edit") {
			t.Errorf("release.yml must not use a published-only or latest release endpoint: %q", text)
		}
	}
	push := requireMappingValue(t, workflow.triggers, "push", "release.yml triggers")
	if tags := stringList(push["tags"]); !exactly(tags, "v[0-9]+.[0-9]+.[0-9]+") {
		t.Errorf("release.yml push.tags = %v, want exact stable semantic-version pattern", tags)
	}
	stableTag := regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	for _, tag := range []string{"v0.1.0", "v12.34.56"} {
		if !stableTag.MatchString(tag) {
			t.Errorf("stable release tag validator rejects %q", tag)
		}
	}
	for _, tag := range []string{"v1.2", "v01.2.3", "v1.2.3-rc.1", "v1.2.3+build.1", "1.2.3", "v1.2.3x"} {
		if stableTag.MatchString(tag) {
			t.Errorf("stable release tag validator accepts %q", tag)
		}
	}
	for _, jobID := range []string{"preflight", "artifacts", "helm", "verify-publish"} {
		job := requireMappingValue(t, workflow.jobs, jobID, "release.yml jobs")
		if got := scalarString(job["runs-on"]); got != "ubuntu-24.04" {
			t.Errorf("release.yml job %q runs-on = %q, want pinned ubuntu-24.04", jobID, got)
		}
	}
}

func assertReleasePreflightJob(t *testing.T, workflow workflowFile) {
	t.Helper()
	preflight := requireMappingValue(t, workflow.jobs, "preflight", "release.yml jobs")
	assertExactJobPermissions(t, workflow, preflight, "release.yml preflight", map[string]string{"contents": "read", "packages": "read"})
	if len(stringList(preflight["needs"])) != 0 {
		t.Error("release.yml preflight must run before and independently of all mutation jobs")
	}
	if got := sortedKeys(requireMappingValue(t, preflight, "outputs", "release.yml preflight job")); !sameStrings(got, []string{"chart_action", "release_id", "release_state"}) {
		t.Errorf("release.yml preflight outputs = %v, want chart_action, release_id, and release_state", got)
	}
	guard, guardIndex := requireNamedStepAt(t, preflight, "Guard exact release and chart tags", "release.yml preflight job")
	guardScript := scalarString(guard["run"])
	for _, fragment := range []string{
		`TAG="${GITHUB_REF_NAME}"`, `VERSION="${TAG#v}"`,
		`version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'`,
		`bash hack/find-github-release.sh "${GITHUB_REPOSITORY}" "${TAG}"`,
		`release_state`, `release_id`, `public`, `.assets | length == 0`, `manually delete the draft`,
		`gh --version`, `jq --version`,
		`helm pull "oci://ghcr.io/paprikacd/charts/paprika" --version "${VERSION}"`,
		`helm package charts/chart --destination "${local_dir}" --version "${VERSION}" --app-version "${VERSION}"`,
		`bash hack/compare-helm-chart.sh "${local_archive}" "${remote_archive}"`, `chart_action=reuse`, `chart_action=publish`,
	} {
		if !containsActiveShellFragment(guardScript, fragment) {
			t.Errorf("release.yml exact-tag preflight must contain %q", fragment)
		}
	}
	for _, forbidden := range []string{"gh release delete", "gh release edit", "helm push", "goreleaser release", "/releases/latest"} {
		if containsActiveShellFragment(guardScript, forbidden) {
			t.Errorf("release.yml preflight must not mutate releases/images or use latest; found %q", forbidden)
		}
	}
	login := requireNamedStep(t, preflight, "Log in to chart registry for read", "release.yml preflight job")
	if loginIndex := namedStepIndex(t, preflight, "Log in to chart registry for read", "release.yml preflight job"); loginIndex >= guardIndex {
		t.Error("release.yml must authenticate for OCI reads before the exact chart-tag guard")
	}
	if !containsActiveShellFragment(scalarString(login["run"]), "helm registry login ghcr.io") {
		t.Error("release.yml preflight must authenticate Helm registry reads")
	}
}

func assertReleaseArtifactsJob(t *testing.T, workflow workflowFile) {
	t.Helper()
	artifacts := requireMappingValue(t, workflow.jobs, "artifacts", "release.yml jobs")
	assertExactJobPermissions(t, workflow, artifacts, "release.yml artifacts", map[string]string{"contents": "write", "packages": "write"})
	if !exactly(stringList(artifacts["needs"]), "preflight") {
		t.Errorf("release.yml artifacts needs = %v, want exactly preflight", stringList(artifacts["needs"]))
	}
	cleanup := requireNamedStep(t, artifacts, "Require resumable draft to remain empty", "release.yml artifacts job")
	cleanupScript := scalarString(cleanup["run"])
	for _, fragment := range []string{`needs.preflight.outputs.release_state`, `needs.preflight.outputs.release_id`, `gh api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"`, `'.id == $id and .tag_name == $tag and .draft == true and (.assets | length == 0)'`, `manually delete the draft`} {
		if !containsActiveShellFragment(cleanupScript, fragment) {
			t.Errorf("release.yml draft resumption guard must contain %q", fragment)
		}
	}
	if got := sortedKeys(requireMappingValue(t, artifacts, "outputs", "release.yml artifacts job")); !sameStrings(got, []string{"image_digest_ref", "release_id"}) {
		t.Errorf("release.yml artifacts outputs = %v, want image_digest_ref and release_id", got)
	}
	step := requireUsesStep(t, artifacts, "goreleaser/goreleaser-action@", "release.yml artifacts job")
	if got := scalarString(requireMappingValue(t, step, "with", "release.yml GoReleaser step")["version"]); got != "v2.16.0" {
		t.Errorf("release.yml GoReleaser version = %q, want v2.16.0", got)
	}
	if args := scalarString(requireMappingValue(t, step, "with", "release.yml GoReleaser step")["args"]); args != "release --clean" {
		t.Errorf("release.yml GoReleaser args = %q, want release --clean", args)
	}
	resolve := requireNamedStep(t, artifacts, "Resolve exact draft release ID", "release.yml artifacts job")
	resolveScript := scalarString(resolve["run"])
	for _, fragment := range []string{`bash hack/find-github-release.sh "${GITHUB_REPOSITORY}" "${TAG}"`, `state == "draft"`, `release_id`} {
		if !containsActiveShellFragment(resolveScript, fragment) {
			t.Errorf("release.yml artifact release-ID resolution must contain %q", fragment)
		}
	}
	image := requireNamedStep(t, artifacts, "Capture immutable server image", "release.yml artifacts job")
	imageScript := scalarString(image["run"])
	for _, fragment := range []string{`docker pull --platform linux/amd64 "${image_tag}"`, `org.opencontainers.image.revision`, `GITHUB_SHA`, `^ghcr.io/paprikacd/paprika@sha256:[0-9a-f]{64}$`, `image_digest_ref`} {
		if !containsActiveShellFragment(imageScript, fragment) {
			t.Errorf("release.yml immutable image capture must contain %q", fragment)
		}
	}
}

func assertReleaseHelmJob(t *testing.T, workflow workflowFile) {
	t.Helper()
	helm := requireMappingValue(t, workflow.jobs, "helm", "release.yml jobs")
	assertExactJobPermissions(t, workflow, helm, "release.yml helm", map[string]string{"contents": "read", "packages": "write"})
	if !sameStrings(stringList(helm["needs"]), []string{"preflight", "artifacts"}) {
		t.Errorf("release.yml helm needs = %v, want preflight and artifacts", stringList(helm["needs"]))
	}
	if got := sortedKeys(requireMappingValue(t, helm, "outputs", "release.yml helm job")); !exactly(got, "chart_digest_ref") {
		t.Errorf("release.yml helm outputs = %v, want exactly chart_digest_ref", got)
	}
	helmPublish := requireNamedStep(t, helm, "Publish chart only when absent", "release.yml helm job")
	if got := normalizeExpression(scalarString(helmPublish["if"])); got != "needs.preflight.outputs.chart_action == 'publish'" {
		t.Errorf("release.yml Helm publish condition = %q, want preflight publish decision", got)
	}
	helmScript := scalarString(helmPublish["run"])
	for _, fragment := range []string{`VERSION="${GITHUB_REF_NAME#v}"`, `helm pull "oci://ghcr.io/paprikacd/charts/paprika" --version "${VERSION}"`, `refusing to overwrite it`, `--version "${VERSION}"`, `--app-version "${VERSION}"`, `helm push ".dist/paprika-${VERSION}.tgz"`} {
		if !containsActiveShellFragment(helmScript, fragment) {
			t.Errorf("release.yml Helm publication must contain %q", fragment)
		}
	}
	capture := requireNamedStep(t, helm, "Capture immutable chart digest", "release.yml helm job")
	for _, fragment := range []string{`^ghcr.io/paprikacd/charts/paprika@sha256:[0-9a-f]{64}$`, `bash hack/compare-helm-chart.sh --oci`, `chart_digest_ref`} {
		if !containsActiveShellFragment(scalarString(capture["run"]), fragment) {
			t.Errorf("release.yml immutable chart capture must contain %q", fragment)
		}
	}
}

func assertReleaseVerifyPublishJob(t *testing.T, workflow workflowFile) {
	t.Helper()
	verify := requireMappingValue(t, workflow.jobs, "verify-publish", "release.yml jobs")
	assertExactJobPermissions(t, workflow, verify, "release.yml verify-publish", map[string]string{"contents": "write", "packages": "read"})
	if !sameStrings(stringList(verify["needs"]), []string{"artifacts", "helm"}) {
		t.Errorf("release.yml verify-publish needs = %v, want artifacts and helm", stringList(verify["needs"]))
	}
	checkout, checkoutIndex := requireNamedStepAt(t, verify, "Checkout", "release.yml verify-publish job")
	if uses := scalarString(checkout["uses"]); uses != "actions/checkout@"+pinnedActionRevisions["actions/checkout"] {
		t.Errorf("release.yml verify-publish checkout uses = %q, want pinned actions/checkout", uses)
	}
	checkoutWith := requireMappingValue(t, checkout, "with", "release.yml verify-publish checkout")
	if persist, ok := checkoutWith["persist-credentials"].(bool); !ok || persist {
		t.Errorf("release.yml verify-publish checkout persist-credentials = %v, want false", checkoutWith["persist-credentials"])
	}
	if checkoutIndex != 0 {
		t.Errorf("release.yml verify-publish checkout step index = %d, want first step", checkoutIndex)
	}
	verifyStep := requireNamedStep(t, verify, "Verify exact artifacts and publish", "release.yml verify-publish job")
	if verifyIndex := namedStepIndex(t, verify, "Verify exact artifacts and publish", "release.yml verify-publish job"); checkoutIndex >= verifyIndex {
		t.Error("release.yml verify-publish must checkout before final verification")
	}
	verifyScript := scalarString(verifyStep["run"])
	for _, fragment := range []string{
		`needs.artifacts.outputs.release_id`, `gh api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"`,
		`'.id == $id and .tag_name == $tag and .draft == true'`,
		`paprika_${VERSION}_darwin_amd64.tar.gz`, `paprika_${VERSION}_darwin_arm64.tar.gz`,
		`paprika_${VERSION}_linux_amd64.tar.gz`, `paprika_${VERSION}_linux_arm64.tar.gz`, `checksums.txt`,
		`select(.name == $name)`, `--header 'Accept: application/octet-stream'`,
		`"repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}"`, `sha256sum --check checksums.txt`,
		`./paprika version`, `./paprika login --help`, `./paprika status --help`, `./paprika version --help`,
		`needs.artifacts.outputs.image_digest_ref`, `^ghcr.io/paprikacd/paprika@sha256:[0-9a-f]{64}$`,
		`docker pull --platform linux/amd64 "${IMAGE_DIGEST_REF}"`, `org.opencontainers.image.revision`, `GITHUB_SHA`,
		`docker image inspect --format '{{.Os}}/{{.Architecture}}'`, `linux/amd64`,
		`needs.helm.outputs.chart_digest_ref`, `^ghcr.io/paprikacd/charts/paprika@sha256:[0-9a-f]{64}$`,
		`hack/compare-helm-chart.sh" --oci`, `current chart tag digest changed`,
		`hack/verify-release-archives.sh" . "${VERSION}"`,
		`gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}" -F draft=false -f make_latest=true`,
	} {
		if !containsActiveShellFragment(verifyScript, fragment) {
			t.Errorf("release.yml final verification must contain %q", fragment)
		}
	}
	if containsActiveShellFragment(verifyScript, "/releases/latest") || containsActiveShellFragment(verifyScript, "gh release view --json") || containsActiveShellFragment(verifyScript, `ghcr.io/paprikacd/paprika:${VERSION}`) {
		t.Error("release.yml final verification must query the exact tag, never latest or implicit release state")
	}
	activeLines := strings.Split(activeShellText(verifyScript), "\n")
	if got := activeLines[len(activeLines)-1]; got != `gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}" -F draft=false -f make_latest=true` {
		t.Errorf("release.yml final active command = %q, want exact publish mutation last", got)
	}
	if strings.Count(activeShellText(verifyScript), `gh api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"`) < 2 {
		t.Error("release.yml must re-fetch and validate the draft by ID immediately before the final PATCH")
	}

	for _, jobID := range []string{"artifacts", "helm", "verify-publish"} {
		job := requireMappingValue(t, workflow.jobs, jobID, "release.yml jobs")
		buildx := requireUsesStep(t, job, "docker/setup-buildx-action@", "release.yml "+jobID+" job")
		if got := scalarString(requireMappingValue(t, buildx, "with", "release.yml buildx step")["version"]); got != "v0.29.1" {
			t.Errorf("release.yml %s Buildx version = %q, want v0.29.1", jobID, got)
		}
	}
}

func assertReleaseArchiveVerifier(t *testing.T) {
	t.Helper()
	path := filepath.Join(repositoryRoot(t), "hack", "verify-release-archives.sh")
	// #nosec G304 -- the path is repository-controlled test data.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read release archive verifier: %v", err)
	}
	script := string(data)
	for _, fragment := range []string{
		`darwin_amd64 darwin_arm64 linux_amd64 linux_arm64`, `tar -tzf`, `tar -tvzf`,
		`! -f`, `-L`, `! -x`, `file -b`, `Mach-O 64-bit`, `ELF 64-bit`, `x86-64`, `aarch64`,
	} {
		if !containsActiveShellFragment(script, fragment) {
			t.Errorf("release archive verifier must contain %q", fragment)
		}
	}
}

func assertExactReleaseResolver(t *testing.T) {
	t.Helper()
	path := filepath.Join(repositoryRoot(t), "hack", "find-github-release.sh")
	// #nosec G304 -- the path is repository-controlled test data.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read exact release resolver: %v", err)
	}
	script := string(data)
	for _, fragment := range []string{
		`gh api --paginate --slurp`, `releases?per_page=100`, `.tag_name == $tag`,
		`$count == 0`, `$count == 1`, `state: "absent"`, `state: "draft"`, `state: "public"`,
	} {
		if !containsActiveShellFragment(script, fragment) {
			t.Errorf("exact release resolver must contain %q", fragment)
		}
	}
	if strings.Contains(activeShellText(script), "/releases/tags/") || strings.Contains(activeShellText(script), "/releases/latest") {
		t.Error("exact release resolver must list authenticated releases rather than query published-only/latest endpoints")
	}
}

func assertExactJobPermissions(t *testing.T, workflow workflowFile, job map[string]any, context string, want map[string]string) {
	t.Helper()
	permissions := requireMappingValue(t, job, "permissions", context+" job")
	if !sameStrings(sortedKeys(permissions), sortedKeysString(want)) {
		t.Errorf("%s permissions = %v, want exactly %v", context, permissions, want)
	}
	for name, value := range want {
		if got := permission(workflow, job, name); got != value {
			t.Errorf("%s permission %s = %q, want %q", context, name, got, value)
		}
	}
}

func sortedKeysString(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func namedStepIndex(t *testing.T, job map[string]any, name, context string) int {
	t.Helper()
	_, index := requireNamedStepAt(t, job, name, context)
	return index
}

func testPrivilegedManualEntrypoints(t *testing.T) {
	for _, path := range workflowPaths(t) {
		workflow := loadWorkflowPath(t, path)
		if !workflowIsPrivileged(workflow) {
			continue
		}
		if _, found := workflow.triggers["workflow_dispatch"]; found {
			t.Errorf("%s is privileged and must not expose workflow_dispatch", workflow.name)
		}
	}

	contracts := map[string]string{
		"deploy-vke-manual.yml": "deploy-vke",
		"deploy-gke.yml":        "deploy-gke",
		"deploy-cloudrun.yml":   "deploy-cloudrun",
		"helm-publish.yml":      "publish-helm",
		"gh-pages.yml":          "publish-pages",
	}
	for name, eventType := range contracts {
		name, eventType := name, eventType
		t.Run(name, func(t *testing.T) {
			assertExactRepositoryDispatch(t, loadWorkflow(t, name), eventType)
		})
	}
}

func testLegacyDeployments(t *testing.T) {
	contracts := map[string]string{
		"deploy-gke.yml":      "deploy-gke",
		"deploy-cloudrun.yml": "deploy-cloudrun",
	}
	for name, eventType := range contracts {
		name, eventType := name, eventType
		t.Run(name, func(t *testing.T) {
			workflow := loadWorkflow(t, name)
			assertExactRepositoryDispatch(t, workflow, eventType)
			if len(workflow.triggers) != 1 {
				t.Errorf("%s must be repository_dispatch only; got triggers %v", name, sortedKeys(workflow.triggers))
			}

			deploy := requireMappingValue(t, workflow.jobs, "deploy", name+" jobs")
			assertImageReferenceEnvironment(t, deploy, name+" deploy job", "github.event.client_payload.image_ref")
			stepName := map[string]string{
				"deploy-gke.yml":      "Deploy via Helm",
				"deploy-cloudrun.yml": "Deploy to Cloud Run",
			}[name]
			assertImageReferenceValidator(t, deploy, name+" deploy job", []string{"Authenticate to GCP", stepName})
			step := requireNamedStep(t, deploy, stepName, name+" deploy job")
			run := scalarString(step["run"])
			if containsActiveShellFragment(run, "${{ github.event.client_payload.image_ref }}") || containsActiveShellFragment(run, "github.sha") {
				t.Errorf("%s must not interpolate the input or derive an image reference in shell syntax", name)
			}
			if !containsActiveShellFragment(run, "${IMAGE_REFERENCE}") {
				t.Errorf("%s must deploy the validated immutable reference through the shell environment", name)
			}
		})
	}

	gke := loadWorkflow(t, "deploy-gke.yml")
	gkeDeploy := requireMappingValue(t, gke.jobs, "deploy", "deploy-gke.yml jobs")
	gkeRun := scalarString(requireNamedStep(t, gkeDeploy, "Deploy via Helm", "deploy-gke.yml deploy job")["run"])
	if !containsActiveShellLine(gkeRun, `--set-string manager.image.repository="${IMAGE_REFERENCE}" \`) {
		t.Error("deploy-gke.yml must override only manager.image.repository with the immutable IMAGE_REFERENCE")
	}
	if strings.Contains(activeShellText(gkeRun), ".image.tag") || strings.Contains(activeShellText(gkeRun), "IMAGE_TAG") {
		t.Error("deploy-gke.yml must not deploy mutable image tags")
	}

	cloudRun := loadWorkflow(t, "deploy-cloudrun.yml")
	cloudDeploy := requireMappingValue(t, cloudRun.jobs, "deploy", "deploy-cloudrun.yml jobs")
	cloudRunScript := scalarString(requireNamedStep(t, cloudDeploy, "Deploy to Cloud Run", "deploy-cloudrun.yml deploy job")["run"])
	if !containsActiveShellLine(cloudRunScript, `--image="${IMAGE_REFERENCE}" \`) {
		t.Error("deploy-cloudrun.yml must deploy the immutable IMAGE_REFERENCE directly")
	}
	if strings.Contains(activeShellText(cloudRunScript), "IMAGE_TAG") || strings.Contains(activeShellText(cloudRunScript), ":latest") {
		t.Error("deploy-cloudrun.yml must not deploy mutable image tags")
	}
}

func testHelmPublishing(t *testing.T) {
	workflow := loadWorkflow(t, "helm-publish.yml")
	push := requireMappingValue(t, workflow.triggers, "push", "helm-publish.yml triggers")
	branches := stringList(push["branches"])
	if !exactly(branches, "master") {
		t.Errorf("helm-publish.yml push.branches = %v, want exactly [master]", branches)
	}
	assertExactRepositoryDispatch(t, workflow, "publish-helm")

	publish := requireMappingValue(t, workflow.jobs, "publish", "helm-publish.yml jobs")
	checkout := requireUsesStep(t, publish, "actions/checkout@", "helm-publish.yml publish job")
	checkoutWith := requireMappingValue(t, checkout, "with", "helm-publish.yml checkout step")
	if persist, ok := checkoutWith["persist-credentials"].(bool); !ok || persist {
		t.Errorf("helm-publish.yml checkout persist-credentials = %v, want false", checkoutWith["persist-credentials"])
	}
	setupHelm := requireUsesStep(t, publish, "azure/setup-helm@", "helm-publish.yml publish job")
	setupWith := requireMappingValue(t, setupHelm, "with", "helm-publish.yml setup-helm step")
	if version := scalarString(setupWith["version"]); version != "v3.21.2" {
		t.Errorf("helm-publish.yml Helm version = %q, want v3.21.2", version)
	}

	assertManualHelmVersionValidation(t, publish)
	assertHelmPublishPreflightOrder(t, publish)
}

func assertManualHelmVersionValidation(t *testing.T, publish map[string]any) {
	t.Helper()
	determine := requireNamedStep(t, publish, "Determine version", "helm-publish.yml publish job")
	determineEnv := requireMappingValue(t, determine, "env", "helm-publish.yml Determine version step")
	if got := normalizeExpression(scalarString(determineEnv["REQUESTED_VERSION"])); got != "github.event.client_payload.version" {
		t.Errorf("helm-publish.yml REQUESTED_VERSION = %q after normalization, want github.event.client_payload.version", got)
	}
	if got := normalizeExpression(scalarString(determineEnv["EVENT_NAME"])); got != "github.event_name" {
		t.Errorf("helm-publish.yml EVENT_NAME = %q after normalization, want github.event_name", got)
	}
	const versionPattern = `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$`
	run := scalarString(determine["run"])
	for _, line := range []string{
		`manual_version_pattern='` + versionPattern + `'`,
		`if [[ ! "${REQUESTED_VERSION}" =~ ${manual_version_pattern} ]]; then`,
		"exit 1",
	} {
		if !containsActiveShellLine(run, line) {
			t.Errorf("helm-publish.yml Determine version must actively run %q", line)
		}
	}
	if !stepFailureEnforcing(determine) {
		t.Error("helm-publish.yml version validation must be unconditional and failure-enforcing")
	}
	versionValidator := regexp.MustCompile(versionPattern)
	for _, valid := range []string{"0.1.0", "12.34.56-rc.1+build.7"} {
		if !versionValidator.MatchString(valid) {
			t.Errorf("version validator unexpectedly rejects %q", valid)
		}
	}
	for _, invalid := range []string{"1.2", "01.2.3", "1.2.3,evil", "1.2.3 ", "$(touch pwned)", "1.2.3;false"} {
		if versionValidator.MatchString(invalid) {
			t.Errorf("version validator must reject adversarial version %q", invalid)
		}
	}
}

func assertHelmPublishPreflightOrder(t *testing.T, publish map[string]any) {
	t.Helper()
	_, determineIndex := requireNamedStepAt(t, publish, "Determine version", "helm-publish.yml publish job")
	lint, lintIndex := requireNamedStepAt(t, publish, "Lint chart", "helm-publish.yml publish job")
	render, renderIndex := requireNamedStepAt(t, publish, "Render chart", "helm-publish.yml publish job")
	_, packageIndex := requireNamedStepAt(t, publish, "Package chart", "helm-publish.yml publish job")
	_, pushIndex := requireNamedStepAt(t, publish, "Push to OCI registry", "helm-publish.yml publish job")
	if !containsActiveShellLine(scalarString(lint["run"]), "helm lint charts/chart/") || !stepFailureEnforcing(lint) {
		t.Error("helm-publish.yml must actively enforce exact helm lint charts/chart/ before publication")
	}
	if !containsActiveShellLine(scalarString(render["run"]), "helm template paprika charts/chart/") || !stepFailureEnforcing(render) {
		t.Error("helm-publish.yml must actively enforce exact helm template paprika charts/chart/ before publication")
	}
	if !(determineIndex < lintIndex && lintIndex < renderIndex && renderIndex < packageIndex && packageIndex < pushIndex) {
		t.Errorf("helm-publish.yml steps must order version, lint, render, package, push; got %d, %d, %d, %d, %d", determineIndex, lintIndex, renderIndex, packageIndex, pushIndex)
	}
}

func testGitHubPagesPublishing(t *testing.T) {
	workflow := loadWorkflow(t, "gh-pages.yml")
	push := requireMappingValue(t, workflow.triggers, "push", "gh-pages.yml triggers")
	if branches := stringList(push["branches"]); !exactly(branches, "master") {
		t.Errorf("gh-pages.yml push.branches = %v, want exactly [master]", branches)
	}
	assertExactRepositoryDispatch(t, workflow, "publish-pages")
	concurrency := requireMappingValue(t, workflow.document, "concurrency", "gh-pages.yml")
	if scalarString(concurrency["group"]) != "publish-pages" {
		t.Errorf("gh-pages.yml concurrency.group = %q, want publish-pages", concurrency["group"])
	}
	if cancel, ok := concurrency["cancel-in-progress"].(bool); !ok || cancel {
		t.Errorf("gh-pages.yml concurrency.cancel-in-progress = %v, want false", concurrency["cancel-in-progress"])
	}
	deploy := requireMappingValue(t, workflow.jobs, "deploy", "gh-pages.yml jobs")
	checkout := requireUsesStep(t, deploy, "actions/checkout@", "gh-pages.yml deploy job")
	checkoutWith := requireMappingValue(t, checkout, "with", "gh-pages.yml checkout step")
	if persist, ok := checkoutWith["persist-credentials"].(bool); !ok || persist {
		t.Errorf("gh-pages.yml checkout persist-credentials = %v, want false", checkoutWith["persist-credentials"])
	}
}

func testE2ETriggers(t *testing.T) {
	workflow := loadWorkflow(t, "test-e2e.yml")
	if _, ok := workflow.triggers["workflow_dispatch"]; !ok {
		t.Error("test-e2e.yml must declare workflow_dispatch")
	}
	if got := sortedKeys(workflow.triggers); len(got) != 2 || !contains(got, "schedule") || !contains(got, "workflow_dispatch") {
		t.Errorf("test-e2e.yml triggers = %v, want exactly schedule and workflow_dispatch", got)
	}

	schedules := anyList(workflow.triggers["schedule"])
	if len(schedules) != 1 {
		t.Errorf("test-e2e.yml must declare one nightly schedule; got %d", len(schedules))
		return
	}
	schedule, ok := schedules[0].(map[string]any)
	if !ok {
		t.Errorf("test-e2e.yml schedule must be a mapping, got %T", schedules[0])
		return
	}
	cron := scalarString(schedule["cron"])
	if !isOnceDailyCron(cron) {
		t.Errorf("test-e2e.yml schedule cron = %q, want exactly one run every day", cron)
	}
}

func testE2ECacheScopes(t *testing.T) {
	workflow := loadWorkflow(t, "test-e2e.yml")
	job := requireMappingValue(t, workflow.jobs, "test-e2e", "test-e2e.yml jobs")
	contracts := map[string]string{
		"Build manager image": "paprika-app-e2e",
		"Build demo image":    "paprika-demo-e2e",
	}
	for stepName, scope := range contracts {
		step := requireNamedStep(t, job, stepName, "test-e2e.yml test-e2e job")
		with := requireMappingValue(t, step, "with", "test-e2e.yml "+stepName)
		if got := scalarString(with["cache-from"]); got != "type=gha,scope="+scope {
			t.Errorf("test-e2e.yml %s cache-from = %q, want dedicated scope %q", stepName, got, scope)
		}
		if got := scalarString(with["cache-to"]); got != "type=gha,mode=max,scope="+scope {
			t.Errorf("test-e2e.yml %s cache-to = %q, want dedicated scope %q", stepName, got, scope)
		}
	}
}

func testE2EKindChecksum(t *testing.T) {
	workflow := loadWorkflow(t, "test-e2e.yml")
	job := requireMappingValue(t, workflow.jobs, "test-e2e", "test-e2e.yml jobs")
	environment := requireMappingValue(t, job, "env", "test-e2e.yml test-e2e job")
	checksum := scalarString(environment["KIND_SHA256"])
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(checksum) {
		t.Errorf("test-e2e.yml KIND_SHA256 = %q, want a pinned lowercase 64-hex digest", checksum)
	}
	step := requireNamedStep(t, job, "Install kind", "test-e2e.yml test-e2e job")
	run := scalarString(step["run"])
	for _, want := range []string{
		"curl --fail --location --retry 5 --retry-all-errors",
		"kind-linux-amd64",
		`printf '%s  %s\n' "${KIND_SHA256}" "${kind_binary}" | sha256sum --check -`,
	} {
		if !containsActiveShellFragment(run, want) {
			t.Errorf("test-e2e.yml Install kind step must actively use %q", want)
		}
	}
	if strings.Contains(activeShellText(run), ".sha256sum") || strings.Count(activeShellText(run), "curl ") != 1 {
		t.Error("test-e2e.yml must not download a same-origin checksum file")
	}
}

func testGitHubActionsTokenExchangeChartWiring(t *testing.T) {
	values := loadYAMLDocument(t, filepath.Join(repositoryRoot(t), "charts", "chart", "values.yaml"))
	exchange := requireMappingValue(t, values, "githubActionsTokenExchange", "charts/chart/values.yaml")
	for _, name := range []string{"allowedEventNames", "ref", "allowedWorkflowRefs", "jobWorkflowRef"} {
		if _, found := exchange[name]; !found {
			t.Errorf("charts/chart/values.yaml githubActionsTokenExchange must document %s", name)
		}
	}

	testValues := loadYAMLDocument(t, filepath.Join(repositoryRoot(t), "deploy", "test-values.yaml"))
	testExchange := requireMappingValue(t, testValues, "githubActionsTokenExchange", "deploy/test-values.yaml")
	if got := stringList(testExchange["allowedEventNames"]); len(got) != 2 || !contains(got, "push") || !contains(got, "repository_dispatch") {
		t.Errorf("deploy/test-values.yaml allowedEventNames = %v, want exactly push and repository_dispatch", got)
	}
	if got := scalarString(testExchange["ref"]); got != "refs/heads/master" {
		t.Errorf("deploy/test-values.yaml ref = %q, want refs/heads/master", got)
	}
	wantWorkflows := []string{
		"paprikacd/paprika/.github/workflows/ci.yml@refs/heads/master",
		"paprikacd/paprika/.github/workflows/deploy-vke-manual.yml@refs/heads/master",
	}
	if got := stringList(testExchange["allowedWorkflowRefs"]); !sameStrings(got, wantWorkflows) {
		t.Errorf("deploy/test-values.yaml allowedWorkflowRefs = %v, want %v", got, wantWorkflows)
	}
	if got := scalarString(testExchange["jobWorkflowRef"]); got != "paprikacd/paprika/.github/workflows/deploy-vke.yml@refs/heads/master" {
		t.Errorf("deploy/test-values.yaml jobWorkflowRef = %q, want reusable VKE workflow on master", got)
	}

	helperPath := filepath.Join(repositoryRoot(t), "charts", "chart", "templates", "_helpers.tpl")
	// #nosec G304 -- the path is repository-controlled test data.
	helperData, err := os.ReadFile(helperPath)
	if err != nil {
		t.Fatalf("read chart helper: %v", err)
	}
	helper := string(helperData)
	for _, environmentName := range []string{
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ALLOWED_EVENT_NAMES",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_REF",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ALLOWED_WORKFLOW_REFS",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_JOB_WORKFLOW_REF",
	} {
		if !strings.Contains(helper, environmentName) {
			t.Errorf("chart helper must render %s", environmentName)
		}
	}
	for _, requiredValue := range []string{"allowedEventNames", "ref", "allowedWorkflowRefs", "jobWorkflowRef"} {
		if !strings.Contains(helper, "githubActionsTokenExchange."+requiredValue+" is required") {
			t.Errorf("chart helper must fail rendering when githubActionsTokenExchange.%s is missing", requiredValue)
		}
	}
}

func testNoMainBranchTargets(t *testing.T) {
	for _, path := range workflowPaths(t) {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			workflow := loadWorkflowPath(t, path)
			for _, branches := range mappingsNamed(workflow.triggers, "branches") {
				if contains(stringList(branches), "main") {
					t.Errorf("%s contains a branch target named main", workflow.name)
				}
			}

			mainExpression := regexp.MustCompile(`(?i)(refs/heads/main\b|head_branch\s*==\s*['\"]main['\"]|ref_name\s*==\s*['\"]main['\"]|^\s*main\s*$)`)
			expressionValues := append(mappingsNamed(workflow.document, "if"), mappingsNamed(workflow.document, "ref")...)
			for _, value := range expressionValues {
				if expression, ok := value.(string); ok && mainExpression.MatchString(expression) {
					t.Errorf("%s contains an expression targeting the main branch: %q", workflow.name, expression)
				}
			}
		})
	}
}

func loadWorkflow(t *testing.T, name string) workflowFile {
	t.Helper()
	return loadWorkflowPath(t, filepath.Join(repositoryRoot(t), ".github", "workflows", name))
}

func loadWorkflowPath(t *testing.T, path string) workflowFile {
	t.Helper()
	// #nosec G304 -- test paths are constrained to the repository's workflow directory.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read workflow %s: %v", filepath.Base(path), err)
	}

	document := make(map[string]any)
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatalf("parse workflow %s: %v", filepath.Base(path), err)
	}

	return workflowFile{
		name:     filepath.Base(path),
		document: document,
		triggers: requireMappingValue(t, document, "on", filepath.Base(path)),
		jobs:     optionalMappingValue(t, document, "jobs"),
	}
}

func loadYAMLDocument(t *testing.T, path string) map[string]any {
	t.Helper()
	// #nosec G304 -- callers pass repository-controlled test data paths.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read YAML document %s: %v", filepath.Base(path), err)
	}
	document := make(map[string]any)
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatalf("parse YAML document %s: %v", filepath.Base(path), err)
	}
	return document
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory: %v", err)
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find repository root containing go.mod")
		}
		dir = parent
	}
}

func workflowPaths(t *testing.T) []string {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(repositoryRoot(t), ".github", "workflows", "*.y*ml"))
	if err != nil {
		t.Fatalf("list workflow files: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no active workflow YAML files found")
	}
	return paths
}

func requireMappingValue(t *testing.T, values map[string]any, key, context string) map[string]any {
	t.Helper()
	value, ok := values[key]
	if !ok {
		t.Fatalf("%s is missing %q", context, key)
	}
	mapping, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s.%s must be a mapping, got %T", context, key, value)
	}
	return mapping
}

func optionalMappingValue(t *testing.T, values map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := values[key]
	if !ok || value == nil {
		return map[string]any{}
	}
	mapping, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s must be a mapping, got %T", key, value)
	}
	return mapping
}

func stringList(value any) []string {
	switch value := value.(type) {
	case nil:
		return nil
	case string:
		return []string{value}
	case []any:
		values := make([]string, 0, len(value))
		for _, item := range value {
			values = append(values, scalarString(item))
		}
		return values
	default:
		return []string{scalarString(value)}
	}
}

func anyList(value any) []any {
	if values, ok := value.([]any); ok {
		return values
	}
	return nil
}

func scalarString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	got = append([]string(nil), got...)
	want = append([]string(nil), want...)
	sort.Strings(got)
	sort.Strings(want)
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func exactly(values []string, want string) bool {
	return len(values) == 1 && values[0] == want
}

func isOnceDailyCron(cron string) bool {
	return regexp.MustCompile(`^(?:[0-5]?\d)\s+(?:[01]?\d|2[0-3])\s+\*\s+\*\s+\*$`).MatchString(strings.TrimSpace(cron))
}

func normalizeExpression(expression string) string {
	expression = strings.TrimSpace(expression)
	if strings.HasPrefix(expression, "${{") && strings.HasSuffix(expression, "}}") {
		expression = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(expression, "${{"), "}}"))
	}
	return strings.TrimSpace(expression)
}

func permission(workflow workflowFile, job map[string]any, name string) string {
	if permissions, declared := job["permissions"]; declared {
		return permissionValue(permissions, name)
	}
	return permissionValue(workflow.document["permissions"], name)
}

func permissionValue(value any, name string) string {
	switch permissions := value.(type) {
	case map[string]any:
		return scalarString(permissions[name])
	case string:
		if permissions == "write-all" {
			return "write"
		}
		if permissions == "read-all" {
			return "read"
		}
	}
	return ""
}

func assertExactRepositoryDispatch(t *testing.T, workflow workflowFile, eventType string) {
	t.Helper()
	dispatch := requireMappingValue(t, workflow.triggers, "repository_dispatch", workflow.name+" triggers")
	if types := stringList(dispatch["types"]); !exactly(types, eventType) {
		t.Errorf("%s repository_dispatch.types = %v, want exactly [%s]", workflow.name, types, eventType)
	}
}

func workflowIsPrivileged(workflow workflowFile) bool {
	for _, value := range mappingsNamed(workflow.document, "permissions") {
		for _, permission := range allStrings(value) {
			if permission == "write" || permission == "write-all" {
				return true
			}
		}
	}
	for _, value := range mappingsNamed(workflow.jobs, "environment") {
		if scalarString(value) != "" {
			return true
		}
	}
	return false
}

func vkeDeployJob(t *testing.T) map[string]any {
	t.Helper()
	workflow := loadWorkflow(t, "deploy-vke.yml")
	return requireMappingValue(t, workflow.jobs, "deploy", "deploy-vke.yml jobs")
}

func workflowRunSteps(job map[string]any) []workflowRunStep {
	defaultDirectory := ""
	if defaults, ok := job["defaults"].(map[string]any); ok {
		if runDefaults, ok := defaults["run"].(map[string]any); ok {
			defaultDirectory = scalarString(runDefaults["working-directory"])
		}
	}

	var steps []workflowRunStep
	for _, value := range anyList(job["steps"]) {
		step, ok := value.(map[string]any)
		if !ok {
			continue
		}
		run := scalarString(step["run"])
		if run == "" {
			continue
		}
		workingDirectory := scalarString(step["working-directory"])
		if workingDirectory == "" {
			workingDirectory = defaultDirectory
		}
		steps = append(steps, workflowRunStep{
			run:              run,
			workingDirectory: workingDirectory,
			failureEnforcing: stepFailureEnforcing(step),
		})
	}
	return steps
}

func hasRunCommand(job map[string]any, command, workingDirectory string) bool {
	matched := false
	for _, step := range workflowRunSteps(job) {
		if !workingDirectoryMatches(step.workingDirectory, workingDirectory) || !containsShellCommand(step.run, command) {
			continue
		}
		if !step.failureEnforcing {
			return false
		}
		matched = true
	}
	return matched
}

func runCommandPosition(job map[string]any, command string) int {
	position := 0
	for _, step := range workflowRunSteps(job) {
		for _, line := range strings.Split(step.run, "\n") {
			if strings.TrimSpace(line) == command && step.failureEnforcing {
				return position
			}
			position++
		}
	}
	return -1
}

func workingDirectoryMatches(got, want string) bool {
	if want == "" {
		return got == "" || got == "."
	}
	return got == want
}

func containsShellCommand(script, command string) bool {
	for _, line := range strings.Split(script, "\n") {
		if strings.TrimSpace(line) == command {
			return true
		}
	}
	return false
}

func activeShellText(script string) string {
	var active []string
	for _, line := range strings.Split(script, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		active = append(active, line)
	}
	return strings.Join(active, "\n")
}

func containsActiveShellFragment(script, fragment string) bool {
	return strings.Contains(activeShellText(script), fragment)
}

func containsActiveShellLine(script, want string) bool {
	for _, line := range strings.Split(activeShellText(script), "\n") {
		if line == want {
			return true
		}
	}
	return false
}

func findFailureEnforcingUsesStep(job map[string]any, actionPrefix string) (map[string]any, bool) {
	var matched map[string]any
	for _, value := range anyList(job["steps"]) {
		step, ok := value.(map[string]any)
		if !ok || !strings.HasPrefix(scalarString(step["uses"]), actionPrefix) {
			continue
		}
		if !stepFailureEnforcing(step) {
			return nil, false
		}
		matched = step
	}
	return matched, matched != nil
}

func stepFailureEnforcing(step map[string]any) bool {
	if _, conditional := step["if"]; conditional {
		return false
	}
	return continueOnErrorSafe(step)
}

func continueOnErrorSafe(values map[string]any) bool {
	value, declared := values["continue-on-error"]
	if !declared {
		return true
	}
	enabled, boolean := value.(bool)
	return boolean && !enabled
}

func delimitedValues(value any) []string {
	var values []string
	for _, raw := range stringList(value) {
		for _, item := range strings.FieldsFunc(raw, func(r rune) bool { return r == '\n' || r == ',' }) {
			if item = strings.TrimSpace(item); item != "" {
				values = append(values, item)
			}
		}
	}
	return values
}

func checkoutRef(job map[string]any) (string, bool) {
	for _, value := range anyList(job["steps"]) {
		step, ok := value.(map[string]any)
		if !ok || !strings.HasPrefix(scalarString(step["uses"]), "actions/checkout@") {
			continue
		}
		with, _ := step["with"].(map[string]any)
		return scalarString(with["ref"]), true
	}
	return "", false
}

func requireNamedStep(t *testing.T, job map[string]any, name, context string) map[string]any {
	t.Helper()
	step, _ := requireNamedStepAt(t, job, name, context)
	return step
}

func requireNamedStepAt(t *testing.T, job map[string]any, name, context string) (map[string]any, int) {
	t.Helper()
	for index, value := range anyList(job["steps"]) {
		step, ok := value.(map[string]any)
		if ok && scalarString(step["name"]) == name {
			return step, index
		}
	}
	t.Fatalf("%s is missing step named %q", context, name)
	return nil, -1
}

func requireUsesStep(t *testing.T, job map[string]any, actionPrefix, context string) map[string]any {
	t.Helper()
	for _, value := range anyList(job["steps"]) {
		step, ok := value.(map[string]any)
		if ok && strings.HasPrefix(scalarString(step["uses"]), actionPrefix) {
			return step
		}
	}
	t.Fatalf("%s is missing a %s step", context, actionPrefix)
	return nil
}

func allStrings(value any) []string {
	switch value := value.(type) {
	case string:
		return []string{value}
	case []any:
		var values []string
		for _, item := range value {
			values = append(values, allStrings(item)...)
		}
		return values
	case map[string]any:
		var values []string
		for _, item := range value {
			values = append(values, allStrings(item)...)
		}
		return values
	default:
		return nil
	}
}

func mappingsNamed(value any, name string) []any {
	var found []any
	switch value := value.(type) {
	case []any:
		for _, item := range value {
			found = append(found, mappingsNamed(item, name)...)
		}
	case map[string]any:
		for key, item := range value {
			if key == name {
				found = append(found, item)
			}
			found = append(found, mappingsNamed(item, name)...)
		}
	}
	return found
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
