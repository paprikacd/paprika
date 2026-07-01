package observability

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	ctrl "sigs.k8s.io/controller-runtime"
)

// ReconcileSpan starts a top-level reconcile span for a controller.
// The returned context carries the span; the returned function should be
// called (ideally via defer) to end the span and record any error.
//
// When no OTLP endpoint is configured, otel.Tracer returns a noop tracer, so
// spans are effectively free (zero allocation). There is no need for a
// separate disabled fallback path.
//
// Usage:
//
//	func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
//	    ctx, endSpan := observability.ReconcileSpan(ctx, "MyKind", req)
//	    defer func() { endSpan(nil) }()
//	    // ... existing body ...
//	    if err != nil {
//	        endSpan(err)
//	        return ctrl.Result{}, err
//	    }
//	    return ctrl.Result{}, nil
//	}
func ReconcileSpan(ctx context.Context, controller string, req ctrl.Request) (spanCtx context.Context, end func(error)) {
	tracer := otel.Tracer("paprika/controller")
	spanCtx, span := tracer.Start(ctx, controller+".Reconcile",
		trace.WithAttributes(
			attribute.String("controller", controller),
			attribute.String("namespace", req.Namespace),
			attribute.String("name", req.Name),
		),
	)
	end = func(err error) {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}
	return spanCtx, end
}
