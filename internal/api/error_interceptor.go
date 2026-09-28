package apiserver

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// K8sErrorInterceptor maps Kubernetes API errors to Connect codes so
// handlers can return raw apierrors without every call site wrapping them
// itself — detail_handler's "getting application: %w" style already threads
// the real cause through, and this maps it to a code callers can switch on.
// Without it a NotFound crosses the transport as CodeUnknown and MCP
// surfaces it as an opaque internal error.
func K8sErrorInterceptor() connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			resp, err := next(ctx, req)
			if err == nil {
				return resp, nil
			}
			var ce *connect.Error
			if errors.As(err, &ce) {
				return resp, err // already classified at the handler
			}
			switch {
			case apierrors.IsNotFound(err):
				return nil, connect.NewError(connect.CodeNotFound, err)
			case apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
				return nil, connect.NewError(connect.CodePermissionDenied, err)
			case apierrors.IsConflict(err), apierrors.IsAlreadyExists(err):
				return nil, connect.NewError(connect.CodeAlreadyExists, err)
			}
			return resp, err
		}
	}
}
