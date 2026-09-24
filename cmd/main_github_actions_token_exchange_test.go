package main

import (
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigureGitHubActionsTokenExchangeParsesTrustedWorkflowBoundary(t *testing.T) {
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
	for key, value := range environment {
		t.Setenv(key, value)
	}

	cfg, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)

	assert.True(t, cfg.GitHubActionsTokenExchangeEnabled)
	assert.Equal(t, "paprika-vke-deploy", cfg.GitHubActionsTokenExchangeAudience)
	assert.Equal(t, "paprikacd/paprika", cfg.GitHubActionsTokenExchangeRepository)
	assert.Equal(t, "vke-production", cfg.GitHubActionsTokenExchangeEnvironment)
	assert.Equal(t, "repo:paprikacd/paprika:environment:vke-production", cfg.GitHubActionsTokenExchangeSubject)
	assert.Equal(t,
		[]string{"push", "repository_dispatch"},
		cfg.GitHubActionsTokenExchangeAllowedEventNames)
	assert.Equal(t, "refs/heads/master", cfg.GitHubActionsTokenExchangeRef)
	assert.Equal(t, []string{
		"paprikacd/paprika/.github/workflows/ci.yml@refs/heads/master",
		"paprikacd/paprika/.github/workflows/deploy-vke-manual.yml@refs/heads/master",
	}, cfg.GitHubActionsTokenExchangeAllowedWorkflowRefs)
	assert.Equal(t,
		"paprikacd/paprika/.github/workflows/deploy-vke.yml@refs/heads/master",
		cfg.GitHubActionsTokenExchangeJobWorkflowRef)
	assert.Equal(t, "paprika-e2e", cfg.GitHubActionsTokenExchangeServiceAccountNamespace)
	assert.Equal(t, "github-actions-vke-deployer", cfg.GitHubActionsTokenExchangeServiceAccountName)
	assert.Equal(t, 10*time.Minute, cfg.GitHubActionsTokenExchangeTTL)
}

func TestGitHubActionsTokenExchangeDefaults(t *testing.T) {
	cfg, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.False(t, cfg.GitHubActionsTokenExchangeEnabled)
	assert.Equal(t, 15*time.Minute, cfg.GitHubActionsTokenExchangeTTL)
}
