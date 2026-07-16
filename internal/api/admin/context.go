package admin

import (
	"context"
	"fmt"

	"github.com/benebsworth/paprika/internal/api/auth"
)

type adminContextKey struct{}

type adminContextMarker struct{}

var installedAdminMarker = &adminContextMarker{}

type validatedContext struct {
	marker      *adminContextMarker
	identity    ReviewedIdentity
	description SessionDescription
}

func WithValidatedSession(ctx context.Context, session *ValidatedSession) context.Context {
	if !session.valid() {
		return ctx
	}
	identity := session.Identity()
	state := &validatedContext{
		marker:      installedAdminMarker,
		identity:    identity,
		description: session.Description(),
	}
	ctx = context.WithValue(ctx, adminContextKey{}, state)
	return auth.WithPrincipal(ctx, principalForIdentity(identity))
}

func SessionDescriptionFromContext(ctx context.Context) (SessionDescription, bool) {
	state, ok := validatedContextFrom(ctx)
	if !ok {
		return SessionDescription{}, false
	}
	return state.description, true
}

func AccessModeFromContext(ctx context.Context) (string, bool) {
	if _, ok := validatedContextFrom(ctx); !ok {
		return "", false
	}
	return AccessMode, true
}

func ValidatedPrincipalFromContext(ctx context.Context) (*auth.Principal, bool) {
	state, ok := validatedContextFrom(ctx)
	if !ok {
		return nil, false
	}
	return principalForIdentity(state.identity), true
}

func validatedContextFrom(ctx context.Context) (*validatedContext, bool) {
	state, ok := ctx.Value(adminContextKey{}).(*validatedContext)
	return state, ok && state != nil && state.marker == installedAdminMarker
}

func principalForIdentity(identity ReviewedIdentity) *auth.Principal {
	return &auth.Principal{
		Subject: "kubernetes:" + identity.Username,
		Groups:  append([]string(nil), identity.Groups...),
	}
}

type AdminAwareAuthorizer struct {
	delegate auth.Authorizer
}

func NewAdminAwareAuthorizer(delegate auth.Authorizer) *AdminAwareAuthorizer {
	if delegate == nil {
		delegate = &auth.DenyAllAuthorizer{}
	}
	return &AdminAwareAuthorizer{delegate: delegate}
}

func (authorizer *AdminAwareAuthorizer) Authorize(
	ctx context.Context,
	principal *auth.Principal,
	action auth.Action,
	resource auth.Resource,
	namespace string,
	project string,
) error {
	if _, ok := validatedContextFrom(ctx); ok {
		return nil
	}
	if err := authorizer.delegate.Authorize(
		ctx,
		principal,
		action,
		resource,
		namespace,
		project,
	); err != nil {
		return fmt.Errorf("delegate authorization: %w", err)
	}
	return nil
}

func (authorizer *AdminAwareAuthorizer) AuthorizedProjects(
	ctx context.Context,
	principal *auth.Principal,
	action auth.Action,
	resource auth.Resource,
	candidates []auth.ProjectRef,
) ([]auth.ProjectRef, error) {
	if _, ok := validatedContextFrom(ctx); ok {
		return append([]auth.ProjectRef(nil), candidates...), nil
	}
	projects, err := authorizer.delegate.AuthorizedProjects(
		ctx,
		principal,
		action,
		resource,
		candidates,
	)
	if err != nil {
		return nil, fmt.Errorf("delegate project authorization: %w", err)
	}
	return projects, nil
}
