package auth

import (
	"context"
	"fmt"
	"log"
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

// Authorizer decides if a principal can perform an action on a resource.
type Authorizer interface {
	Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error
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

// DenyAllAuthorizer denies all requests. Used as a safe default fallback when
// no authorizer is configured, so that silence does not mean "allow".
type DenyAllAuthorizer struct{}

// Authorize always returns ErrUnauthorized.
func (a *DenyAllAuthorizer) Authorize(_ context.Context, _ *Principal, _ Action, _ Resource, _, _ string) error {
	return ErrUnauthorized
}

// Authorize checks if the principal can perform the action.
func (r *RBACAuthorizer) Authorize(_ context.Context, p *Principal, action Action, resource Resource, namespace, project string) error {
	for i := range r.rules {
		rule := &r.rules[i]
		s := r.matchesSubjects(rule, p)
		a := r.matchesActions(rule, action)
		res := r.matchesResources(rule, resource)
		ns := r.matchesNamespaces(rule, namespace)
		proj := r.matchesProjects(rule, project)
		log.Printf("RBAC rule %d: subjects=%v actions=%v resources=%v ns=%v proj=%v | match: subj=%v act=%v res=%v ns=%v proj=%v principal=%s",
			i, rule.Subjects, rule.Actions, rule.Resources, rule.Namespaces, rule.Projects,
			s, a, res, ns, proj, p.Subject)
		if !s || !a || !res || !ns || !proj {
			continue
		}
		return nil
	}
	return fmt.Errorf("%s cannot %s %s/%s (project=%s): %w", p.Subject, action, resource, namespace, project, ErrUnauthorized)
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
