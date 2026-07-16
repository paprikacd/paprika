package apiserver

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/api/admin"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/audit"
)

type capturingAuditor struct {
	events chan audit.Event
}

func (auditor *capturingAuditor) Record(_ context.Context, event audit.Event) {
	auditor.events <- event
}

func TestClassifyAudit(t *testing.T) {
	cases := []struct {
		procedure    string
		wantAction   string
		wantResource string
		wantMutating bool
	}{
		{"/paprika.v1.PaprikaService/SyncApplication", "update", "Application", true},
		{"/paprika.v1.PaprikaService/ApplyBundle", "apply", "Bundle", true},
		{"/paprika.v1.PaprikaService/ApproveGate", "approve", "Gate", true},
		{"/paprika.v1.PaprikaService/RejectGate", "reject", "Gate", true},
		{"/paprika.v1.PaprikaService/RollbackRelease", "update", "Release", true},
		{"/paprika.v1.PaprikaService/PromoteRollout", "promote", "Rollout", true},
		{"/paprika.v1.PaprikaService/AbortRollout", "update", "Rollout", true},
		{"/paprika.v1.PaprikaService/ListApplications", "", "", false},
		{"/paprika.v1.PaprikaService/GetApplication", "", "", false},
		{"/paprika.v1.PaprikaService/ListGateStatus", "", "", false},
		{"/paprika.v1.PaprikaService/ResolveSource", "", "", false},
		{"/paprika.v1.PaprikaService/Render", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.procedure, func(t *testing.T) {
			action, resource, mutating := classifyAudit(tc.procedure)
			if action != tc.wantAction || resource != tc.wantResource || mutating != tc.wantMutating {
				t.Errorf("classifyAudit(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tc.procedure, action, resource, mutating, tc.wantAction, tc.wantResource, tc.wantMutating)
			}
		})
	}
}

func TestClassifyAuditHandlesBareProcedure(t *testing.T) {
	action, resource, mutating := classifyAudit("SyncApplication")
	if !mutating || action != "update" || resource != "Application" {
		t.Errorf("classifyAudit(\"SyncApplication\") = (%q, %q, %v), want (update, Application, true)",
			action, resource, mutating)
	}
}

func TestPrincipalString(t *testing.T) {
	cases := []struct {
		name string
		p    *auth.Principal
		want string
	}{
		{"nil", nil, ""},
		{"subject wins", &auth.Principal{Subject: "sub-123", Email: "a@b.c", Name: "Alice"}, "sub-123"},
		{"email fallback", &auth.Principal{Email: "a@b.c", Name: "Alice"}, "a@b.c"},
		{"name fallback", &auth.Principal{Name: "Alice"}, "Alice"},
		{"empty", &auth.Principal{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := principalString(tc.p); got != tc.want {
				t.Errorf("principalString() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAuditValidatedAdminAccessModeUsesReviewedPrincipalWithoutSecrets(t *testing.T) {
	t.Parallel()

	store := admin.NewDefaultStore()
	sessionToken, _, err := store.Create(admin.ReviewedIdentity{
		Username: "alice@example.com",
		Groups:   []string{"platform-admins", "system:authenticated"},
		Extra: map[string][]string{
			"authentication.kubernetes.io/credential-id": {"exec:omega"},
		},
	}, types.UID("pod-uid-a"))
	require.NoError(t, err)
	session, err := store.Validate(sessionToken, types.UID("pod-uid-a"))
	require.NoError(t, err)
	presentedCredential := "review-input-" + t.Name()

	event, brokerEvent := runAuditedSync(t, func(ctx context.Context) context.Context {
		ctx = admin.WithValidatedSession(ctx, &session)
		return auth.WithPrincipal(ctx, &auth.Principal{Subject: "forged-after-validation"})
	}, sessionToken, presentedCredential)

	assert.Equal(t, "kubernetes:alice@example.com", event.Principal)
	assert.Equal(t, admin.AccessMode, event.Extra[audit.ExtraAccessModeKey])
	assert.Equal(t, "/paprika.v1.PaprikaService/SyncApplication", event.Extra["method"])
	for _, secret := range []string{sessionToken, presentedCredential} {
		assert.NotContains(t, fmt.Sprintf("%+v", event), secret)
		assert.NotContains(t, string(brokerEvent.Payload), secret)
	}
}

func TestAuditOrdinaryPrincipalHasNoAdminAccessMode(t *testing.T) {
	t.Parallel()

	event, _ := runAuditedSync(t, func(ctx context.Context) context.Context {
		return auth.WithPrincipal(ctx, &auth.Principal{Subject: "ordinary-user"})
	}, "caller-session", "caller-kubernetes-credential")

	assert.Equal(t, "ordinary-user", event.Principal)
	assert.NotContains(t, event.Extra, audit.ExtraAccessModeKey)
}

func runAuditedSync(
	t *testing.T,
	decorateContext func(context.Context) context.Context,
	sessionHeader string,
	authorizationCredential string,
) (audit.Event, *events.Event) {
	t.Helper()

	recorder := &capturingAuditor{events: make(chan audit.Event, 1)}
	broker := events.NewBroker(logr.Discard())
	t.Cleanup(broker.Close)
	subscriptionContext, cancelSubscription := context.WithCancel(context.Background())
	t.Cleanup(cancelSubscription)
	brokerEvents := broker.Subscribe(subscriptionContext, events.TopicDashboard)
	audited := NewAuditInterceptor(recorder, broker)(
		func(_ context.Context, _ connect.AnyRequest) (connect.AnyResponse, error) {
			return connect.NewResponse(&paprikav1.SyncApplicationResponse{}), nil
		},
	)
	const procedure = "/paprika.v1.PaprikaService/SyncApplication"
	handler := connect.NewUnaryHandler(
		procedure,
		func(
			ctx context.Context,
			request *connect.Request[paprikav1.SyncApplicationRequest],
		) (*connect.Response[paprikav1.SyncApplicationResponse], error) {
			response, err := audited(decorateContext(ctx), request)
			if err != nil {
				return nil, err
			}
			typed, ok := response.(*connect.Response[paprikav1.SyncApplicationResponse])
			if !ok {
				return nil, connect.NewError(connect.CodeInternal, errors.New("unexpected response type"))
			}
			return typed, nil
		},
	)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := connect.NewClient[paprikav1.SyncApplicationRequest, paprikav1.SyncApplicationResponse](
		server.Client(),
		server.URL+procedure,
	)
	request := connect.NewRequest(&paprikav1.SyncApplicationRequest{
		Namespace: "team-a",
		Name:      "payments",
	})
	request.Header().Set("X-Paprika-Admin-Session", sessionHeader)
	request.Header().Set("Authorization", "Bearer "+authorizationCredential)
	_, err := client.CallUnary(context.Background(), request)
	require.NoError(t, err)

	return receiveAuditEvent(t, recorder.events), receiveBrokerEvent(t, brokerEvents)
}

func receiveAuditEvent(t *testing.T, events <-chan audit.Event) audit.Event {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for audit event")
		return audit.Event{}
	}
}

func receiveBrokerEvent(t *testing.T, brokerEvents <-chan *events.Event) *events.Event {
	t.Helper()
	select {
	case event := <-brokerEvents:
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for broker event")
		return nil
	}
}
