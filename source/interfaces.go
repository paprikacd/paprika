// Package source provides source resolution for git, S3, and other sources.
package source

import "context"

//go:generate mockgen -destination=mocks/git_source_resolver.go -package=mocks . GitSourceResolver
//go:generate mockgen -destination=mocks/s3_source_resolver.go -package=mocks . S3SourceResolver
//go:generate mockgen -destination=mocks/oci_source_resolver.go -package=mocks . OCISourceResolver

// GitSourceResolver resolves git sources.
type GitSourceResolver interface {
	Resolve(ctx context.Context) (*ResolveResult, error)
}

// S3SourceResolver resolves S3 sources.
type S3SourceResolver interface {
	Resolve(ctx context.Context) (*ResolveResult, error)
}

// OCISourceResolver resolves OCI sources.
type OCISourceResolver interface {
	Resolve(ctx context.Context) (*ResolveResult, error)
}
