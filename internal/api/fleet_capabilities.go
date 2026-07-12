package apiserver

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/fleet"
)

// fleetCapabilityGrant groups UI capabilities by their unique server-side
// permission tuple. In particular, rollback and gate approval are both release
// writes, so one authorization decision controls both capabilities.
type fleetCapabilityGrant struct {
	action       auth.Action
	resource     auth.Resource
	capabilities []fleet.Capability
}

var fleetCapabilityGrants = [...]fleetCapabilityGrant{
	{
		action:       auth.ActionWrite,
		resource:     auth.ResourceApplications,
		capabilities: []fleet.Capability{fleet.CapabilityApplicationSync},
	},
	{
		action:   auth.ActionWrite,
		resource: auth.ResourceReleases,
		capabilities: []fleet.Capability{
			fleet.CapabilityReleaseRollback,
			fleet.CapabilityGateApprove,
		},
	},
	{
		action:       auth.ActionWrite,
		resource:     auth.ResourcePipelines,
		capabilities: []fleet.Capability{fleet.CapabilityPipelineRetry},
	},
}

// buildFleetQueryScope derives visibility and capabilities exactly once for a
// fleet request. Candidate projects always originate from the cache-only fleet
// Reader. The authorizer may remove candidates, but its response is intersected
// with that actual set so it cannot invent visibility.
func buildFleetQueryScope(
	ctx context.Context,
	reader fleet.Reader,
	authorizer auth.Authorizer,
	principal *auth.Principal,
	namespaces []string,
) (fleet.QueryScope, error) {
	readScope, err := buildFleetReadQueryScope(ctx, reader, authorizer, principal, namespaces)
	if err != nil {
		return fleet.QueryScope{}, err
	}
	projects := sortedFleetProjectSet(readScope.Projects)
	if authorizer == nil {
		return unrestrictedFleetQueryScope(projects), nil
	}
	return authorizedFleetQueryScope(ctx, authorizer, principal, projects)
}

// buildFleetReadQueryScope derives only project visibility. Read-only callers
// use this scope without evaluating unrelated write capabilities.
func buildFleetReadQueryScope(
	ctx context.Context,
	reader fleet.Reader,
	authorizer auth.Authorizer,
	principal *auth.Principal,
	namespaces []string,
) (fleet.QueryScope, error) {
	if reader == nil {
		return fleet.QueryScope{}, &fleet.ErrUnavailable{Reason: "fleet reader is not configured"}
	}

	projectKeys, err := reader.ProjectKeys(ctx, namespaces)
	if err != nil {
		return fleet.QueryScope{}, fmt.Errorf("load fleet project candidates: %w", err)
	}
	projectKeys = uniqueFleetProjectKeys(projectKeys)

	if authorizer == nil {
		return fleetReadQueryScope(projectKeys), nil
	}
	if principal == nil {
		return fleet.QueryScope{}, fmt.Errorf("authorize fleet project scope: missing principal: %w", auth.ErrUnauthorized)
	}

	candidates := fleetProjectRefs(projectKeys)
	authorized, err := authorizer.AuthorizedProjects(
		ctx,
		principal,
		auth.ActionRead,
		auth.ResourceApplications,
		candidates,
	)
	if err != nil {
		return fleet.QueryScope{}, fmt.Errorf("authorize fleet project scope: %w", err)
	}
	authorizedProjects := intersectFleetProjects(projectKeys, authorized)
	return fleetReadQueryScope(authorizedProjects), nil
}

func fleetReadQueryScope(projects []fleet.ProjectKey) fleet.QueryScope {
	scope := fleet.QueryScope{
		Projects:              make(fleet.ProjectSet, len(projects)),
		CapabilitiesByProject: make(map[fleet.ProjectKey]fleet.CapabilitySet),
	}
	for _, project := range projects {
		scope.Projects[project] = struct{}{}
	}
	return scope
}

func sortedFleetProjectSet(projects fleet.ProjectSet) []fleet.ProjectKey {
	result := make([]fleet.ProjectKey, 0, len(projects))
	for project := range projects {
		result = append(result, project)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Namespace != result[j].Namespace {
			return result[i].Namespace < result[j].Namespace
		}
		return result[i].Name < result[j].Name
	})
	return result
}

func fleetProjectRefs(projects []fleet.ProjectKey) []auth.ProjectRef {
	refs := make([]auth.ProjectRef, 0, len(projects))
	for _, project := range projects {
		refs = append(refs, auth.ProjectRef{Namespace: project.Namespace, Name: project.Name})
	}
	return refs
}

func authorizedFleetQueryScope(
	ctx context.Context,
	authorizer auth.Authorizer,
	principal *auth.Principal,
	projects []fleet.ProjectKey,
) (fleet.QueryScope, error) {
	scope := fleet.QueryScope{
		Projects:              make(fleet.ProjectSet, len(projects)),
		CapabilitiesByProject: make(map[fleet.ProjectKey]fleet.CapabilitySet, len(projects)),
	}
	for _, project := range projects {
		scope.Projects[project] = struct{}{}
		capabilities, capabilityErr := authorizeFleetCapabilities(ctx, authorizer, principal, project)
		if capabilityErr != nil {
			return fleet.QueryScope{}, capabilityErr
		}
		scope.CapabilitiesByProject[project] = capabilities
	}
	return scope, nil
}

func intersectFleetProjects(actual []fleet.ProjectKey, authorized []auth.ProjectRef) []fleet.ProjectKey {
	authorizedSet := make(map[auth.ProjectRef]struct{}, len(authorized))
	for _, project := range authorized {
		authorizedSet[project] = struct{}{}
	}

	// Iterate actual candidates, not the authorizer response: this is stable,
	// ignores invented/duplicate responses, and preserves namespaced identity.
	intersection := make([]fleet.ProjectKey, 0, len(actual))
	for _, project := range actual {
		ref := auth.ProjectRef{Namespace: project.Namespace, Name: project.Name}
		if _, allowed := authorizedSet[ref]; allowed {
			intersection = append(intersection, project)
		}
	}
	return intersection
}

func unrestrictedFleetQueryScope(projects []fleet.ProjectKey) fleet.QueryScope {
	scope := fleet.QueryScope{
		Projects:              make(fleet.ProjectSet, len(projects)),
		CapabilitiesByProject: make(map[fleet.ProjectKey]fleet.CapabilitySet, len(projects)),
	}
	for _, project := range projects {
		scope.Projects[project] = struct{}{}
		capabilities := make(fleet.CapabilitySet, 4)
		for _, grant := range fleetCapabilityGrants {
			for _, capability := range grant.capabilities {
				capabilities[capability] = struct{}{}
			}
		}
		scope.CapabilitiesByProject[project] = capabilities
	}
	return scope
}

func authorizeFleetCapabilities(
	ctx context.Context,
	authorizer auth.Authorizer,
	principal *auth.Principal,
	project fleet.ProjectKey,
) (fleet.CapabilitySet, error) {
	capabilities := make(fleet.CapabilitySet, 4)
	for _, grant := range fleetCapabilityGrants {
		err := authorizer.Authorize(
			ctx,
			principal,
			grant.action,
			grant.resource,
			project.Namespace,
			project.Name,
		)
		if errors.Is(err, auth.ErrUnauthorized) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf(
				"authorize fleet capability for %s/%s (%s %s): %w",
				project.Namespace,
				project.Name,
				grant.action,
				grant.resource,
				err,
			)
		}
		for _, capability := range grant.capabilities {
			capabilities[capability] = struct{}{}
		}
	}
	return capabilities, nil
}

func uniqueFleetProjectKeys(projects []fleet.ProjectKey) []fleet.ProjectKey {
	seen := make(map[fleet.ProjectKey]struct{}, len(projects))
	unique := make([]fleet.ProjectKey, 0, len(projects))
	for _, project := range projects {
		if project.Namespace == "" || project.Name == "" {
			continue
		}
		if _, exists := seen[project]; exists {
			continue
		}
		seen[project] = struct{}{}
		unique = append(unique, project)
	}
	return unique
}
