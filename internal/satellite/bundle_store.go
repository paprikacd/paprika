package satellite

import (
	"context"
	"errors"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// RecordingExecutor remembers every bundle a satellite applies, including the
// ones the control plane pushed over the link.
type RecordingExecutor struct {
	Inner TaskExecutor
	Store BundleStore
	Now   func() time.Time
}

// Apply runs the bundle and remembers it when the apply succeeded.
func (e *RecordingExecutor) Apply(ctx context.Context, namespace, appName string, manifests []byte) (applied int, errs []string, err error) {
	if e.Inner == nil {
		return 0, nil, errors.New("satellite has no apply executor")
	}
	applied, errs, err = e.Inner.Apply(ctx, namespace, appName, manifests)
	if err != nil {
		return applied, errs, fmt.Errorf("apply bundle: %w", err)
	}
	if len(errs) > 0 {
		return applied, errs, nil
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	if storeErr := e.Store.Put(ctx, &Bundle{
		Namespace: namespace, Application: appName, Manifests: manifests, AppliedAt: now(),
	}); storeErr != nil {
		// The apply already happened; losing the record only costs autonomy for
		// this application, so report it without failing the task.
		log.FromContext(ctx).Error(storeErr, "Could not remember an applied bundle",
			"namespace", namespace, "application", appName)
	}
	return applied, errs, nil
}

// ConfigMapBundleStore keeps bundles in a ConfigMap in the satellite's own
// namespace. A ConfigMap is enough: one value per application, written on every
// successful apply, and readable after a restart without mounting a volume.
type ConfigMapBundleStore struct {
	client    kubernetes.Interface
	namespace string
	name      string
}

// NewConfigMapBundleStore returns a store backed by one ConfigMap.
func NewConfigMapBundleStore(client kubernetes.Interface, namespace, name string) *ConfigMapBundleStore {
	return &ConfigMapBundleStore{client: client, namespace: namespace, name: name}
}

// bundleKey is a ConfigMap-safe key for one application.
func bundleKey(bundle *Bundle) string {
	return bundle.Namespace + "." + bundle.Application
}

// Put records the bundle for one application.
//
// The write is a read-modify-write of one shared object, so two applies landing
// together conflict. Retrying matters: losing the record does not fail the
// apply, it silently removes that application from what the satellite enforces
// during the next outage.
func (s *ConfigMapBundleStore) Put(ctx context.Context, bundle *Bundle) error {
	key := bundleKey(bundle)
	configMaps := s.client.CoreV1().ConfigMaps(s.namespace)
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		existing, err := configMaps.Get(ctx, s.name, metav1.GetOptions{})
		if err != nil {
			if !apierrors.IsNotFound(err) {
				return fmt.Errorf("read satellite bundle store: %w", err)
			}
			_, createErr := configMaps.Create(ctx, bundleConfigMap(s.namespace, s.name, key, bundle.Manifests), metav1.CreateOptions{})
			if createErr == nil {
				return nil
			}
			if !apierrors.IsAlreadyExists(createErr) {
				return fmt.Errorf("create satellite bundle store: %w", createErr)
			}
			// Another writer created it first; re-read and take the update path.
			existing, err = configMaps.Get(ctx, s.name, metav1.GetOptions{})
			if err != nil {
				return fmt.Errorf("re-read satellite bundle store: %w", err)
			}
		}
		if existing.Data == nil {
			existing.Data = map[string]string{}
		}
		existing.Data[key] = string(bundle.Manifests)
		if _, err := configMaps.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update satellite bundle store: %w", err)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("record bundle for %s: %w", key, err)
	}
	return nil
}

// List returns every remembered bundle.
func (s *ConfigMapBundleStore) List(ctx context.Context) ([]Bundle, error) {
	configMap, err := s.client.CoreV1().ConfigMaps(s.namespace).Get(ctx, s.name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read satellite bundle store: %w", err)
	}
	bundles := make([]Bundle, 0, len(configMap.Data))
	for key, manifests := range configMap.Data {
		namespace, application, ok := splitBundleKey(key)
		if !ok {
			continue
		}
		bundles = append(bundles, Bundle{Namespace: namespace, Application: application, Manifests: []byte(manifests)})
	}
	return bundles, nil
}

// bundleConfigMap is the store's object shape. One ConfigMap key per
// application keeps updates independent: an apply for one application does not
// rewrite another's bundle.
func bundleConfigMap(namespace, name, key string, manifests []byte) *corev1.ConfigMap {
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "paprika-satellite",
			},
		},
		Data: map[string]string{key: string(manifests)},
	}
}

// splitBundleKey parses "<namespace>.<application>". Namespaces and names are
// both DNS labels and never contain a dot, so the first dot is the separator.
func splitBundleKey(key string) (namespace, application string, ok bool) {
	for i := 0; i < len(key); i++ {
		if key[i] == '.' {
			return key[:i], key[i+1:], true
		}
	}
	return "", "", false
}
