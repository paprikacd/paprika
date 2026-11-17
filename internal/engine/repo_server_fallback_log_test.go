package engine

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/go-logr/logr/funcr"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

func fallbackLogLevel(t *testing.T, err error) string {
	t.Helper()
	var got string
	logger := funcr.New(func(prefix, args string) {
		got = args
	}, funcr.Options{Verbosity: 1})
	ctx := log.IntoContext(context.Background(), logr.Logger(logger))
	logRepoServerFallback(ctx, err, "fallback", "name", "t")
	return got
}

func TestRepoServerFallbackLogsUnavailableAsInfo(t *testing.T) {
	t.Parallel()
	got := fallbackLogLevel(t, connect.NewError(connect.CodeUnavailable, errors.New("unexpected EOF")))
	if got == "" {
		t.Fatal("an unreachable repo server logged nothing; the fallback must stay visible at info")
	}
	if containsError(got) {
		t.Errorf("an unreachable repo server logged an error: %s", got)
	}
}

func TestRepoServerFallbackLogsOtherFailuresAsErrors(t *testing.T) {
	t.Parallel()
	for _, err := range []error{
		connect.NewError(connect.CodeUnknown, errors.New("render template: chart not found")),
		connect.NewError(connect.CodeInternal, errors.New("panic")),
		errors.New("plain error"),
	} {
		if got := fallbackLogLevel(t, err); !containsError(got) {
			t.Errorf("%v logged without an error: %s", err, got)
		}
	}
}

// funcr writes an "error" key only for logger.Error.
func containsError(args string) bool {
	return strings.Contains(args, `"error"=`) || strings.Contains(args, `"error":`)
}
