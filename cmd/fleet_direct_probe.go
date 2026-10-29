package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/controller/pipelines"
)

type fleetProbeOptions struct {
	clusterNamespace, clusterName, targetNamespace         string
	expectedServer, expectedCASHA256, expectedNamespaceUID string
	systemCA                                               bool
}

type fleetProbeEvidence struct {
	ClusterNamespace      string    `json:"clusterNamespace"`
	ClusterName           string    `json:"clusterName"`
	ClusterUID            string    `json:"clusterUid"`
	ClusterGeneration     int64     `json:"clusterGeneration"`
	SecretNamespace       string    `json:"secretNamespace"`
	SecretName            string    `json:"secretName"`
	SecretUID             string    `json:"secretUid"`
	SecretResourceVersion string    `json:"secretResourceVersion"`
	TargetNamespace       string    `json:"targetNamespace"`
	TargetNamespaceUID    string    `json:"targetNamespaceUid"`
	Server                string    `json:"server"`
	ObservedAt            time.Time `json:"observedAt"`
	ManagerPod            string    `json:"managerPod"`
}

func runFleetDirectProbe(ctx context.Context, args []string, out io.Writer) error {
	opts, err := parseFleetProbeOptions(args)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return errors.New("fleet probe: management cluster identity unavailable")
	}
	scheme := runtime.NewScheme()
	if corev1.AddToScheme(scheme) != nil || clustersv1alpha1.AddToScheme(scheme) != nil {
		return errors.New("fleet probe: schema unavailable")
	}
	reader, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		return errors.New("fleet probe: management client unavailable")
	}
	evidence, err := probeFleetDirect(ctx, reader, cfg, &opts)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(out).Encode(evidence); err != nil {
		return fmt.Errorf("fleet probe: write evidence: %w", err)
	}
	return nil
}

//nolint:gocyclo,cyclop // Each independently validated argument fails closed.
func parseFleetProbeOptions(args []string) (fleetProbeOptions, error) {
	var o fleetProbeOptions
	flags := flag.NewFlagSet("fleet-direct-probe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&o.clusterNamespace, "cluster-namespace", "", "")
	flags.StringVar(&o.clusterName, "cluster-name", "", "")
	flags.StringVar(&o.targetNamespace, "target-namespace", "", "")
	flags.StringVar(&o.expectedServer, "expected-server", "", "")
	flags.StringVar(&o.expectedCASHA256, "expected-ca-sha256", "", "")
	flags.StringVar(&o.expectedNamespaceUID, "expected-namespace-uid", "", "")
	flags.BoolVar(&o.systemCA, "system-ca", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return o, errors.New("fleet probe: invalid arguments")
	}
	if o.clusterNamespace == "" || o.clusterName == "" || o.targetNamespace == "" || o.expectedNamespaceUID == "" || o.expectedServer == "" {
		return o, errors.New("fleet probe: required target identity is missing")
	}
	u, err := url.Parse(o.expectedServer)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return o, errors.New("fleet probe: invalid expected server")
	}
	if o.systemCA {
		if o.expectedCASHA256 != "" || u.Port() != "" || !strings.HasSuffix(u.Hostname(), ".gke.goog") {
			return o, errors.New("fleet probe: invalid system CA target")
		}
	} else if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(o.expectedCASHA256) {
		return o, errors.New("fleet probe: expected CA digest required")
	}
	return o, nil
}

func probeFleetDirect(ctx context.Context, reader client.Client, management *rest.Config, o *fleetProbeOptions) (*fleetProbeEvidence, error) {
	return probeFleetDirectWith(ctx, reader, management, o, readFleetProbeNamespace)
}

//nolint:gocyclo,cyclop // Each registration and credential invariant is independently required.
func probeFleetDirectWith(ctx context.Context, reader client.Client, management *rest.Config, o *fleetProbeOptions, readNamespace func(context.Context, *rest.Config, string) (string, error)) (*fleetProbeEvidence, error) {
	var cluster clustersv1alpha1.Cluster
	if err := reader.Get(ctx, client.ObjectKey{Namespace: o.clusterNamespace, Name: o.clusterName}, &cluster); err != nil {
		return nil, errors.New("fleet probe: registration unavailable")
	}
	if cluster.UID == "" || cluster.Generation < 1 {
		return nil, errors.New("fleet probe: registration identity unavailable")
	}
	ref := cluster.Spec.KubeconfigSecretRef
	if cluster.Spec.Disabled || cluster.Spec.Mode != clustersv1alpha1.ClusterModeDirect || ref == nil || ref.Name == "" || (ref.Key != "" && ref.Key != "kubeconfig") {
		return nil, errors.New("fleet probe: registration is not a direct deployment target")
	}
	secretNamespace := ref.Namespace
	if secretNamespace == "" {
		secretNamespace = cluster.Namespace
	}
	var secret corev1.Secret
	if err := reader.Get(ctx, client.ObjectKey{Namespace: secretNamespace, Name: ref.Name}, &secret); err != nil {
		return nil, errors.New("fleet probe: credential reference unavailable")
	}
	if secret.UID == "" || secret.ResourceVersion == "" {
		return nil, errors.New("fleet probe: credential identity unavailable")
	}
	cfg, err := pipelines.NewClusterClientManager(reader, management).GetRestConfig(ctx, ref.Name, secretNamespace)
	if err != nil || !fleetProbeConfigMatches(cfg, o) {
		return nil, errors.New("fleet probe: credential configuration does not match expected target")
	}
	uid, err := readNamespace(ctx, cfg, o.targetNamespace)
	if err != nil || uid != o.expectedNamespaceUID {
		return nil, errors.New("fleet probe: direct namespace read failed or target identity differs")
	}
	var currentCluster clustersv1alpha1.Cluster
	var currentSecret corev1.Secret
	if reader.Get(ctx, client.ObjectKeyFromObject(&cluster), &currentCluster) != nil || reader.Get(ctx, client.ObjectKeyFromObject(&secret), &currentSecret) != nil || cluster.UID != currentCluster.UID || cluster.Generation != currentCluster.Generation || !reflect.DeepEqual(cluster.Spec, currentCluster.Spec) || secret.UID != currentSecret.UID || secret.ResourceVersion != currentSecret.ResourceVersion {
		return nil, errors.New("fleet probe: registration or credential changed during probe")
	}
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return nil, errors.New("fleet probe: manager identity unavailable")
	}
	return &fleetProbeEvidence{ClusterNamespace: cluster.Namespace, ClusterName: cluster.Name, ClusterUID: string(cluster.UID), ClusterGeneration: cluster.Generation, SecretNamespace: secret.Namespace, SecretName: secret.Name, SecretUID: string(secret.UID), SecretResourceVersion: secret.ResourceVersion, TargetNamespace: o.targetNamespace, TargetNamespaceUID: uid, Server: o.expectedServer, ObservedAt: time.Now().UTC(), ManagerPod: hostname}, nil
}

func readFleetProbeNamespace(ctx context.Context, cfg *rest.Config, namespace string) (string, error) {
	remote, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return "", fmt.Errorf("create remote client: %w", err)
	}
	ns, err := remote.Resource(schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}).Get(ctx, namespace, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("read target namespace: %w", err)
	}
	return string(ns.GetUID()), nil
}

//nolint:gocyclo,cyclop // Reject each unsafe credential or TLS override explicitly.
func fleetProbeConfigMatches(cfg *rest.Config, o *fleetProbeOptions) bool {
	if cfg == nil || strings.TrimSuffix(cfg.Host, "/") != strings.TrimSuffix(o.expectedServer, "/") || cfg.Insecure || cfg.ServerName != "" || cfg.CAFile != "" || cfg.CertFile != "" || len(cfg.CertData) != 0 || cfg.KeyFile != "" || len(cfg.KeyData) != 0 || cfg.BearerToken != "" || cfg.BearerTokenFile != "" || cfg.Username != "" || cfg.Password != "" || cfg.Proxy != nil || cfg.AuthProvider != nil {
		return false
	}
	if o.systemCA {
		if len(cfg.CAData) != 0 {
			return false
		}
	} else {
		sum := sha256.Sum256(cfg.CAData)
		if len(cfg.CAData) == 0 || hex.EncodeToString(sum[:]) != o.expectedCASHA256 {
			return false
		}
	}
	exec := cfg.ExecProvider
	return exec != nil && exec.Command == "/manager" && len(exec.Args) == 1 && exec.Args[0] == "gke-exec-credential" && len(exec.Env) == 0 && (exec.APIVersion == "client.authentication.k8s.io/v1" || exec.APIVersion == "client.authentication.k8s.io/v1beta1") && fmt.Sprint(exec.InteractiveMode) == "Never"
}
