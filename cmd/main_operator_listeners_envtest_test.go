package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-logr/logr/funcr"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

// These tests run runOperatorMode against envtest and check which optional
// listeners start. The predicates are covered in main_operator_listeners_test.go;
// these cover the wiring in runOperatorMode and the logs it writes.

const (
	logManagerStarted     = "Starting manager"
	logConsoleDisabled    = "Operator console disabled"
	logWebhookDisabled    = "Inline webhook receiver disabled"
	logStartUI            = "Starting UI server"
	logStartInlineWebhook = "Starting inline webhook receiver"
	logAuthDisabledFlag   = "authentication disabled and listens beyond loopback"
	envtestOperatorNS     = "paprika-system"
	envtestListenerSettle = time.Second
)

type operatorLogBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (b *operatorLogBuffer) add(prefix, args string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lines = append(b.lines, prefix+" "+args)
}

func (b *operatorLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Join(b.lines, "\n")
}

// probeReady reports whether the health probe answers /readyz with 200.
func probeReady(addr string) bool {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+addr+"/readyz", http.NoBody)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// freeLoopbackAddr returns a 127.0.0.1 address that nothing is listening on.
func freeLoopbackAddr(t *testing.T) string {
	t.Helper()
	var lc net.ListenConfig
	l, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())
	return addr
}

// runOperatorForListeners starts runOperatorMode with the given listener flags,
// waits until the health probe is ready, and returns the captured log output.
// It fails the test if the manager does not start or stop.
func runOperatorForListeners(t *testing.T, listenerArgs ...string) string {
	t.Helper()
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("requires the envtest binaries supplied by make test/test-race")
	}
	env := &envtest.Environment{CRDDirectoryPaths: []string{"../config/crd/bases"}, ErrorIfCRDPathMissing: true}
	restCfg, err := env.Start()
	require.NoError(t, err)
	t.Cleanup(func() { _ = env.Stop() })

	admin, err := client.New(restCfg, client.Options{Scheme: newScheme()})
	require.NoError(t, err)
	require.NoError(t, admin.Create(t.Context(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: envtestOperatorNS}}))

	kubeconfig := filepath.Join(t.TempDir(), "kubeconfig")
	require.NoError(t, os.WriteFile(kubeconfig, env.KubeConfig, 0o600))
	t.Setenv("KUBECONFIG", kubeconfig)
	t.Setenv("ENABLE_WEBHOOKS", "false")

	probeAddr := freeLoopbackAddr(t)
	args := append([]string{
		"--mode=operator",
		"--metrics-bind-address=0",
		"--health-probe-bind-address=" + probeAddr,
		"--operator-namespace=" + envtestOperatorNS,
	}, listenerArgs...)
	cfg, err := parseManagerConfig(args, os.Stderr)
	require.NoError(t, err)

	logs := &operatorLogBuffer{}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- runOperatorMode(ctx, cfg, newScheme(), funcr.New(logs.add, funcr.Options{})) }()

	deadline := time.Now().Add(60 * time.Second)
	for !probeReady(probeAddr) {
		select {
		case runErr := <-done:
			t.Fatalf("runOperatorMode exited before ready: %v\nlogs:\n%s", runErr, logs)
		case <-time.After(250 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatalf("manager never became ready\nlogs:\n%s", logs)
		}
	}
	// Listener goroutines log as they start; give them a moment.
	time.Sleep(envtestListenerSettle)
	out := logs.String()

	cancel()
	select {
	case runErr := <-done:
		require.NoError(t, runErr)
	case <-time.After(30 * time.Second):
		t.Fatalf("runOperatorMode did not stop after cancel\nlogs:\n%s", out)
	}
	return out
}

// runOperatorMode can run once per process: controller-runtime rejects a second
// registration of the same controller name. Each case therefore runs in a child
// process that re-runs this test binary with TestOperatorModeListenerChild.
const (
	operatorListenerChildArgsEnv = "PAPRIKA_OPERATOR_LISTENER_ARGS"
	operatorListenerChildLogEnv  = "PAPRIKA_OPERATOR_LISTENER_LOG"
)

func TestOperatorModeListeners(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("requires the envtest binaries supplied by make test/test-race")
	}
	// Port 0 lets the kernel pick each port when the listener binds. Reserving a
	// port here and releasing it would race with envtest's own port allocation.
	uiAddr := "127.0.0.1:0"
	webhookAddr := "127.0.0.1:0"
	wildcardAddr := ":0"

	cases := []struct {
		name  string
		args  []string
		check func(t *testing.T, out string)
	}{
		{
			name: "split listeners are off",
			args: []string{"--ui-bind-address=", "--inline-webhook-bind-address="},
			check: func(t *testing.T, out string) {
				require.Contains(t, out, logManagerStarted)
				require.Contains(t, out, logConsoleDisabled)
				require.Contains(t, out, logWebhookDisabled)
				require.NotContains(t, out, logStartUI)
				require.NotContains(t, out, logStartInlineWebhook)
				require.NotContains(t, out, logAuthDisabledFlag, "no console runs, so the fail-safe must stay silent")
			},
		},
		{
			name: "loopback listeners start without the fail-safe",
			args: []string{"--ui-bind-address=" + uiAddr, "--inline-webhook-bind-address=" + webhookAddr},
			check: func(t *testing.T, out string) {
				require.Contains(t, out, logStartUI)
				require.Contains(t, out, logStartInlineWebhook)
				require.NotContains(t, out, logConsoleDisabled)
				require.NotContains(t, out, logWebhookDisabled)
				require.NotContains(t, out, logAuthDisabledFlag, "a loopback console with auth disabled is not flagged")
			},
		},
		{
			// The fail-safe logs an error and the console still starts. Refusing
			// would break the chart's monolith default and the kind e2e suite,
			// which run with auth off.
			name: "wildcard console without auth logs the fail-safe and still starts",
			args: []string{"--ui-bind-address=" + wildcardAddr, "--inline-webhook-bind-address="},
			check: func(t *testing.T, out string) {
				require.Contains(t, out, logAuthDisabledFlag, "the fail-safe must name the console with auth disabled")
				require.Contains(t, out, "--auth-enabled=true", "the fail-safe must say how to enable auth")
				require.Contains(t, out, "127.0.0.1", "the fail-safe must say how to bind to loopback")
				require.Contains(t, out, logStartUI, "the console still starts with auth disabled")
				require.NotContains(t, out, logConsoleDisabled)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logFile := filepath.Join(t.TempDir(), "operator.log")
			child := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestOperatorModeListenerChild$", "-test.count=1") // #nosec G204 G702 -- re-runs this test binary with fixed arguments.
			child.Env = append(os.Environ(),
				operatorListenerChildArgsEnv+"="+strings.Join(tc.args, "\n"),
				operatorListenerChildLogEnv+"="+logFile)
			combined, err := child.CombinedOutput()
			require.NoError(t, err, "child run failed:\n%s", combined)
			logs, err := os.ReadFile(logFile) // #nosec G304 -- a file this test created under t.TempDir.
			require.NoError(t, err)
			tc.check(t, string(logs))
		})
	}
}

// TestOperatorModeListenerChild runs one runOperatorMode case for
// TestOperatorModeListeners and writes its logs to the file that parent names.
func TestOperatorModeListenerChild(t *testing.T) {
	raw := os.Getenv(operatorListenerChildArgsEnv)
	if raw == "" {
		t.Skip("helper for TestOperatorModeListeners")
	}
	out := runOperatorForListeners(t, strings.Split(raw, "\n")...)
	require.NoError(t, os.WriteFile(os.Getenv(operatorListenerChildLogEnv), []byte(out), 0o600)) // #nosec G703 -- the path comes from the parent test's t.TempDir.
}
