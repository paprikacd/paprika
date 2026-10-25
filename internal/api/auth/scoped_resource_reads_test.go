package auth

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// Exercise real generated requests through the authorization interceptor: the
// detailed tree and both log RPCs name their owner namespace differently from
// the compact tree. A nested resource namespace must not replace that owner.
func TestScopedResourceReadAuthorization(t *testing.T) {
	t.Parallel()
	hash, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.MinCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(t.Context(), Config{
		Enabled:   true,
		BasicAuth: &BasicAuthConfig{Username: testUsername, PasswordHash: string(hash)},
		RBACRules: []RBACRule{{
			Subjects: []string{testUsername}, Actions: []string{"read"},
			Resources: []string{"*"}, Namespaces: []string{"review"},
		}},
	}, nil)
	require.NoError(t, err)
	service := &scopedResourceReadService{}
	_, handler := v1connect.NewPaprikaServiceHandler(service, connect.WithInterceptors(interceptor))
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := v1connect.NewPaprikaServiceClient(server.Client(), server.URL)
	authorization := "Basic " + base64.StdEncoding.EncodeToString([]byte(testUsername+":"+testPassword))
	calls := []struct {
		name string
		call func(string) error
	}{
		{"detailed tree", func(namespace string) error {
			req := connect.NewRequest(&v1.GetResourceTreeDetailedRequest{ApplicationNamespace: namespace, ApplicationName: "sample"})
			req.Header().Set("Authorization", authorization)
			_, err := client.GetResourceTreeDetailed(t.Context(), req)
			return err
		}},
		{"resource logs", func(namespace string) error {
			req := connect.NewRequest(&v1.GetResourceLogsRequest{
				ApplicationNamespace: namespace, ApplicationName: "sample",
				ResourceNamespace: "review", ResourceKind: "Pod", ResourceName: "sample-pod", TailLines: 5,
			})
			req.Header().Set("Authorization", authorization)
			_, err := client.GetResourceLogs(t.Context(), req)
			return err
		}},
		{"step logs", func(namespace string) error {
			req := connect.NewRequest(&v1.GetStepLogsRequest{PipelineNamespace: namespace, PipelineName: "sample", StepName: "test", TailLines: 5})
			req.Header().Set("Authorization", authorization)
			_, err := client.GetStepLogs(t.Context(), req)
			return err
		}},
		{"investigation", func(namespace string) error {
			req := connect.NewRequest(&v1.InvestigateRequest{
				ApplicationNamespace: namespace, ApplicationName: "sample",
				ResourceNamespace: "review", ResourceKind: "Deployment", ResourceName: "sample",
			})
			req.Header().Set("Authorization", authorization)
			_, err := client.Investigate(t.Context(), req)
			return err
		}},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			before := service.calls.Load()
			require.NoError(t, tc.call("review"))
			require.Equal(t, before+1, service.calls.Load())
			for _, namespace := range []string{"production", ""} {
				err := tc.call(namespace)
				require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
				require.Equal(t, before+1, service.calls.Load(), "denied owner namespaces must not reach the handler")
			}
		})
	}
	// The investigation exception must not grant actual delivery writes.
	before := service.calls.Load()
	req := connect.NewRequest(&v1.SyncApplicationRequest{Namespace: "review", Name: "sample"})
	req.Header().Set("Authorization", authorization)
	_, syncErr := client.SyncApplication(t.Context(), req)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(syncErr))
	require.Equal(t, before, service.calls.Load())
}

type scopedResourceReadService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	calls atomic.Int32
}

func (s *scopedResourceReadService) GetResourceTreeDetailed(context.Context, *connect.Request[v1.GetResourceTreeDetailedRequest]) (*connect.Response[v1.GetResourceTreeDetailedResponse], error) {
	s.calls.Add(1)
	return connect.NewResponse(&v1.GetResourceTreeDetailedResponse{}), nil
}

func (s *scopedResourceReadService) GetResourceLogs(context.Context, *connect.Request[v1.GetResourceLogsRequest]) (*connect.Response[v1.GetResourceLogsResponse], error) {
	s.calls.Add(1)
	return connect.NewResponse(&v1.GetResourceLogsResponse{}), nil
}

func (s *scopedResourceReadService) GetStepLogs(context.Context, *connect.Request[v1.GetStepLogsRequest]) (*connect.Response[v1.GetStepLogsResponse], error) {
	s.calls.Add(1)
	return connect.NewResponse(&v1.GetStepLogsResponse{}), nil
}

func (s *scopedResourceReadService) Investigate(context.Context, *connect.Request[v1.InvestigateRequest]) (*connect.Response[v1.InvestigateResponse], error) {
	s.calls.Add(1)
	return connect.NewResponse(&v1.InvestigateResponse{}), nil
}

func (s *scopedResourceReadService) SyncApplication(context.Context, *connect.Request[v1.SyncApplicationRequest]) (*connect.Response[v1.SyncApplicationResponse], error) {
	s.calls.Add(1)
	return connect.NewResponse(&v1.SyncApplicationResponse{}), nil
}
