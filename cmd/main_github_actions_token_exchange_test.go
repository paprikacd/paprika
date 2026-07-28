package main

import (
	"reflect"
	"testing"
	"time"
)

func TestConfigureGitHubActionsTokenExchangeParsesTrustedWorkflowBoundary(t *testing.T) {
	t.Parallel()

	//nolint:gosec // Test-only configuration fixtures contain no credentials.
	environment := map[string]string{
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ENABLED":                   "true",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_AUDIENCE":                  "paprika-vke-deploy",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_REPOSITORY":                "paprikacd/paprika",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ENVIRONMENT":               "vke-production",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_SUBJECT":                   "repo:paprikacd/paprika:environment:vke-production",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ALLOWED_EVENT_NAMES":       "push, repository_dispatch",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_REF":                       "refs/heads/master",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ALLOWED_WORKFLOW_REFS":     "paprikacd/paprika/.github/workflows/ci.yml@refs/heads/master, paprikacd/paprika/.github/workflows/deploy-vke-manual.yml@refs/heads/master",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_JOB_WORKFLOW_REF":          "paprikacd/paprika/.github/workflows/deploy-vke.yml@refs/heads/master",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_SERVICE_ACCOUNT_NAMESPACE": "paprika-e2e",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_SERVICE_ACCOUNT_NAME":      "github-actions-vke-deployer",
		"PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_TOKEN_TTL":                 "10m",
	}
	getenv := func(name string) string { return environment[name] }

	var cfg cliConfig
	configureGitHubActionsTokenExchange(getenv, &cfg)

	allowedEventNames := configStringSliceField(t, cfg, "githubActionsTokenExchangeAllowedEventNames")
	if !reflect.DeepEqual(allowedEventNames, []string{"push", "repository_dispatch"}) {
		t.Errorf("allowed event names = %v", allowedEventNames)
	}
	if ref := configStringField(t, cfg, "githubActionsTokenExchangeRef"); ref != "refs/heads/master" {
		t.Errorf("ref = %q", ref)
	}
	wantWorkflowRefs := []string{
		"paprikacd/paprika/.github/workflows/ci.yml@refs/heads/master",
		"paprikacd/paprika/.github/workflows/deploy-vke-manual.yml@refs/heads/master",
	}
	allowedWorkflowRefs := configStringSliceField(t, cfg, "githubActionsTokenExchangeAllowedWorkflowRefs")
	if !reflect.DeepEqual(allowedWorkflowRefs, wantWorkflowRefs) {
		t.Errorf("allowed workflow refs = %v", allowedWorkflowRefs)
	}
	if jobWorkflowRef := configStringField(t, cfg, "githubActionsTokenExchangeJobWorkflowRef"); jobWorkflowRef != "paprikacd/paprika/.github/workflows/deploy-vke.yml@refs/heads/master" {
		t.Errorf("job workflow ref = %q", jobWorkflowRef)
	}
	if cfg.githubActionsTokenExchangeTTL != 10*time.Minute {
		t.Errorf("token TTL = %s", cfg.githubActionsTokenExchangeTTL)
	}
}

func configStringField(t *testing.T, cfg cliConfig, name string) string {
	t.Helper()
	field := reflect.ValueOf(cfg).FieldByName(name)
	if !field.IsValid() {
		t.Fatalf("cliConfig is missing field %s", name)
	}
	if field.Kind() != reflect.String {
		t.Fatalf("cliConfig.%s kind = %s, want string", name, field.Kind())
	}
	return field.String()
}

func configStringSliceField(t *testing.T, cfg cliConfig, name string) []string {
	t.Helper()
	field := reflect.ValueOf(cfg).FieldByName(name)
	if !field.IsValid() {
		t.Fatalf("cliConfig is missing field %s", name)
	}
	if field.Kind() != reflect.Slice || field.Type().Elem().Kind() != reflect.String {
		t.Fatalf("cliConfig.%s type = %s, want []string", name, field.Type())
	}
	values := make([]string, field.Len())
	for index := range values {
		values[index] = field.Index(index).String()
	}
	return values
}
