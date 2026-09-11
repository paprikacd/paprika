package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	api "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
)

// recordingAuditor is an audit.Auditor that keeps every event it is given,
// so tests can assert on what was recorded rather than just that something
// was.
type recordingAuditor struct{ events []audit.Event }

func (r *recordingAuditor) Record(_ context.Context, e audit.Event) {
	r.events = append(r.events, e)
}

// stubTool returns a tool whose Invoke succeeds without touching Connect, so
// invoker tests exercise gating rather than RPC behaviour.
func stubTool(name string, scope Scope, destructive bool) Tool {
	return Tool{
		Name:        name,
		Description: name,
		Scope:       scope,
		Destructive: destructive,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Invoke: func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
			return map[string]string{"ok": name}, nil
		},
	}
}

// echoService answers every RPC. UnimplementedPaprikaServiceHandler returns
// CodeUnimplemented, which is fine for gating tests but not for audit tests —
// the audit interceptor records the attempt either way, which is exactly the
// behaviour under test.
type echoService struct {
	v1connect.UnimplementedPaprikaServiceHandler
}

// stubConnectClient returns a client wired through the REAL audit interceptor,
// so audit assertions exercise the production audit path rather than a
// reimplementation of it.
//
// The client must not be nil: the real write tools registered by
// RegisterWriteTools dereference it inside Invoke, so nil panics rather than
// failing cleanly. This is why newInvokerForRegistry cannot pass nil.
func stubConnectClient(t *testing.T, aud audit.Auditor) v1connect.PaprikaServiceClient {
	t.Helper()
	_, handler := v1connect.NewPaprikaServiceHandler(&echoService{},
		connect.WithInterceptors(api.NewAuditInterceptor(aud, nil)))
	return v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")
}

// newInvokerForRegistry wires an invoker around an existing registry.
func newInvokerForRegistry(t *testing.T, r *Registry) (*Invoker, *recordingAuditor) {
	t.Helper()
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	aud := &recordingAuditor{}
	return NewInvoker(r, stubConnectClient(t, aud), NewConfirmer(store, time.Minute), aud), aud
}

// newTestInvoker builds the three-tool registry used by the invoker tests.
func newTestInvoker(t *testing.T) (*Invoker, *recordingAuditor) {
	t.Helper()
	r := NewRegistry()
	require.NoError(t, r.Register(stubTool("fleet_status", ScopeRead, false)))
	require.NoError(t, r.Register(stubTool("sync_application", ScopeWrite, false)))
	require.NoError(t, r.Register(stubTool("rollback_release", ScopeWrite, true)))
	return newInvokerForRegistry(t, r)
}

// withConfirmation injects a confirmation token into an argument object,
// leaving all other fields byte-identical so the argument hash still matches.
func withConfirmation(args json.RawMessage, token string) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(args, &obj); err != nil {
		return nil, err
	}
	obj["confirmation_token"] = token
	return json.Marshal(obj)
}
