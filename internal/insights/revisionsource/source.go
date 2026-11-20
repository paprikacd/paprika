// Package revisionsource carries the source of a dashboard write in a request context. The API proxy reads it to stamp
// the revision a save records. It lives in a leaf package, because the API package and the Insights authoring client
// both need it and neither may import the other.
package revisionsource

import "context"

// MCP is the source of a write an in-process MCP tool makes for its caller. Writes that carry no source are UI saves.
const MCP = "mcp"

type sourceKey struct{}

// With returns a context that names the source of the Insights writes made with it. Only in-process code sets it: the
// API proxy never reads it from request headers, so a browser cannot choose a source.
func With(ctx context.Context, source string) context.Context {
	return context.WithValue(ctx, sourceKey{}, source)
}

// From returns the source With set, or "" when the context names none.
func From(ctx context.Context) string {
	source, ok := ctx.Value(sourceKey{}).(string)
	if !ok {
		return ""
	}
	return source
}
