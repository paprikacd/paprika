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

func TestWorkflowContract(t *testing.T) {
	t.Run("canonical CI triggers fast validation jobs in parallel", testCanonicalCIValidation)
	t.Run("canonical CI pins third-party actions", testCanonicalCIActionPins)
	t.Run("canonical CI bounds job runtime", testCanonicalCIJobTimeouts)
	t.Run("generated drift detects stale and untracked output", testGeneratedDriftDetection)
	t.Run("publication is gated and exposes an immutable amd64 image digest", testPublication)
	t.Run("legacy image publisher is removed", testLegacyPublisherRemoved)
	t.Run("CI gates reusable VKE deployment on trusted published output", testCIDeployVKE)
	t.Run("VKE is callable and manually dispatchable without workflow_run", testVKETriggers)
	t.Run("VKE checks out the trusted caller commit and selects an image digest", testVKEProvenance)
	t.Run("VKE validates the immutable image reference before privileged operations", testVKEImageValidation)
	t.Run("VKE deploy applies one immutable reference to every component", testVKEComponentImageReferences)
	t.Run("downstream workflows pin third-party actions", testDownstreamActionPins)
	t.Run("downstream jobs bound their runtime", testDownstreamJobTimeouts)
	t.Run("legacy deployments are manual only", testLegacyDeployments)
	t.Run("Helm publishing targets master and never main", testHelmPublishing)
	t.Run("full e2e runs on a schedule and on demand", testE2ETriggers)
	t.Run("full e2e verifies the Kind download", testE2EKindChecksum)
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

	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart", "publish"} {
		if _, ok := workflow.jobs[jobID]; !ok {
			t.Errorf("ci.yml is missing required job ID %q", jobID)
		}
	}

	contracts := []validationJobContract{
		{id: "go-test", commands: []string{"make test-race"}},
		{id: "go-lint", commands: []string{"make lint-config", "make lint"}},
		{id: "ui", commands: []string{"npm ci", "npm test", "npm run lint", "npm run build"}, workingDirectory: "ui"},
		{id: "generated", commands: []string{"make generate-proto", "git diff --exit-code"}},
		{id: "chart", commands: []string{"helm lint charts/chart/", "helm template paprika charts/chart/"}},
	}
	for _, contract := range contracts {
		assertValidationJob(t, workflow, contract)
	}
}

func testCanonicalCIActionPins(t *testing.T) {
	assertWorkflowActionPins(t, loadWorkflow(t, "ci.yml"))
}

func testCanonicalCIJobTimeouts(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart", "publish"} {
		job := requireMappingValue(t, workflow.jobs, jobID, "ci.yml jobs")
		timeout, ok := job["timeout-minutes"].(int)
		if !ok || timeout < 5 || timeout > 30 {
			t.Errorf("ci.yml job %q timeout-minutes = %v, want an integer from 5 through 30", jobID, job["timeout-minutes"])
		}
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
	pinnedSHA := regexp.MustCompile(`^[0-9a-f]{40}$`)
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
			if !found || action == "" || !pinnedSHA.MatchString(revision) {
				t.Errorf("%s job %q step %d uses %q, want a full 40-character commit SHA", workflow.name, jobID, index+1, uses)
			}
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

func assertImageReferenceEnvironment(t *testing.T, job map[string]any, context string) {
	t.Helper()
	environment := requireMappingValue(t, job, "env", context)
	if got := normalizeExpression(scalarString(environment["IMAGE_REFERENCE"])); got != "inputs.image_ref" {
		t.Errorf("%s env.IMAGE_REFERENCE = %q after normalization, want inputs.image_ref", context, got)
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
	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart"} {
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
	if got := sortedKeys(workflow.triggers); len(got) != 2 || !contains(got, "workflow_call") || !contains(got, "workflow_dispatch") {
		t.Errorf("deploy-vke.yml triggers = %v, want exactly workflow_call and workflow_dispatch", got)
	}
	if _, exists := workflow.triggers["workflow_run"]; exists {
		t.Error("deploy-vke.yml must not expose a workflow_run trigger")
	}
	if containsParsedString(workflow.document, "workflow_run") {
		t.Error("deploy-vke.yml must not retain workflow_run conditions or references")
	}
	for _, triggerName := range []string{"workflow_call", "workflow_dispatch"} {
		trigger := requireMappingValue(t, workflow.triggers, triggerName, "deploy-vke.yml triggers")
		assertExactImageReferenceInput(t, trigger, "deploy-vke.yml "+triggerName)
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
	assertImageReferenceEnvironment(t, deploy, "deploy-vke.yml deploy job")
	if _, hasCondition := deploy["if"]; hasCondition {
		t.Errorf("deploy-vke.yml deploy job must trust its caller/manual authorization without a workflow_run condition; got %q", deploy["if"])
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
		"VKE_OIDC_CLIENT_SECRET":  "secrets.VKE_OIDC_CLIENT_SECRET",
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
	if strings.Contains(activeShellText(run), "latest") {
		t.Error("deploy-vke.yml deployment must not consume latest")
	}
}

func testDownstreamActionPins(t *testing.T) {
	for _, name := range []string{"deploy-vke.yml", "deploy-gke.yml", "deploy-cloudrun.yml", "helm-publish.yml", "test-e2e.yml"} {
		name := name
		t.Run(name, func(t *testing.T) {
			assertWorkflowActionPins(t, loadWorkflow(t, name))
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
}

func testDownstreamJobTimeouts(t *testing.T) {
	contracts := map[string]map[string][2]int{
		"deploy-vke.yml":      {"deploy": {5, 30}},
		"deploy-gke.yml":      {"deploy": {5, 30}},
		"deploy-cloudrun.yml": {"deploy": {5, 30}},
		"helm-publish.yml":    {"publish": {5, 30}},
		"test-e2e.yml":        {"test-e2e": {30, 60}},
	}
	for workflowName, jobs := range contracts {
		workflow := loadWorkflow(t, workflowName)
		for jobID, bounds := range jobs {
			job := requireMappingValue(t, workflow.jobs, jobID, workflowName+" jobs")
			assertJobTimeout(t, workflowName, jobID, job, bounds[0], bounds[1])
		}
	}
}

func testLegacyDeployments(t *testing.T) {
	for _, name := range []string{"deploy-gke.yml", "deploy-cloudrun.yml"} {
		name := name
		t.Run(name, func(t *testing.T) {
			workflow := loadWorkflow(t, name)
			dispatch, ok := workflow.triggers["workflow_dispatch"]
			if !ok {
				t.Errorf("%s must declare workflow_dispatch", name)
			}
			if _, ok := workflow.triggers["workflow_run"]; ok {
				t.Errorf("%s must not declare workflow_run", name)
			}
			if len(workflow.triggers) != 1 {
				t.Errorf("%s must be workflow_dispatch only; got triggers %v", name, sortedKeys(workflow.triggers))
			}
			if containsParsedString(workflow.document, "workflow_run") {
				t.Errorf("%s must not retain stale workflow_run conditions or references", name)
			}
			dispatchMapping, mapping := dispatch.(map[string]any)
			if !mapping {
				t.Fatalf("%s workflow_dispatch must be a mapping, got %T", name, dispatch)
			}
			assertExactImageReferenceInput(t, dispatchMapping, name+" workflow_dispatch")

			deploy := requireMappingValue(t, workflow.jobs, "deploy", name+" jobs")
			assertImageReferenceEnvironment(t, deploy, name+" deploy job")
			stepName := map[string]string{
				"deploy-gke.yml":      "Deploy via Helm",
				"deploy-cloudrun.yml": "Deploy to Cloud Run",
			}[name]
			assertImageReferenceValidator(t, deploy, name+" deploy job", []string{"Authenticate to GCP", stepName})
			step := requireNamedStep(t, deploy, stepName, name+" deploy job")
			run := scalarString(step["run"])
			if containsActiveShellFragment(run, "${{ inputs.image_ref }}") || containsActiveShellFragment(run, "github.sha") {
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

func containsParsedString(value any, want string) bool {
	for _, text := range allStrings(value) {
		if strings.Contains(text, want) {
			return true
		}
	}
	return false
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
