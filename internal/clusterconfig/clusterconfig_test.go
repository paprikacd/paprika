package clusterconfig

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// A remote fleet cluster is reachable only through the credentials its Cluster
// object points at. These tests hold the two properties everything above this
// package depends on: a cluster key resolves to that cluster's own connection
// and never to a fallback, and nothing from inside a kubeconfig escapes into
// an error string.

// remoteKubeconfig is a minimal, syntactically valid kubeconfig naming a
// distinctive host and a token, so a test can prove both that the host is used
// and that the token never leaves this package.
const remoteKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: remote
  cluster:
    server: https://remote.example:6443
contexts:
- name: remote
  context:
    cluster: remote
    user: remote
current-context: remote
users:
- name: remote
  user:
    token: super-secret-token
`

func testReader(t *testing.T, objs ...client.Object) client.Reader {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))

	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

func directCluster(namespace, name string, spec clustersv1alpha1.ClusterSpec) *clustersv1alpha1.Cluster {
	spec.Mode = clustersv1alpha1.ClusterModeDirect

	return &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec:       spec,
	}
}

func TestConfigForReachesTheClusterTheKeyNames(t *testing.T) {
	t.Parallel()
	reader := testReader(t,
		directCluster("fleet", "prod", clustersv1alpha1.ClusterSpec{Server: "https://prod.example:6443"}),
		directCluster("fleet", "staging", clustersv1alpha1.ClusterSpec{Server: "https://staging.example:6443"}),
	)

	cfg, err := NewResolver(reader).ConfigFor(context.Background(), "fleet/prod")
	require.NoError(t, err)
	require.Equal(t, "https://prod.example:6443", cfg.Host,
		"per-cluster scoping is only real if each key resolves to its own cluster")
}

func TestConfigForReadsTheKubeconfigSecret(t *testing.T) {
	t.Parallel()
	reader := testReader(t,
		directCluster("fleet", "prod", clustersv1alpha1.ClusterSpec{
			KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "prod-kubeconfig"},
		}),
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: "fleet", Name: "prod-kubeconfig"},
			Data:       map[string][]byte{"kubeconfig": []byte(remoteKubeconfig)},
		},
	)

	cfg, err := NewResolver(reader).ConfigFor(context.Background(), "fleet/prod")
	require.NoError(t, err)
	require.Equal(t, "https://remote.example:6443", cfg.Host)
	require.Equal(t, "super-secret-token", cfg.BearerToken)
}

func TestConfigForUsesTheClustersOwnNamespaceWhenTheRefNamesNone(t *testing.T) {
	t.Parallel()
	// The Secret with the same name in another namespace must not be picked
	// up: an omitted namespace means "beside the Cluster", never "anywhere".
	reader := testReader(t,
		directCluster("fleet", "prod", clustersv1alpha1.ClusterSpec{
			KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "prod-kubeconfig"},
		}),
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: "other", Name: "prod-kubeconfig"},
			Data:       map[string][]byte{"kubeconfig": []byte(remoteKubeconfig)},
		},
	)

	_, err := NewResolver(reader).ConfigFor(context.Background(), "fleet/prod")
	require.Error(t, err)
}

func TestConfigForRefusesRatherThanFallingBackToTheLocalCluster(t *testing.T) {
	t.Parallel()
	tests := map[string]struct {
		key  string
		objs []client.Object
	}{
		"an unknown cluster":               {key: "fleet/missing"},
		"a key that is not namespace/name": {key: "prod"},
		"an agent cluster, which dials in rather than out": {
			key: "fleet/edge",
			objs: []client.Object{&clustersv1alpha1.Cluster{
				ObjectMeta: metav1.ObjectMeta{Namespace: "fleet", Name: "edge"},
				Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent},
			}},
		},
		"a disabled cluster": {
			key: "fleet/retired",
			objs: []client.Object{directCluster("fleet", "retired", clustersv1alpha1.ClusterSpec{
				Server: "https://retired.example:6443", Disabled: true,
			})},
		},
		"a direct cluster with no connection details": {
			key:  "fleet/blank",
			objs: []client.Object{directCluster("fleet", "blank", clustersv1alpha1.ClusterSpec{})},
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			// Refusing matters more than it looks: a resolver that quietly
			// answered with the control plane's own config would serve local
			// numbers under a remote cluster's name, and nothing above could
			// tell the difference.
			cfg, err := NewResolver(testReader(t, test.objs...)).ConfigFor(context.Background(), test.key)
			require.Error(t, err)
			require.Nil(t, cfg)
		})
	}
}

func TestConfigForErrorsNameTheClusterAndNothingElse(t *testing.T) {
	t.Parallel()
	reader := testReader(t,
		directCluster("fleet", "prod", clustersv1alpha1.ClusterSpec{
			KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "prod-kubeconfig", Key: "missing"},
		}),
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: "fleet", Name: "prod-kubeconfig"},
			Data:       map[string][]byte{"kubeconfig": []byte(remoteKubeconfig)},
		},
	)

	_, err := NewResolver(reader).ConfigFor(context.Background(), "fleet/prod")
	require.Error(t, err)
	require.ErrorContains(t, err, `"fleet/prod"`)
	require.NotContains(t, err.Error(), "super-secret-token",
		"these errors travel into responses and logs; a credential must never ride along")
	require.NotContains(t, err.Error(), "remote.example")
}

func TestConfigForTheEmptyKeyIsTheControlPlanesOwnCluster(t *testing.T) {
	// Not parallel: t.Setenv, which this needs to be sure no in-cluster
	// environment is picked up, is incompatible with a parallel test.
	// Outside a pod there is no in-cluster config to resolve, so the empty key
	// fails here — what it must never do is fall through to a Cluster lookup
	// and report some fleet member as the local cluster.
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")

	_, err := NewResolver(testReader(t)).ConfigFor(context.Background(), "")
	require.ErrorContains(t, err, "in-cluster config")
}

func TestForClusterReportsAgentModeAsNoOutboundConfig(t *testing.T) {
	t.Parallel()
	// The cluster controller depends on this exact shape: agent-mode clusters
	// are pending an inbound connection, not misconfigured.
	cfg, err := ForCluster(context.Background(), testReader(t), &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "fleet", Name: "edge"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent},
	})
	require.NoError(t, err)
	require.Nil(t, cfg)
}

func TestForClusterRejectsAnUnsetMode(t *testing.T) {
	t.Parallel()
	_, err := ForCluster(context.Background(), testReader(t), &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "fleet", Name: "mystery"},
	})
	require.ErrorContains(t, err, "unsupported cluster mode")
}
