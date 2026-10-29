package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/rest"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

const probeKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: target
  cluster:
    server: https://example.gke.goog
contexts:
- name: remote
  context:
    cluster: target
    user: manager
current-context: remote
users:
- name: manager
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: /manager
      args: [gke-exec-credential]
      interactiveMode: Never
`

func probeFixture(t *testing.T) (client.Client, fleetProbeOptions) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Name: "vocus", Namespace: "paprika-system", UID: types.UID("cluster-uid"), Generation: 3}, Spec: clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeDirect, KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "vocus-kubeconfig"}}}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "vocus-kubeconfig", Namespace: "paprika-system", UID: types.UID("secret-uid"), ResourceVersion: "7"}, Data: map[string][]byte{"kubeconfig": []byte(probeKubeconfig)}}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(cluster, secret).Build(), fleetProbeOptions{clusterNamespace: "paprika-system", clusterName: "vocus", targetNamespace: "sfh-vocus-prod", expectedServer: "https://example.gke.goog", expectedNamespaceUID: "ns-uid", systemCA: true}
}

func TestFleetDirectProbeProvesRegisteredTransport(t *testing.T) {
	reader, opts := probeFixture(t)
	called := false
	evidence, err := probeFleetDirectWith(context.Background(), reader, &rest.Config{}, &opts, func(_ context.Context, cfg *rest.Config, ns string) (string, error) {
		called = true
		if ns != "sfh-vocus-prod" || cfg.Host != opts.expectedServer || cfg.ExecProvider == nil || cfg.ExecProvider.Command != "/manager" {
			t.Fatal("wrong target or credentials")
		}
		return "ns-uid", nil
	})
	if err != nil || !called || evidence.ClusterUID != "cluster-uid" || evidence.SecretUID != "secret-uid" || evidence.TargetNamespaceUID != "ns-uid" {
		t.Fatalf("unexpected evidence: %+v %v", evidence, err)
	}
}

func TestFleetDirectProbeFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alter func(client.Client, *fleetProbeOptions)
		get   func(context.Context, *rest.Config, string) (string, error)
	}{
		{name: "agent mode", alter: func(c client.Client, _ *fleetProbeOptions) {
			var cluster clustersv1alpha1.Cluster
			_ = c.Get(context.Background(), client.ObjectKey{Namespace: "paprika-system", Name: "vocus"}, &cluster)
			cluster.Spec.Mode = clustersv1alpha1.ClusterModeAgent
			_ = c.Update(context.Background(), &cluster)
		}},
		{name: "wrong endpoint", alter: func(_ client.Client, o *fleetProbeOptions) { o.expectedServer = "https://other.gke.goog" }},
		{name: "wrong namespace", get: func(context.Context, *rest.Config, string) (string, error) { return "another-uid", nil }},
		{name: "unreachable direct connection", get: func(context.Context, *rest.Config, string) (string, error) {
			return "", errors.New("secret endpoint detail")
		}},
		{name: "changed secret during probe", get: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader, opts := probeFixture(t)
			if tc.alter != nil {
				tc.alter(reader, &opts)
			}
			read := tc.get
			if tc.name == "changed secret during probe" {
				read = func(ctx context.Context, _ *rest.Config, _ string) (string, error) {
					var s corev1.Secret
					_ = reader.Get(ctx, client.ObjectKey{Namespace: "paprika-system", Name: "vocus-kubeconfig"}, &s)
					s.Data["other"] = []byte("changed")
					_ = reader.Update(ctx, &s)
					return "ns-uid", nil
				}
			}
			if read == nil {
				read = func(context.Context, *rest.Config, string) (string, error) { return "ns-uid", nil }
			}
			evidence, err := probeFleetDirectWith(context.Background(), reader, &rest.Config{}, &opts, read)
			if err == nil || evidence != nil || strings.Contains(err.Error(), "secret endpoint detail") {
				t.Fatalf("must fail safely: %+v %v", evidence, err)
			}
		})
	}
}

func TestFleetProbeRejectsUnsafeKubeconfig(t *testing.T) {
	_, o := probeFixture(t)
	base := &rest.Config{Host: o.expectedServer, ExecProvider: &clientcmdExecForTest}
	if !fleetProbeConfigMatches(base, &o) {
		t.Fatal("expected trusted config")
	}
	for _, tc := range []struct {
		name   string
		mutate func(*rest.Config)
	}{
		{"insecure TLS", func(c *rest.Config) { c.Insecure = true }},
		{"custom CA", func(c *rest.Config) { c.CAData = []byte("untrusted") }},
		{"custom token", func(c *rest.Config) { c.BearerToken = "token" }},
		{"server override", func(c *rest.Config) { c.ServerName = "other" }},
		{"arbitrary exec", func(c *rest.Config) { c.ExecProvider.Command = "other" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := rest.CopyConfig(base)
			exec := *base.ExecProvider
			c.ExecProvider = &exec
			tc.mutate(c)
			if fleetProbeConfigMatches(c, &o) {
				t.Fatal("accepted unsafe config")
			}
		})
	}
}

var clientcmdExecForTest = clientcmdapi.ExecConfig{Command: "/manager", Args: []string{"gke-exec-credential"}, APIVersion: "client.authentication.k8s.io/v1", InteractiveMode: clientcmdapi.NeverExecInteractiveMode}
