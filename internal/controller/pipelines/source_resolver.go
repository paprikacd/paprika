// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	"github.com/benebsworth/paprika/internal/source"
)

//go:generate mockgen -destination=mocks/source_resolver.go -package=mocks -typed . SourceResolver

// SourceResolver resolves source locations.
type SourceResolver interface {
	Resolve(ctx context.Context) (*source.ResolveResult, error)
}

//go:generate mockgen -destination=mocks/git_source_resolver.go -package=mocks . GitSourceResolver

// GitSourceResolver resolves git sources.
type GitSourceResolver interface {
	Resolve(ctx context.Context) (*source.ResolveResult, error)
}

//go:generate mockgen -destination=mocks/s3_source_resolver.go -package=mocks . S3SourceResolver

// S3SourceResolver resolves S3 sources.
type S3SourceResolver interface {
	Resolve(ctx context.Context) (*source.ResolveResult, error)
}

//go:generate mockgen -destination=mocks/oci_source_resolver.go -package=mocks . OCISourceResolver

// OCISourceResolver resolves OCI sources.
type OCISourceResolver interface {
	Resolve(ctx context.Context) (*source.ResolveResult, error)
}
