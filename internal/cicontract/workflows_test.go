package cicontract

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode"

	"gopkg.in/yaml.v3"
)

type workflowFile struct {
	name     string
	text     string
	document map[string]any
	triggers map[string]any
	jobs     map[string]any
}

func TestWorkflowContract(t *testing.T) {
	t.Run("canonical CI workflow has every fast validation job", testCanonicalCIJobs)
	t.Run("publication is gated and produces immutable amd64 images", testPublication)
	t.Run("VKE deploy follows successful CI runs at the exact commit", testVKEDeploy)
	t.Run("legacy deployments are manual only", testLegacyDeployments)
	t.Run("Helm publishing targets master and never main", testHelmPublishing)
	t.Run("full e2e runs on a schedule and on demand", testE2ETriggers)
	t.Run("active workflows never target main", testNoMainBranchTargets)
}

func testCanonicalCIJobs(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	if got := scalarString(workflow.document["name"]); got != "CI" {
		t.Errorf("ci.yml workflow name = %q, want %q", got, "CI")
	}

	for _, jobID := range []string{"go-test", "go-lint", "ui", "generated", "chart", "publish"} {
		if _, ok := workflow.jobs[jobID]; !ok {
			t.Errorf("ci.yml is missing required job ID %q", jobID)
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

	condition := compactExpression(scalarString(publish["if"]))
	if !strings.Contains(condition, "github.event_name=='push'") {
		t.Errorf("ci.yml publish.if must restrict publication to push events; got %q", scalarString(publish["if"]))
	}
	if !strings.Contains(condition, "github.ref=='refs/heads/master'") {
		t.Errorf("ci.yml publish.if must restrict publication to refs/heads/master; got %q", scalarString(publish["if"]))
	}
	if !strings.Contains(condition, "&&") || strings.Contains(condition, "||") {
		t.Errorf("ci.yml publish.if must require both the push event and master ref; got %q", scalarString(publish["if"]))
	}

	if permission(workflow, publish, "packages") != "write" {
		t.Errorf("ci.yml publish job must have packages: write permission")
	}

	publishText := marshalYAML(t, publish, "ci.yml publish job")
	for _, required := range []string{
		"linux/amd64",
		"ghcr.io/paprikacd/paprika:latest",
		"ghcr.io/paprikacd/paprika:sha-${{ github.sha }}",
	} {
		if !strings.Contains(publishText, required) {
			t.Errorf("ci.yml publish job must contain %q", required)
		}
	}
}

func testVKEDeploy(t *testing.T) {
	workflow := loadWorkflow(t, "deploy-vke.yml")
	if _, ok := workflow.triggers["workflow_dispatch"]; !ok {
		t.Error("deploy-vke.yml must preserve workflow_dispatch")
	}

	workflowRun := requireMappingValue(t, workflow.triggers, "workflow_run", "deploy-vke.yml triggers")
	if got := stringList(workflowRun["workflows"]); !contains(got, "CI") {
		t.Errorf("deploy-vke.yml workflow_run.workflows = %v, want CI", got)
	}
	if got := stringList(workflowRun["branches"]); !contains(got, "master") {
		t.Errorf("deploy-vke.yml workflow_run.branches = %v, want master", got)
	}

	deploy := requireMappingValue(t, workflow.jobs, "deploy", "deploy-vke.yml jobs")
	condition := compactExpression(scalarString(deploy["if"]))
	if !strings.Contains(condition, "github.event.workflow_run.conclusion=='success'") {
		t.Errorf("deploy-vke.yml deploy.if must require a successful CI workflow_run; got %q", scalarString(deploy["if"]))
	}

	checkoutRef, foundCheckout := checkoutRef(deploy)
	if !foundCheckout {
		t.Fatal("deploy-vke.yml deploy job has no actions/checkout step")
	}
	if !strings.Contains(checkoutRef, "github.event.workflow_run.head_sha") {
		t.Errorf("deploy-vke.yml checkout ref must use github.event.workflow_run.head_sha; got %q", checkoutRef)
	}

	if !hasSHAImageTag(deploy) {
		t.Error("deploy-vke.yml deploy job must derive its sha- image tag from github.event.workflow_run.head_sha")
	}
	deployText := marshalYAML(t, deploy, "deploy-vke.yml deploy job")
	if !strings.Contains(deployText, "env.IMAGE_TAG") {
		t.Error("deploy-vke.yml deployment steps must consume the exact IMAGE_TAG selected for the triggering SHA")
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
	if schedule, ok := workflow.triggers["schedule"]; !ok || len(anyList(schedule)) == 0 {
		t.Error("test-e2e.yml must declare at least one schedule")
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

			mainExpression := regexp.MustCompile(`(?i)(refs/heads/main\b|head_branch\s*==\s*['\"]main['\"]|ref_name\s*==\s*['\"]main['\"])`)
			if mainExpression.MatchString(workflow.text) {
				t.Errorf("%s contains an expression targeting the main branch", workflow.name)
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
		text:     string(data),
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

func compactExpression(expression string) string {
	expression = strings.ReplaceAll(expression, `"`, `'`)
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, expression)
}

func permission(workflow workflowFile, job map[string]any, name string) string {
	if permissions, ok := job["permissions"].(map[string]any); ok {
		if value := scalarString(permissions[name]); value != "" {
			return value
		}
	}
	if permissions, ok := workflow.document["permissions"].(map[string]any); ok {
		return scalarString(permissions[name])
	}
	return ""
}

func marshalYAML(t *testing.T, value any, context string) string {
	t.Helper()
	data, err := yaml.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", context, err)
	}
	return string(data)
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

func hasSHAImageTag(job map[string]any) bool {
	for _, value := range allStrings(job) {
		if strings.Contains(value, "github.event.workflow_run.head_sha") && strings.Contains(value, "sha-") {
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
