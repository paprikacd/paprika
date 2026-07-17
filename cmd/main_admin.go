package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"golang.org/x/sync/errgroup"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/admin"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/fleet"
)

const (
	adminPodNamespaceEnv      = "POD_NAMESPACE"
	adminPodNameEnv           = "POD_NAME"
	adminPodUIDEnv            = "POD_UID"
	adminPodServiceAccountEnv = "POD_SERVICE_ACCOUNT"
	adminExpectedContainerEnv = "PAPRIKA_ADMIN_EXPECTED_CONTAINER"
)

var errAdminDashboardMode = errors.New("admin dashboard is unavailable in this mode")

type paprikaServerAssembly struct {
	apiClient        client.Client
	k8sClient        kubernetes.Interface
	broker           *events.Broker
	fleetReader      fleet.Reader
	baseOptions      []apiserver.ServerOption
	normalAuthorizer auth.Authorizer
	otelInterceptor  connect.Interceptor
}

func (assembly *paprikaServerAssembly) newNormalServer() *apiserver.PaprikaServer {
	options := append([]apiserver.ServerOption(nil), assembly.baseOptions...)
	if assembly.normalAuthorizer != nil {
		options = append(options, apiserver.WithAuthorizer(assembly.normalAuthorizer))
	}
	return apiserver.NewPaprikaServer(assembly.apiClient, assembly.broker, options...)
}

func (assembly *paprikaServerAssembly) newAdminServer() *apiserver.PaprikaServer {
	options := append([]apiserver.ServerOption(nil), assembly.baseOptions...)
	options = append(
		options,
		apiserver.WithAuthorizer(admin.NewAdminAwareAuthorizer(assembly.normalAuthorizer)),
	)
	return apiserver.NewPaprikaServer(assembly.apiClient, assembly.broker, options...)
}

func buildAdminDashboardHandler(
	assembly *paprikaServerAssembly,
	identity *admin.PodIdentity,
	uiHandler http.Handler,
	log logr.Logger,
) (*apiserver.PaprikaServer, http.Handler, error) {
	if assembly == nil || assembly.apiClient == nil || assembly.k8sClient == nil ||
		assembly.broker == nil || identity == nil || uiHandler == nil {
		return nil, nil, errors.New("invalid admin dashboard dependencies")
	}
	if err := identity.Validate(); err != nil {
		return nil, nil, fmt.Errorf("validate admin pod identity: %w", err)
	}

	adminServer := assembly.newAdminServer()
	if assembly.otelInterceptor == nil {
		return nil, nil, errors.New("admin OTel Connect interceptor is not configured")
	}

	const maxMsgBytes = 10 * 1024 * 1024
	_, connectHandler := v1connect.NewPaprikaServiceHandler(
		adminServer,
		connect.WithInterceptors(assembly.otelInterceptor, adminServer.AuditInterceptor()),
		connect.WithReadMaxBytes(maxMsgBytes),
	)
	ready := fleetReadyChecker(assembly.fleetReader)
	review := &admin.KubernetesReview{
		Identity:             *identity,
		Pods:                 kubernetesPodGetter{client: assembly.k8sClient},
		TokenReviews:         assembly.k8sClient.AuthenticationV1().TokenReviews(),
		SubjectAccessReviews: assembly.k8sClient.AuthorizationV1().SubjectAccessReviews(),
	}
	handler, err := admin.NewHTTPHandler(&admin.HTTPConfig{
		Store:          admin.NewDefaultStore(),
		Review:         review,
		PodUID:         identity.UID,
		HealthHandler:  healthzHandler(log),
		ReadyHandler:   readinessHandler(log, ready),
		ConnectHandler: connectHandler,
		UIHandler:      uiHandler,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("build admin HTTP surface: %w", err)
	}
	return adminServer, otelhttp.NewHandler(
		apiserver.MetricsMiddleware(handler),
		"paprika-admin-http",
	), nil
}

type kubernetesPodGetter struct {
	client kubernetes.Interface
}

func (getter kubernetesPodGetter) Get(
	ctx context.Context,
	namespace string,
	name string,
	options metav1.GetOptions,
) (*corev1.Pod, error) {
	pod, err := getter.client.CoreV1().Pods(namespace).Get(ctx, name, options)
	if err != nil {
		return nil, fmt.Errorf("get pod %s/%s: %w", namespace, name, err)
	}
	return pod, nil
}

func validateAdminDashboardMode(cfg *cliConfig) error {
	if cfg == nil || !cfg.adminDashboardEnabled {
		return nil
	}
	switch cfg.mode {
	case "api", "operator":
		return nil
	default:
		return fmt.Errorf(
			"%w: --admin-dashboard-enabled cannot be used with --mode=%s; use api or operator mode",
			errAdminDashboardMode,
			cfg.mode,
		)
	}
}

func configureAdminDashboard(cfg *cliConfig, getenv func(string) string) error {
	if err := validateAdminDashboardMode(cfg); err != nil {
		return err
	}
	if !cfg.adminDashboardEnabled {
		return nil
	}
	identity, err := loadAdminPodIdentity(getenv)
	if err != nil {
		return fmt.Errorf("load admin dashboard pod identity: %w", err)
	}
	cfg.adminPodIdentity = identity
	return nil
}

func finishFlagRegistration(
	fs *flag.FlagSet,
	cfg *cliConfig,
	args []string,
	getenv func(string) string,
) (*cliConfig, error) {
	if err := fs.Parse(args); err != nil {
		return nil, fmt.Errorf("parse flags: %w", err)
	}
	if err := configureAdminDashboard(cfg, getenv); err != nil {
		return nil, err
	}
	return cfg, nil
}

func loadAdminPodIdentity(getenv func(string) string) (admin.PodIdentity, error) {
	namespace, err := validatedAdminEnvironment(
		getenv,
		adminPodNamespaceEnv,
		validation.IsDNS1123Label,
	)
	if err != nil {
		return admin.PodIdentity{}, err
	}
	name, err := validatedAdminEnvironment(
		getenv,
		adminPodNameEnv,
		validation.IsDNS1123Subdomain,
	)
	if err != nil {
		return admin.PodIdentity{}, err
	}
	uid, err := requiredAdminEnvironment(getenv, adminPodUIDEnv)
	if err != nil {
		return admin.PodIdentity{}, err
	}
	serviceAccount, err := validatedAdminEnvironment(
		getenv,
		adminPodServiceAccountEnv,
		validation.IsDNS1123Subdomain,
	)
	if err != nil {
		return admin.PodIdentity{}, err
	}
	container, err := validatedAdminEnvironment(
		getenv,
		adminExpectedContainerEnv,
		validation.IsDNS1123Label,
	)
	if err != nil {
		return admin.PodIdentity{}, err
	}

	identity := admin.PodIdentity{
		Namespace:          namespace,
		Name:               name,
		UID:                types.UID(uid),
		ServiceAccount:     serviceAccount,
		ExpectedContainers: []string{container},
	}
	if err := identity.Validate(); err != nil {
		return admin.PodIdentity{}, fmt.Errorf("validate admin pod identity: %w", err)
	}
	return identity, nil
}

func validatedAdminEnvironment(
	getenv func(string) string,
	name string,
	validate func(string) []string,
) (string, error) {
	value, err := requiredAdminEnvironment(getenv, name)
	if err != nil {
		return "", err
	}
	if problems := validate(value); len(problems) != 0 {
		return "", invalidAdminEnvironment(name, problems)
	}
	return value, nil
}

func requiredAdminEnvironment(getenv func(string) string, name string) (string, error) {
	if getenv == nil {
		return "", fmt.Errorf("%s is required when --admin-dashboard-enabled is set", name)
	}
	value := getenv(name)
	if value == "" || strings.TrimSpace(value) != value {
		return "", fmt.Errorf(
			"%s must be a non-empty value without surrounding whitespace when --admin-dashboard-enabled is set",
			name,
		)
	}
	return value, nil
}

func invalidAdminEnvironment(name string, problems []string) error {
	return fmt.Errorf("%s is invalid: %s", name, strings.Join(problems, "; "))
}

type adminDashboardListener interface {
	Serve() error
	Close() error
}

type adminDashboardListenerFactory func(
	context.Context,
	http.Handler,
) (adminDashboardListener, error)

func prepareAdminDashboard(
	ctx context.Context,
	cfg *cliConfig,
	assembly *paprikaServerAssembly,
	uiHandler http.Handler,
	log logr.Logger,
	factory adminDashboardListenerFactory,
) (adminDashboardListener, error) {
	if !cfg.adminDashboardEnabled {
		return nil, nil
	}
	_, handler, err := buildAdminDashboardHandler(
		assembly,
		&cfg.adminPodIdentity,
		uiHandler,
		log,
	)
	if err != nil {
		return nil, err
	}
	return bindAdminDashboardListener(ctx, handler, factory)
}

func closeAdminDashboard(listener adminDashboardListener, log logr.Logger) error {
	if listener == nil {
		return nil
	}
	if err := listener.Close(); err != nil {
		log.Error(err, "Failed to close admin dashboard listener")
		return fmt.Errorf("close admin dashboard listener: %w", err)
	}
	return nil
}

func bindAdminDashboardListener(
	ctx context.Context,
	handler http.Handler,
	factory adminDashboardListenerFactory,
) (adminDashboardListener, error) {
	if ctx == nil || handler == nil || factory == nil {
		return nil, errors.New("invalid admin dashboard listener setup")
	}
	listener, err := factory(ctx, handler)
	if err != nil {
		return nil, fmt.Errorf("bind admin dashboard listener: %w", err)
	}
	return listener, nil
}

type apiModeRuntimeConfig struct {
	cfg             *cliConfig
	assembly        *paprikaServerAssembly
	uiHandler       http.Handler
	listenerFactory adminDashboardListenerFactory
	normalStart     func(context.Context) error
	log             logr.Logger
}

func runAPIModeRuntime(ctx context.Context, runtime apiModeRuntimeConfig) error {
	if ctx == nil || runtime.cfg == nil || runtime.normalStart == nil {
		return errors.New("invalid API mode runtime")
	}
	listener, err := prepareAdminDashboard(
		ctx,
		runtime.cfg,
		runtime.assembly,
		runtime.uiHandler,
		runtime.log,
		runtime.listenerFactory,
	)
	if err != nil {
		return err
	}
	if listener == nil {
		return runtime.normalStart(ctx)
	}
	return runAdminDashboardLifecycle(
		ctx,
		listener,
		adminLifecycleComponent{
			name:  "API mode",
			start: runtime.normalStart,
		},
	)
}

type operatorModeRuntimeConfig struct {
	cfg             *cliConfig
	assembly        *paprikaServerAssembly
	uiHandler       http.Handler
	listenerFactory adminDashboardListenerFactory
	startDetachedUI func(context.Context)
	beforeManager   func() error
	managerStart    func(context.Context) error
	uiStart         func(context.Context) error
	log             logr.Logger
}

func runOperatorModeRuntime(
	ctx context.Context,
	runtime *operatorModeRuntimeConfig,
) error {
	if err := validateOperatorModeRuntime(ctx, runtime); err != nil {
		return err
	}
	listener, err := prepareAdminDashboard(
		ctx,
		runtime.cfg,
		runtime.assembly,
		runtime.uiHandler,
		runtime.log,
		runtime.listenerFactory,
	)
	if err != nil {
		return err
	}
	if listener == nil {
		runtime.startDetachedUI(ctx)
	}
	if err := runtime.beforeManager(); err != nil {
		return errors.Join(err, closeAdminDashboard(listener, runtime.log))
	}
	if listener == nil {
		if err := runtime.managerStart(ctx); err != nil {
			return fmt.Errorf("failed to run manager: %w", err)
		}
		return nil
	}
	return runAdminDashboardLifecycle(
		ctx,
		listener,
		adminLifecycleComponent{name: "operator manager", start: runtime.managerStart},
		adminLifecycleComponent{name: "UI server", start: runtime.uiStart},
	)
}

func validateOperatorModeRuntime(
	ctx context.Context,
	runtime *operatorModeRuntimeConfig,
) error {
	if ctx == nil || runtime == nil || runtime.cfg == nil ||
		runtime.startDetachedUI == nil || runtime.beforeManager == nil ||
		runtime.managerStart == nil || runtime.uiStart == nil {
		return errors.New("invalid operator mode runtime")
	}
	return nil
}

type adminLifecycleComponent struct {
	name  string
	start func(context.Context) error
}

func runAdminDashboardLifecycle(
	ctx context.Context,
	listener adminDashboardListener,
	components ...adminLifecycleComponent,
) error {
	if ctx == nil || listener == nil || len(components) == 0 {
		return errors.New("invalid admin dashboard lifecycle")
	}
	lifecycleCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	group, groupCtx := errgroup.WithContext(lifecycleCtx)
	ownedListener := &onceClosingAdminListener{adminDashboardListener: listener}

	for index := range components {
		if components[index].name == "" || components[index].start == nil {
			return errors.New("invalid admin dashboard lifecycle component")
		}
	}
	for index := range components {
		component := components[index]
		group.Go(func() error {
			return runLifecycleComponent(groupCtx, component.name, component.start)
		})
	}
	group.Go(func() error {
		return runAdminListenerLifecycle(groupCtx, ownedListener)
	})

	groupErr := group.Wait()
	closeErr := ownedListener.Close()
	if groupErr != nil || closeErr != nil {
		return fmt.Errorf("run admin dashboard lifecycle: %w", errors.Join(groupErr, closeErr))
	}
	return nil
}

type onceClosingAdminListener struct {
	adminDashboardListener
	once sync.Once
	err  error
}

func (listener *onceClosingAdminListener) Close() error {
	listener.once.Do(func() {
		listener.err = listener.adminDashboardListener.Close()
	})
	return listener.err
}

func runAdminListenerLifecycle(
	ctx context.Context,
	listener adminDashboardListener,
) error {
	result := make(chan error, 1)
	go func() {
		result <- listener.Serve()
	}()

	select {
	case err := <-result:
		if err != nil {
			return fmt.Errorf("admin dashboard listener: %w", err)
		}
		if ctx.Err() == nil {
			return errors.New("admin dashboard listener stopped unexpectedly")
		}
		return nil
	case <-ctx.Done():
		if err := listener.Close(); err != nil {
			serveErr := <-result
			return errors.Join(fmt.Errorf("close admin dashboard listener: %w", err), serveErr)
		}
		if err := <-result; err != nil {
			return fmt.Errorf("admin dashboard listener shutdown: %w", err)
		}
		return nil
	}
}
