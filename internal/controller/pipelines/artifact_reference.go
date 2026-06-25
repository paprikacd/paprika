package pipelines

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

func parseArtifactReference(path string) (kind, reference string, err error) {
	if strings.HasPrefix(path, "oci://") {
		return "oci", strings.TrimPrefix(path, "oci://"), nil
	}
	if strings.HasPrefix(path, "configmap://") {
		return "configmap", strings.TrimPrefix(path, "configmap://"), nil
	}
	return "", "", fmt.Errorf("unsupported artifact reference scheme: %s", path)
}

func parseConfigMapReference(ref string) (name, key string, err error) {
	parts := strings.SplitN(ref, "/", 2)
	if parts[0] == "" {
		return "", "", fmt.Errorf("invalid configmap reference: %q", ref)
	}
	if len(parts) == 1 {
		return parts[0], "", nil
	}
	return parts[0], parts[1], nil
}

type configMapKeyError struct {
	reason  string
	message string
}

func (e *configMapKeyError) Error() string { return e.message }

func resolveConfigMapKey(cm *corev1.ConfigMap, key string) (string, error) {
	if key != "" {
		if _, ok := cm.Data[key]; ok {
			return key, nil
		}
		if _, ok := cm.BinaryData[key]; ok {
			return key, nil
		}
		return "", &configMapKeyError{
			reason:  "KeyNotFound",
			message: fmt.Sprintf("key %s not found in configmap %s", key, cm.Name),
		}
	}

	allKeys := []string{}
	for k := range cm.Data {
		allKeys = append(allKeys, k)
	}
	for k := range cm.BinaryData {
		allKeys = append(allKeys, k)
	}
	if len(allKeys) == 1 {
		return allKeys[0], nil
	}
	return "", &configMapKeyError{
		reason:  "AmbiguousKeys",
		message: fmt.Sprintf("configmap %s has multiple keys; specify a key in reference", cm.Name),
	}
}
