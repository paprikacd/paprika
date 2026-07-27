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
	t.Run("publication is gated and produces immutable amd64 images", testPublication)
	t.Run("legacy image publisher is removed", testLegacyPublisherRemoved)
	t.Run("VKE triggers are exact and preserve manual dispatch", testVKETriggers)
	t.Run("VKE deploy permits manual or successful automatic runs", testVKEDeployCondition)
	t.Run("VKE automatic deploy selects the triggering commit image", testVKEAutomaticProvenance)
	t.Run("VKE manual tag input selects the deployed image", testVKEManualImageTag)
	t.Run("VKE deploy applies its selected tag to every component", testVKEComponentImageTags)
	t.Run("legacy deployments are manual only", testLegacyDeployments)
	t.Run("Helm publishing targets master and never main", testHelmPublishing)
	t.Run("full e2e runs on a schedule and on demand", testE2ETriggers)
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
	if len(workflowRunSteps(job)) == 0 {
		t.Errorf("ci.yml validation job %q must declare structured run steps", contract.id)
	}

	for _, command := range contract.commands {
		if !hasRunCommand(job, command, contract.workingDirectory) {
			t.Errorf("ci.yml validation job %q must actively run exact command %q and enforce its failure", contract.id, command)
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
	if _, ok := workflow.triggers["workflow_dispatch"]; !ok {
		t.Error("deploy-vke.yml must preserve workflow_dispatch")
	}

	workflowRun := requireMappingValue(t, workflow.triggers, "workflow_run", "deploy-vke.yml triggers")
	if got := stringList(workflowRun["workflows"]); !exactly(got, "CI") {
		t.Errorf("deploy-vke.yml workflow_run.workflows = %v, want exactly [CI]", got)
	}
	if got := stringList(workflowRun["branches"]); !exactly(got, "master") {
		t.Errorf("deploy-vke.yml workflow_run.branches = %v, want exactly [master]", got)
	}
}

func testVKEDeployCondition(t *testing.T) {
	deploy := vkeDeployJob(t)
	wantCondition := "github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'"
	if condition := normalizeExpression(scalarString(deploy["if"])); condition != wantCondition {
		t.Errorf("deploy-vke.yml deploy.if = %q after normalization, want %q", condition, wantCondition)
	}
}

func testVKEAutomaticProvenance(t *testing.T) {
	deploy := vkeDeployJob(t)
	checkoutRef, foundCheckout := checkoutRef(deploy)
	if !foundCheckout {
		t.Fatal("deploy-vke.yml deploy job has no actions/checkout step")
	}
	wantCheckoutRef := "github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha"
	normalizedCheckoutRef := normalizeExpression(checkoutRef)
	if normalizedCheckoutRef != wantCheckoutRef {
		t.Errorf("deploy-vke.yml checkout ref = %q after normalization, want %q", normalizedCheckoutRef, wantCheckoutRef)
	}

	imageTag := selectedImageTag(t, deploy)
	wantImageTag := "github.event_name == 'workflow_dispatch' && inputs.ref || format('sha-{0}', github.event.workflow_run.head_sha)"
	normalizedImageTag := normalizeExpression(imageTag)
	if normalizedImageTag != wantImageTag {
		t.Errorf("deploy-vke.yml IMAGE_TAG = %q after normalization, want %q", normalizedImageTag, wantImageTag)
	}
}

func testVKEManualImageTag(t *testing.T) {
	workflow := loadWorkflow(t, "deploy-vke.yml")
	dispatch := requireMappingValue(t, workflow.triggers, "workflow_dispatch", "deploy-vke.yml triggers")
	inputs := requireMappingValue(t, dispatch, "inputs", "deploy-vke.yml workflow_dispatch")
	ref := requireMappingValue(t, inputs, "ref", "deploy-vke.yml workflow_dispatch inputs")
	description := strings.ToLower(scalarString(ref["description"]))
	if !strings.Contains(description, "image") || !strings.Contains(description, "tag") {
		t.Errorf("deploy-vke.yml workflow_dispatch ref description must mention image and tag; got %q", ref["description"])
	}
	if required, ok := ref["required"].(bool); !ok || !required {
		t.Errorf("deploy-vke.yml workflow_dispatch ref.required = %v, want true", ref["required"])
	}
	if defaultValue, ok := ref["default"]; ok {
		t.Errorf("deploy-vke.yml workflow_dispatch ref must require an explicit tag without a default; got %q", defaultValue)
	}
}

func testVKEComponentImageTags(t *testing.T) {
	deployText := strings.Join(allStrings(vkeDeployJob(t)), "\n")
	for _, component := range []string{"manager", "apiServer", "repoServer", "webhookReceiver"} {
		pattern := regexp.MustCompile(regexp.QuoteMeta(component) + `\.image\.tag=["']?\$\{\{\s*env\.IMAGE_TAG\s*\}\}["']?`)
		if !pattern.MatchString(deployText) {
			t.Errorf("deploy-vke.yml must deploy %s with the computed env.IMAGE_TAG", component)
		}
	}
	if regexp.MustCompile(`(?i)\.image\.tag\s*=\s*["']?latest\b`).MatchString(deployText) {
		t.Error("deploy-vke.yml automatic deployment must not hard-code latest for any component")
	}
}

func testLegacyDeployments(t *testing.T) {
	for _, name := range []string{"deploy-gke.yml", "deploy-cloudrun.yml"} {
		name := name
		t.Run(name, func(t *testing.T) {
			workflow := loadWorkflow(t, name)
			if _, ok := workflow.triggers["workflow_dispatch"]; !ok {
				t.Errorf("%s must declare workflow_dispatch", name)
			}
			if _, ok := workflow.triggers["workflow_run"]; ok {
				t.Errorf("%s must not declare workflow_run", name)
			}
			if len(workflow.triggers) != 1 {
				t.Errorf("%s must be workflow_dispatch only; got triggers %v", name, sortedKeys(workflow.triggers))
			}
		})
	}
}

func testHelmPublishing(t *testing.T) {
	workflow := loadWorkflow(t, "helm-publish.yml")
	push := requireMappingValue(t, workflow.triggers, "push", "helm-publish.yml triggers")
	branches := stringList(push["branches"])
	if !contains(branches, "master") {
		t.Errorf("helm-publish.yml push.branches = %v, want master", branches)
	}
	if contains(branches, "main") {
		t.Errorf("helm-publish.yml push.branches must not target main; got %v", branches)
	}
}

func testE2ETriggers(t *testing.T) {
	workflow := loadWorkflow(t, "test-e2e.yml")
	if _, ok := workflow.triggers["workflow_dispatch"]; !ok {
		t.Error("test-e2e.yml must declare workflow_dispatch")
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

func selectedImageTag(t *testing.T, deploy map[string]any) string {
	t.Helper()
	environment := requireMappingValue(t, deploy, "env", "deploy-vke.yml deploy job")
	imageTag := scalarString(environment["IMAGE_TAG"])
	if imageTag == "" {
		t.Fatal("deploy-vke.yml deploy job must compute env.IMAGE_TAG")
	}
	return imageTag
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
	return !isTrue(step["continue-on-error"])
}

func isTrue(value any) bool {
	if enabled, ok := value.(bool); ok {
		return enabled
	}
	return strings.EqualFold(strings.TrimSpace(scalarString(value)), "true")
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
