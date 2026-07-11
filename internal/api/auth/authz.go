package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Action represents an API action.
type Action string

const (
	ActionRead  Action = "read"
	ActionWrite Action = "write"
	ActionAdmin Action = "admin"
)

// Resource represents an API resource type.
type Resource string

const (
	ResourceApplications Resource = "applications"
	ResourcePipelines    Resource = "pipelines"
	ResourceReleases     Resource = "releases"
	ResourceStages       Resource = "stages"
	ResourceTemplates    Resource = "templates"
	ResourceArtifacts    Resource = "artifacts"
	ResourceRollouts     Resource = "rollouts"
)

// ProjectRef is the full identity of an AppProject. Project names are only
// unique within their Kubernetes namespace.
type ProjectRef struct {
	Namespace string
	Name      string
}

// Authorizer decides if a principal can perform an action on a resource.
type Authorizer interface {
	Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error
	AuthorizedProjects(ctx context.Context, p *Principal, action Action, resource Resource, candidates []ProjectRef) ([]ProjectRef, error)
}

// RBACRule defines a single RBAC permission.
type RBACRule struct {
	// Subjects is a list of user subjects or group names (with group: prefix).
	Subjects []string
	// Actions allowed (read, write, admin).
	Actions []string
	// Resources allowed (applications, pipelines, etc.). Use * for all.
	Resources []string
	// Namespaces allowed. Use * for all.
	Namespaces []string
	// Projects allowed. Use * for all. Empty means apply regardless of project.
	Projects []string `json:"projects,omitempty"`
}

// RBACAuthorizer implements a simple RBAC authorizer.
type RBACAuthorizer struct {
	rules []RBACRule
}

// NewRBACAuthorizer creates a new RBAC authorizer from rules.
func NewRBACAuthorizer(rules []RBACRule) *RBACAuthorizer {
	if rules == nil {
		rules = []RBACRule{}
	}
	return &RBACAuthorizer{rules: rules}
}

// AllowAllAuthorizer allows all authenticated requests.
type AllowAllAuthorizer struct{}

// Authorize always returns nil.
func (a *AllowAllAuthorizer) Authorize(_ context.Context, _ *Principal, _ Action, _ Resource, _, _ string) error {
	return nil
}

// AuthorizedProjects returns a defensive copy of every supplied candidate.
func (a *AllowAllAuthorizer) AuthorizedProjects(
	_ context.Context,
	_ *Principal,
	_ Action,
	_ Resource,
	candidates []ProjectRef,
) ([]ProjectRef, error) {
	return append([]ProjectRef(nil), candidates...), nil
}

// DenyAllAuthorizer denies all requests. Used as a safe default fallback when
// no authorizer is configured, so that silence does not mean "allow".
type DenyAllAuthorizer struct{}

// Authorize always returns ErrUnauthorized.
func (a *DenyAllAuthorizer) Authorize(_ context.Context, _ *Principal, _ Action, _ Resource, _, _ string) error {
	return ErrUnauthorized
}

// AuthorizedProjects returns an empty authorized set.
func (a *DenyAllAuthorizer) AuthorizedProjects(
	context.Context,
	*Principal,
	Action,
	Resource,
	[]ProjectRef,
) ([]ProjectRef, error) {
	return nil, nil
}

// Authorize checks if the principal can perform the action.
func (r *RBACAuthorizer) Authorize(_ context.Context, p *Principal, action Action, resource Resource, namespace, project string) error {
	for i := range r.rules {
		rule := &r.rules[i]
		if !r.matchesSubjects(rule, p) {
			continue
		}
		if !r.matchesActions(rule, action) {
			continue
		}
		if !r.matchesResources(rule, resource) {
			continue
		}
		if !r.matchesNamespaces(rule, namespace) {
			continue
		}
		if !r.matchesProjects(rule, project) {
			continue
		}
		return nil
	}
	return fmt.Errorf("%s cannot %s %s/%s (project=%s): %w", p.Subject, action, resource, namespace, project, ErrUnauthorized)
}

// AuthorizedProjects filters only the supplied candidates through the same
// RBAC rules used by Authorize.
func (r *RBACAuthorizer) AuthorizedProjects(
	ctx context.Context,
	p *Principal,
	action Action,
	resource Resource,
	candidates []ProjectRef,
) ([]ProjectRef, error) {
	return filterAuthorizedProjects(ctx, r, p, action, resource, candidates)
}

func filterAuthorizedProjects(
	ctx context.Context,
	authorizer interface {
		Authorize(context.Context, *Principal, Action, Resource, string, string) error
	},
	p *Principal,
	action Action,
	resource Resource,
	candidates []ProjectRef,
) ([]ProjectRef, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	authorized := make([]ProjectRef, 0, len(candidates))
	for _, candidate := range candidates {
		err := authorizer.Authorize(ctx, p, action, resource, candidate.Namespace, candidate.Name)
		switch {
		case err == nil:
			authorized = append(authorized, candidate)
		case errors.Is(err, ErrUnauthorized):
			continue
		default:
			return nil, fmt.Errorf("authorize project %s/%s: %w", candidate.Namespace, candidate.Name, err)
		}
	}
	return authorized, nil
}

func (r *RBACAuthorizer) matchesSubjects(rule *RBACRule, p *Principal) bool {
	if len(rule.Subjects) == 0 {
		return true
	}
	for _, sub := range rule.Subjects {
		if sub == "*" || sub == p.Subject {
			return true
		}
		if strings.HasPrefix(sub, "group:") {
			groupName := strings.TrimPrefix(sub, "group:")
			if p.IsInGroup(groupName) {
				return true
			}
		}
	}
	return false
}

func (r *RBACAuthorizer) matchesActions(rule *RBACRule, action Action) bool {
	for _, a := range rule.Actions {
		if a == "*" || a == string(action) {
			return true
		}
		if a == "admin" {
			return true
		}
		if a == "write" && action == ActionRead {
			return true
		}
	}
	return false
}

func (r *RBACAuthorizer) matchesResources(rule *RBACRule, resource Resource) bool {
	for _, res := range rule.Resources {
		if res == "*" || res == string(resource) {
			return true
		}
	}
	return false
}

func (r *RBACAuthorizer) matchesNamespaces(rule *RBACRule, namespace string) bool {
	for _, ns := range rule.Namespaces {
		if ns == "*" || ns == namespace {
			return true
		}
	}
	return false
}

func (r *RBACAuthorizer) matchesProjects(rule *RBACRule, project string) bool {
	if len(rule.Projects) == 0 || project == "" {
		return true
	}
	for _, p := range rule.Projects {
		if p == "*" || p == project {
			return true
		}
	}
	return false
}
