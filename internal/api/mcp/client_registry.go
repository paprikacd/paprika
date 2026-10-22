package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// DynamicClientRegistry retains public OAuth client metadata, not credentials
// or grants. A registered client still needs console authentication, consent,
// the exact redirect URI and PKCE before receiving an access token.
type DynamicClientRegistry interface {
	Register(context.Context, string, []string) error
	RedirectURIs(context.Context, string) ([]string, error)
}

var errClientRegistryFull = errors.New("dynamic client registration capacity unavailable")

const (
	clientRegistryResourceKey = "resource"
	clientRegistryKeyPrefix   = "client."
	// Leave ample room below Kubernetes' 1 MiB ConfigMap limit, including
	// JSON escaping and object metadata. Capacity exhaustion never evicts a
	// previously registered client.
	clientRegistryMaxBytes = 768 * 1024
)

type clientRegistryObjects interface {
	Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error
	Update(context.Context, client.Object, ...client.UpdateOption) error
}

// KubernetesClientRegistry stores only client IDs and exact redirect allowlists
// in one pre-created ConfigMap. ResourceVersion updates serialize registrations
// across processes; a restart does not invalidate the host's cached client ID.
// Codes, tokens, state and PKCE material never enter this ConfigMap.
type KubernetesClientRegistry struct {
	objects  clientRegistryObjects
	key      client.ObjectKey
	resource string
}

// NewKubernetesClientRegistry validates the chart-managed registry before the
// component starts. Missing/unreadable or misbound state fails closed rather
// than silently replacing durable metadata with an empty process-local map.
func NewKubernetesClientRegistry(ctx context.Context, objects clientRegistryObjects, namespace, name, resource string) (*KubernetesClientRegistry, error) {
	if objects == nil || namespace == "" || name == "" || resource == "" {
		return nil, errors.New("MCP client registry requires a client, namespace, ConfigMap and resource")
	}
	r := &KubernetesClientRegistry{objects: objects, key: client.ObjectKey{Namespace: namespace, Name: name}, resource: resource}
	if _, err := r.read(ctx); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *KubernetesClientRegistry) read(ctx context.Context) (*corev1.ConfigMap, error) {
	var cm corev1.ConfigMap
	if err := r.objects.Get(ctx, r.key, &cm); err != nil {
		return nil, fmt.Errorf("read MCP client registry: %w", err)
	}
	if cm.Data[clientRegistryResourceKey] != r.resource {
		return nil, errors.New("MCP client registry is bound to a different resource")
	}
	return &cm, nil
}

// Register adds an immutable public registration. A full registry, conflicting
// ID or storage error cannot overwrite another client's redirect allowlist.
func (r *KubernetesClientRegistry) Register(ctx context.Context, id string, redirects []string) error {
	if id == "" || strings.ContainsAny(id, "/\\") || len(id) > 128 {
		return errors.New("invalid dynamic client identifier")
	}
	if errText := (registrationRequest{RedirectURIs: redirects}).validate(); errText != "" {
		return errors.New("invalid dynamic client redirect metadata")
	}
	encoded, err := json.Marshal(redirects)
	if err != nil {
		return fmt.Errorf("encode dynamic client redirects: %w", err)
	}
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		cm, readErr := r.read(ctx)
		if readErr != nil {
			return readErr
		}
		if addErr := addClientRegistration(cm, id, string(encoded)); addErr != nil {
			return addErr
		}
		return r.objects.Update(ctx, cm)
	})
	if err != nil {
		return fmt.Errorf("persist dynamic MCP client registration: %w", err)
	}
	return nil
}

func addClientRegistration(cm *corev1.ConfigMap, id, encoded string) error {
	key := clientRegistryKeyPrefix + id
	if existing, ok := cm.Data[key]; ok {
		if existing == encoded {
			return nil
		}
		return errors.New("dynamic client is already registered")
	}
	if len(cm.Data)-1 >= dynClientCap {
		return errClientRegistryFull
	}
	cm.Data[key] = encoded
	data, err := json.Marshal(cm.Data)
	if err != nil {
		return fmt.Errorf("encode MCP client registry: %w", err)
	}
	if len(data) > clientRegistryMaxBytes {
		return errClientRegistryFull
	}
	return nil
}

// RedirectURIs resolves a registration for this exact MCP resource. Unknown IDs
// have no redirect authority. Malformed state is an error, never a fallback.
func (r *KubernetesClientRegistry) RedirectURIs(ctx context.Context, id string) ([]string, error) {
	cm, err := r.read(ctx)
	if err != nil {
		return nil, err
	}
	encoded, ok := cm.Data[clientRegistryKeyPrefix+id]
	if !ok {
		return nil, nil
	}
	var redirects []string
	if err := json.Unmarshal([]byte(encoded), &redirects); err != nil {
		return nil, errors.New("invalid stored MCP client registration")
	}
	if errText := (registrationRequest{RedirectURIs: redirects}).validate(); errText != "" {
		return nil, errors.New("invalid stored MCP client redirect metadata")
	}
	return redirects, nil
}
