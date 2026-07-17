package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
	"github.com/go-logr/logr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	crfake "sigs.k8s.io/controller-runtime/pkg/client/fake"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/admin"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestAdminDashboardFlagIsDefaultOffAndHasNoAddressOverride(t *testing.T) {
	t.Parallel()

	cfg, err := registerFlags(nil, func(string) string { return "" }, discardWriter{})
	require.NoError(t, err)
	assert.False(t, cfg.adminDashboardEnabled)

	cfg, err = registerFlags(
		[]string{"--admin-dashboard-enabled"},
		adminEnvironment(nil),
		discardWriter{},
	)
	require.NoError(t, err)
	assert.True(t, cfg.adminDashboardEnabled)

	for _, flag := range []string{
		"--admin-dashboard-host=0.0.0.0",
		"--admin-dashboard-port=3002",
		"--admin-dashboard-bind-address=:3002",
	} {
		_, err = registerFlags([]string{flag}, func(string) string { return "" }, discardWriter{})
		require.Error(t, err, flag)
		assert.Contains(t, err.Error(), "flag provided but not defined")
	}
}

func TestAdminDashboardRejectsIneligibleModesBeforeStartup(t *testing.T) {
	t.Parallel()

	for _, mode := range []string{"webhook", "repo-server", "agent"} {
		cfg := &cliConfig{mode: mode, adminDashboardEnabled: true}
		err := validateAdminDashboardMode(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "--admin-dashboard-enabled")
		assert.Contains(t, err.Error(), mode)
		assert.Contains(t, err.Error(), "api")
		assert.Contains(t, err.Error(), "operator")
	}

	for _, mode := range []string{"api", "operator"} {
		require.NoError(t, validateAdminDashboardMode(&cliConfig{
			mode:                  mode,
			adminDashboardEnabled: true,
		}))
	}
	require.NoError(t, validateAdminDashboardMode(&cliConfig{
		mode:                  "webhook",
		adminDashboardEnabled: false,
	}))
}

func TestAdminDashboardLoadsExactPodIdentityOnlyWhenEnabled(t *testing.T) {
	t.Parallel()

	cfg, err := registerFlags(nil, func(string) string { return "" }, discardWriter{})
	require.NoError(t, err)
	assert.Equal(t, admin.PodIdentity{}, cfg.adminPodIdentity)

	cfg, err = registerFlags(
		[]string{"--mode=api", "--admin-dashboard-enabled"},
		adminEnvironment(nil),
		discardWriter{},
	)
	require.NoError(t, err)
	assert.Equal(t, admin.PodIdentity{
		Namespace:          "paprika-system",
		Name:               "paprika-api-abc",
		UID:                types.UID("53b1751e-a810-4a30-97ef-842ca5470db8"),
		ServiceAccount:     "paprika-api",
		ExpectedContainers: []string{"api-server"},
	}, cfg.adminPodIdentity)

	required := []string{
		"POD_NAMESPACE",
		"POD_NAME",
		"POD_UID",
		"POD_SERVICE_ACCOUNT",
		"PAPRIKA_ADMIN_EXPECTED_CONTAINER",
	}
	for _, name := range required {
		name := name
		t.Run("missing "+name, func(t *testing.T) {
			_, configErr := registerFlags(
				[]string{"--mode=api", "--admin-dashboard-enabled"},
				adminEnvironment(map[string]string{name: ""}),
				discardWriter{},
			)
			require.Error(t, configErr)
			assert.Contains(t, configErr.Error(), name)
		})
		t.Run("whitespace "+name, func(t *testing.T) {
			_, configErr := registerFlags(
				[]string{"--mode=api", "--admin-dashboard-enabled"},
				adminEnvironment(map[string]string{name: " invalid "}),
				discardWriter{},
			)
			require.Error(t, configErr)
			assert.Contains(t, configErr.Error(), name)
		})
	}
}

func TestAdminDashboardBuildsSeparateServerWithSharedDependencies(t *testing.T) {
	t.Parallel()

	scheme := newScheme()
	apiClient := crfake.NewClientBuilder().WithScheme(scheme).Build()
	k8sClient := fake.NewSimpleClientset()
	broker := events.NewBroker(logr.Discard())
	t.Cleanup(broker.Close)
	fleetIndex := fleet.NewIndex()
	require.NoError(t, fleetIndex.Install(fleet.NewSnapshot(1)))
	normalAuthorizer := &auth.DenyAllAuthorizer{}
	otelInterceptor, err := otelconnect.NewInterceptor()
	require.NoError(t, err)
	assembly := &paprikaServerAssembly{
		apiClient:        apiClient,
		k8sClient:        k8sClient,
		broker:           broker,
		fleetReader:      fleetIndex,
		normalAuthorizer: normalAuthorizer,
		otelInterceptor:  otelInterceptor,
	}

	normalServer := assembly.newNormalServer()
	adminServer, handler, err := buildAdminDashboardHandler(
		assembly,
		&admin.PodIdentity{
			Namespace:          "paprika-system",
			Name:               "paprika-api-abc",
			UID:                types.UID("53b1751e-a810-4a30-97ef-842ca5470db8"),
			ServiceAccount:     "paprika-api",
			ExpectedContainers: []string{"api-server"},
		},
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
		logr.Discard(),
	)
	require.NoError(t, err)
	require.NotNil(t, handler)
	assert.NotSame(t, normalServer, adminServer)
	assert.Same(t, apiClient, assembly.apiClient)
	assert.Same(t, k8sClient, assembly.k8sClient)
	assert.Same(t, broker, adminServer.Broker())
}

func TestAdminDashboardAssembledHandlerBypassesOnlyItsOwnOrdinaryAuthChain(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	assembly.normalAuthorizer = &auth.DenyAllAuthorizer{}
	k8sClient, ok := assembly.k8sClient.(*fake.Clientset)
	require.True(t, ok)
	configureSuccessfulAdminKubernetesReview(t, k8sClient)

	normalServer := assembly.newNormalServer()
	ordinaryAuthCalled := false
	ordinaryAuth := connect.UnaryInterceptorFunc(func(_ connect.UnaryFunc) connect.UnaryFunc {
		return func(
			context.Context,
			connect.AnyRequest,
		) (connect.AnyResponse, error) {
			ordinaryAuthCalled = true
			return nil, connect.NewError(
				connect.CodeUnauthenticated,
				errors.New("ordinary authentication required"),
			)
		}
	})
	_, normalConnectHandler := v1connect.NewPaprikaServiceHandler(
		normalServer,
		connect.WithInterceptors(
			assembly.otelInterceptor,
			ordinaryAuth,
			normalServer.AuditInterceptor(),
		),
	)
	normalMux := http.NewServeMux()
	normalMux.Handle("/paprika.v1.PaprikaService/", normalConnectHandler)
	normalHTTPServer := httptest.NewServer(normalMux)
	defer normalHTTPServer.Close()

	_, adminHandler, err := buildAdminDashboardHandler(
		assembly,
		&enabledAdminTestConfig("api").adminPodIdentity,
		http.NotFoundHandler(),
		logr.Discard(),
	)
	require.NoError(t, err)
	exchange := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		admin.AdminListenerOrigin+"/admin/session/exchange",
		http.NoBody,
	)
	exchange.Host = admin.AdminListenerAddress
	exchange.Header.Set("Origin", admin.AdminListenerOrigin)
	exchange.Header.Set("Authorization", "Bearer reviewed-kubernetes-token")
	exchangeRecorder := httptest.NewRecorder()
	adminHandler.ServeHTTP(exchangeRecorder, exchange)
	require.Equal(
		t,
		http.StatusCreated,
		exchangeRecorder.Code,
		exchangeRecorder.Body.String(),
	)
	var exchanged admin.ExchangeResponse
	require.NoError(t, json.Unmarshal(exchangeRecorder.Body.Bytes(), &exchanged))
	require.NotEmpty(t, exchanged.Token)

	adminHTTPServer := httptest.NewServer(adminHandler)
	defer adminHTTPServer.Close()
	adminHTTPClient := &http.Client{
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			forward := request.Clone(request.Context())
			forward.Header = request.Header.Clone()
			forward.Host = admin.AdminListenerAddress
			forward.Header.Set("Origin", admin.AdminListenerOrigin)
			return http.DefaultTransport.RoundTrip(forward)
		}),
	}
	adminClient := v1connect.NewPaprikaServiceClient(
		adminHTTPClient,
		adminHTTPServer.URL,
	)
	adminRequest := connect.NewRequest(&paprikav1.QueryFleetMapRequest{})
	adminRequest.Header().Set(admin.AdminSessionHeader, exchanged.Token)
	_, err = adminClient.QueryFleetMap(t.Context(), adminRequest)
	require.NoError(t, err)
	assert.False(t, ordinaryAuthCalled)

	normalClient := v1connect.NewPaprikaServiceClient(
		normalHTTPServer.Client(),
		normalHTTPServer.URL,
	)
	normalRequest := connect.NewRequest(&paprikav1.QueryFleetMapRequest{})
	normalRequest.Header().Set(admin.AdminSessionHeader, exchanged.Token)
	_, err = normalClient.QueryFleetMap(t.Context(), normalRequest)
	require.Error(t, err)
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	assert.True(t, ordinaryAuthCalled)
}

func configureSuccessfulAdminKubernetesReview(
	t *testing.T,
	clientset *fake.Clientset,
) {
	t.Helper()
	identity := enabledAdminTestConfig("api").adminPodIdentity
	_, err := clientset.CoreV1().Pods(identity.Namespace).Create(
		t.Context(),
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Namespace: identity.Namespace,
				Name:      identity.Name,
				UID:       identity.UID,
			},
			Spec: corev1.PodSpec{
				ServiceAccountName: identity.ServiceAccount,
				Containers: []corev1.Container{
					{Name: identity.ExpectedContainers[0]},
				},
			},
		},
		metav1.CreateOptions{},
	)
	require.NoError(t, err)
	clientset.Fake.PrependReactor(
		"create",
		"tokenreviews",
		func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, &authenticationv1.TokenReview{
				Status: authenticationv1.TokenReviewStatus{
					Authenticated: true,
					User: authenticationv1.UserInfo{
						Username: "alice@example.com",
						Groups:   []string{"platform-admins"},
					},
				},
			}, nil
		},
	)
	clientset.Fake.PrependReactor(
		"create",
		"subjectaccessreviews",
		func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, &authorizationv1.SubjectAccessReview{
				Status: authorizationv1.SubjectAccessReviewStatus{
					Allowed: true,
				},
			}, nil
		},
	)
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (function roundTripperFunc) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	return function(request)
}

func TestAdminDashboardLifecycleCancellationClosesAndJoinsBothListeners(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	normalStarted := make(chan struct{})
	normalStopped := make(chan struct{})
	listener := newFakeAdminDashboardListener()
	done := make(chan error, 1)
	go func() {
		done <- runAdminDashboardLifecycle(
			ctx,
			listener,
			adminLifecycleComponent{
				name: "normal listener",
				start: func(ctx context.Context) error {
					close(normalStarted)
					defer close(normalStopped)
					<-ctx.Done()
					return nil
				},
			},
		)
	}()

	awaitSignal(t, normalStarted, "normal listener start")
	awaitSignal(t, listener.started, "admin listener start")
	cancel()
	require.NoError(t, awaitLifecycleResult(t, done))
	awaitSignal(t, normalStopped, "normal listener join")
	assert.Equal(t, 1, listener.closeCount())
	awaitSignal(t, listener.stopped, "admin listener join")
}

func TestAdminDashboardLifecycleUnexpectedAdminExitCancelsAndJoinsNormal(t *testing.T) {
	t.Parallel()

	normalStarted := make(chan struct{})
	normalStopped := make(chan struct{})
	listener := newFakeAdminDashboardListener()
	done := make(chan error, 1)
	go func() {
		done <- runAdminDashboardLifecycle(
			t.Context(),
			listener,
			adminLifecycleComponent{
				name: "normal listener",
				start: func(ctx context.Context) error {
					close(normalStarted)
					defer close(normalStopped)
					<-ctx.Done()
					return nil
				},
			},
		)
	}()

	awaitSignal(t, normalStarted, "normal listener start")
	awaitSignal(t, listener.started, "admin listener start")
	listener.exit <- nil
	err := awaitLifecycleResult(t, done)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "admin dashboard listener stopped unexpectedly")
	awaitSignal(t, normalStopped, "normal listener canceled and joined")
	assert.Equal(t, 1, listener.closeCount())
}

func adminEnvironment(overrides map[string]string) func(string) string {
	values := map[string]string{
		"POD_NAMESPACE":                    "paprika-system",
		"POD_NAME":                         "paprika-api-abc",
		"POD_UID":                          "53b1751e-a810-4a30-97ef-842ca5470db8",
		"POD_SERVICE_ACCOUNT":              "paprika-api",
		"PAPRIKA_ADMIN_EXPECTED_CONTAINER": "api-server",
	}
	for key, value := range overrides {
		values[key] = value
	}
	return func(name string) string {
		return values[name]
	}
}

type discardWriter struct{}

func (discardWriter) Write(value []byte) (int, error) {
	return len(value), nil
}

type fakeAdminDashboardListener struct {
	started  chan struct{}
	stopped  chan struct{}
	exit     chan error
	closed   chan struct{}
	closeErr error
	once     sync.Once
	mu       sync.Mutex
	closes   int
}

func newFakeAdminDashboardListener() *fakeAdminDashboardListener {
	return &fakeAdminDashboardListener{
		started: make(chan struct{}),
		stopped: make(chan struct{}),
		exit:    make(chan error, 1),
		closed:  make(chan struct{}),
	}
}

func (listener *fakeAdminDashboardListener) Serve() error {
	close(listener.started)
	defer close(listener.stopped)
	select {
	case err := <-listener.exit:
		return err
	case <-listener.closed:
		return nil
	}
}

func (listener *fakeAdminDashboardListener) Close() error {
	listener.mu.Lock()
	listener.closes++
	listener.mu.Unlock()
	listener.once.Do(func() {
		close(listener.closed)
	})
	return listener.closeErr
}

func (listener *fakeAdminDashboardListener) closeCount() int {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return listener.closes
}

func TestAdminDashboardModeErrorIsActionable(t *testing.T) {
	t.Parallel()

	err := validateAdminDashboardMode(&cliConfig{
		mode:                  "agent",
		adminDashboardEnabled: true,
	})
	require.Error(t, err)
	assert.True(t, errors.Is(err, errAdminDashboardMode))
	assert.True(t, strings.Contains(err.Error(), "operator") && strings.Contains(err.Error(), "api"))
}

func TestAdminDashboardLifecycleClosesListenerWhenNormalFails(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("normal failed")
	listener := newFakeAdminDashboardListener()
	err := runAdminDashboardLifecycle(
		t.Context(),
		listener,
		adminLifecycleComponent{
			name: "normal listener",
			start: func(context.Context) error {
				return wantErr
			},
		},
	)
	require.Error(t, err)
	assert.ErrorIs(t, err, wantErr)
	awaitSignal(t, listener.stopped, "admin listener join after normal failure")
	assert.Equal(t, 1, listener.closeCount())
}

func TestAdminDashboardLifecycleDoesNotReturnBeforeSlowSiblingJoins(t *testing.T) {
	t.Parallel()

	listener := newFakeAdminDashboardListener()
	joined := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runAdminDashboardLifecycle(
			t.Context(),
			listener,
			adminLifecycleComponent{
				name: "normal listener",
				start: func(ctx context.Context) error {
					<-ctx.Done()
					<-release
					close(joined)
					return nil
				},
			},
		)
	}()

	awaitSignal(t, listener.started, "admin listener start")
	listener.exit <- errors.New("admin failed")
	select {
	case err := <-done:
		t.Fatalf("lifecycle returned before normal joined: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	err := awaitLifecycleResult(t, done)
	require.Error(t, err)
	awaitSignal(t, joined, "slow normal listener join")
}

func TestAdminDashboardLifecycleValidatesAllComponentsBeforeStartingAny(t *testing.T) {
	t.Parallel()

	componentStarted := make(chan struct{})
	listener := newFakeAdminDashboardListener()
	err := runAdminDashboardLifecycle(
		t.Context(),
		listener,
		adminLifecycleComponent{
			name: "valid component",
			start: func(context.Context) error {
				close(componentStarted)
				return nil
			},
		},
		adminLifecycleComponent{},
	)
	require.Error(t, err)
	assertNoSignal(t, componentStarted, "component before complete lifecycle validation")
	assertNoSignal(t, listener.started, "admin listener before complete lifecycle validation")
}

func TestAdminDashboardListenerFactoryErrorFailsSynchronously(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("fixed loopback address is already in use")
	called := false
	listener, err := bindAdminDashboardListener(
		t.Context(),
		http.NotFoundHandler(),
		func(context.Context, http.Handler) (adminDashboardListener, error) {
			called = true
			return nil, wantErr
		},
	)
	require.Error(t, err)
	assert.ErrorIs(t, err, wantErr)
	assert.Nil(t, listener)
	assert.True(t, called)
}

func TestAdminDashboardAPIModeRuntimePropagatesSynchronousBindFailureBeforeAvailability(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	wantErr := errors.New("fixed admin address is already in use")
	normalStarted := false
	err := runAPIModeRuntime(t.Context(), apiModeRuntimeConfig{
		cfg:       enabledAdminTestConfig("api"),
		assembly:  assembly,
		uiHandler: http.NotFoundHandler(),
		listenerFactory: func(
			context.Context,
			http.Handler,
		) (adminDashboardListener, error) {
			return nil, wantErr
		},
		normalStart: func(context.Context) error {
			normalStarted = true
			return nil
		},
		log: logr.Discard(),
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, wantErr)
	assert.False(t, normalStarted)
}

func TestAdminDashboardAPIModeRuntimeJoinsNormalOnUnexpectedAdminExit(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	listener := newFakeAdminDashboardListener()
	normalStarted := make(chan struct{})
	normalStopped := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runAPIModeRuntime(t.Context(), apiModeRuntimeConfig{
			cfg:       enabledAdminTestConfig("api"),
			assembly:  assembly,
			uiHandler: http.NotFoundHandler(),
			listenerFactory: func(
				context.Context,
				http.Handler,
			) (adminDashboardListener, error) {
				return listener, nil
			},
			normalStart: func(ctx context.Context) error {
				close(normalStarted)
				defer close(normalStopped)
				<-ctx.Done()
				return nil
			},
			log: logr.Discard(),
		})
	}()

	awaitSignal(t, listener.started, "API admin listener start")
	awaitSignal(t, normalStarted, "API normal mode start")
	listener.exit <- nil
	err := awaitLifecycleResult(t, done)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "admin dashboard listener stopped unexpectedly")
	awaitSignal(t, normalStopped, "API normal mode join")
	assert.Equal(t, 1, listener.closeCount())
}

func TestAdminDashboardAPIModeRuntimeClosesListenerOnceOnCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	assembly := newRuntimeTestAssembly(t)
	listener := newFakeAdminDashboardListener()
	normalStarted := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runAPIModeRuntime(ctx, apiModeRuntimeConfig{
			cfg:       enabledAdminTestConfig("api"),
			assembly:  assembly,
			uiHandler: http.NotFoundHandler(),
			listenerFactory: func(
				context.Context,
				http.Handler,
			) (adminDashboardListener, error) {
				return listener, nil
			},
			normalStart: func(ctx context.Context) error {
				close(normalStarted)
				<-ctx.Done()
				return nil
			},
			log: logr.Discard(),
		})
	}()

	awaitSignal(t, listener.started, "API admin listener start")
	awaitSignal(t, normalStarted, "API normal mode start")
	cancel()
	require.NoError(t, awaitLifecycleResult(t, done))
	assert.Equal(t, 1, listener.closeCount())
}

func TestAdminDashboardAPIModeRuntimeClosesListenerOnceOnNormalFailure(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	listener := newFakeAdminDashboardListener()
	wantErr := errors.New("normal API failed")
	err := runAPIModeRuntime(t.Context(), apiModeRuntimeConfig{
		cfg:       enabledAdminTestConfig("api"),
		assembly:  assembly,
		uiHandler: http.NotFoundHandler(),
		listenerFactory: func(
			context.Context,
			http.Handler,
		) (adminDashboardListener, error) {
			return listener, nil
		},
		normalStart: func(context.Context) error {
			return wantErr
		},
		log: logr.Discard(),
	})

	require.Error(t, err)
	assert.ErrorIs(t, err, wantErr)
	assert.Equal(t, 1, listener.closeCount())
}

func TestAdminDashboardAPIModeRuntimeDisabledPreservesNormalPath(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	wantErr := errors.New("normal API result")
	factoryCalled := false
	normalCalled := false
	err := runAPIModeRuntime(t.Context(), apiModeRuntimeConfig{
		cfg:       &cliConfig{mode: "api"},
		assembly:  assembly,
		uiHandler: http.NotFoundHandler(),
		listenerFactory: func(
			context.Context,
			http.Handler,
		) (adminDashboardListener, error) {
			factoryCalled = true
			return nil, errors.New("must not be called")
		},
		normalStart: func(context.Context) error {
			normalCalled = true
			return wantErr
		},
		log: logr.Discard(),
	})
	assert.ErrorIs(t, err, wantErr)
	assert.True(t, normalCalled)
	assert.False(t, factoryCalled)
}

func TestAdminDashboardOperatorModeRuntimePropagatesSynchronousBindFailureBeforeAvailability(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	wantErr := errors.New("fixed admin address is already in use")
	detachedUICalled := false
	beforeManagerCalled := false
	managerCalled := false
	err := runOperatorModeRuntime(t.Context(), &operatorModeRuntimeConfig{
		cfg:       enabledAdminTestConfig("operator"),
		assembly:  assembly,
		uiHandler: http.NotFoundHandler(),
		listenerFactory: func(
			context.Context,
			http.Handler,
		) (adminDashboardListener, error) {
			return nil, wantErr
		},
		startDetachedUI: func(context.Context) {
			detachedUICalled = true
		},
		beforeManager: func() error {
			beforeManagerCalled = true
			return nil
		},
		managerStart: func(context.Context) error {
			managerCalled = true
			return nil
		},
		uiStart: func(context.Context) error {
			return nil
		},
		log: logr.Discard(),
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, wantErr)
	assert.False(t, detachedUICalled)
	assert.False(t, beforeManagerCalled)
	assert.False(t, managerCalled)
}

func TestAdminDashboardOperatorModeRuntimeJoinsManagerAndUIOnUnexpectedAdminExit(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	listener := newFakeAdminDashboardListener()
	managerStarted := make(chan struct{})
	managerStopped := make(chan struct{})
	uiStarted := make(chan struct{})
	uiStopped := make(chan struct{})
	beforeManagerCalled := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runOperatorModeRuntime(t.Context(), &operatorModeRuntimeConfig{
			cfg:       enabledAdminTestConfig("operator"),
			assembly:  assembly,
			uiHandler: http.NotFoundHandler(),
			listenerFactory: func(
				context.Context,
				http.Handler,
			) (adminDashboardListener, error) {
				return listener, nil
			},
			startDetachedUI: func(context.Context) {
				t.Error("enabled operator started detached normal UI")
			},
			beforeManager: func() error {
				close(beforeManagerCalled)
				return nil
			},
			managerStart: func(ctx context.Context) error {
				close(managerStarted)
				defer close(managerStopped)
				<-ctx.Done()
				return nil
			},
			uiStart: func(ctx context.Context) error {
				close(uiStarted)
				defer close(uiStopped)
				<-ctx.Done()
				return nil
			},
			log: logr.Discard(),
		})
	}()

	awaitSignal(t, beforeManagerCalled, "operator pre-manager setup")
	awaitSignal(t, listener.started, "operator admin listener start")
	awaitSignal(t, managerStarted, "operator manager start")
	awaitSignal(t, uiStarted, "operator normal UI start")
	listener.exit <- nil
	err := awaitLifecycleResult(t, done)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "admin dashboard listener stopped unexpectedly")
	awaitSignal(t, managerStopped, "operator manager join")
	awaitSignal(t, uiStopped, "operator normal UI join")
}

func TestAdminDashboardOperatorModeRuntimeDisabledPreservesNormalPath(t *testing.T) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	wantErr := errors.New("normal manager result")
	factoryCalled := false
	detachedUICalled := false
	beforeManagerCalled := false
	managerCalled := false
	uiCalled := false
	err := runOperatorModeRuntime(t.Context(), &operatorModeRuntimeConfig{
		cfg:       &cliConfig{mode: "operator"},
		assembly:  assembly,
		uiHandler: http.NotFoundHandler(),
		listenerFactory: func(
			context.Context,
			http.Handler,
		) (adminDashboardListener, error) {
			factoryCalled = true
			return nil, errors.New("must not be called")
		},
		startDetachedUI: func(context.Context) {
			detachedUICalled = true
		},
		beforeManager: func() error {
			beforeManagerCalled = true
			return nil
		},
		managerStart: func(context.Context) error {
			managerCalled = true
			return wantErr
		},
		uiStart: func(context.Context) error {
			uiCalled = true
			return nil
		},
		log: logr.Discard(),
	})
	assert.ErrorIs(t, err, wantErr)
	assert.False(t, factoryCalled)
	assert.True(t, detachedUICalled)
	assert.True(t, beforeManagerCalled)
	assert.True(t, managerCalled)
	assert.False(t, uiCalled)
}

func TestAdminDashboardOperatorModeRuntimeClosesListenerOnceAndJoinsCloseErrorBeforeManager(
	t *testing.T,
) {
	t.Parallel()

	assembly := newRuntimeTestAssembly(t)
	listener := newFakeAdminDashboardListener()
	beforeManagerErr := errors.New("operator pre-manager setup failed")
	closeErr := errors.New("admin listener close failed")
	listener.closeErr = closeErr
	managerCalled := false
	err := runOperatorModeRuntime(t.Context(), &operatorModeRuntimeConfig{
		cfg:       enabledAdminTestConfig("operator"),
		assembly:  assembly,
		uiHandler: http.NotFoundHandler(),
		listenerFactory: func(
			context.Context,
			http.Handler,
		) (adminDashboardListener, error) {
			return listener, nil
		},
		startDetachedUI: func(context.Context) {
			t.Error("enabled operator started detached normal UI")
		},
		beforeManager: func() error {
			return beforeManagerErr
		},
		managerStart: func(context.Context) error {
			managerCalled = true
			return nil
		},
		uiStart: func(context.Context) error {
			return nil
		},
		log: logr.Discard(),
	})

	require.Error(t, err)
	assert.ErrorIs(t, err, beforeManagerErr)
	assert.ErrorIs(t, err, closeErr)
	assert.Equal(t, 1, listener.closeCount())
	assert.False(t, managerCalled)
}

func enabledAdminTestConfig(mode string) *cliConfig {
	return &cliConfig{
		mode:                  mode,
		adminDashboardEnabled: true,
		adminPodIdentity: admin.PodIdentity{
			Namespace:          "paprika-system",
			Name:               "paprika-api-abc",
			UID:                types.UID("53b1751e-a810-4a30-97ef-842ca5470db8"),
			ServiceAccount:     "paprika-api",
			ExpectedContainers: []string{"api-server"},
		},
	}
}

func newRuntimeTestAssembly(t *testing.T) *paprikaServerAssembly {
	t.Helper()
	scheme := newScheme()
	apiClient := crfake.NewClientBuilder().WithScheme(scheme).Build()
	k8sClient := fake.NewSimpleClientset()
	broker := events.NewBroker(logr.Discard())
	t.Cleanup(broker.Close)
	fleetIndex := fleet.NewIndex()
	require.NoError(t, fleetIndex.Install(fleet.NewSnapshot(1)))
	otelInterceptor, err := otelconnect.NewInterceptor()
	require.NoError(t, err)
	return &paprikaServerAssembly{
		apiClient:   apiClient,
		k8sClient:   k8sClient,
		broker:      broker,
		fleetReader: fleetIndex,
		baseOptions: []apiserver.ServerOption{
			apiserver.WithFleetIndex(fleetIndex),
			apiserver.WithK8sClient(k8sClient),
		},
		otelInterceptor: otelInterceptor,
	}
}
