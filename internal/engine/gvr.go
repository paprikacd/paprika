package engine

import (
	"strings"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

// knownGVRs maps common Kubernetes kinds to their GroupVersionResource.
var knownGVRs = map[string]schema.GroupVersionResource{
	"Deployment":               {Group: "apps", Version: "v1", Resource: "deployments"},
	"Service":                  {Group: "", Version: "v1", Resource: "services"},
	"Ingress":                  {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
	"ConfigMap":                {Group: "", Version: "v1", Resource: "configmaps"},
	"Secret":                   {Group: "", Version: "v1", Resource: "secrets"},
	"Namespace":                {Group: "", Version: "v1", Resource: "namespaces"},
	"Job":                      {Group: "batch", Version: "v1", Resource: "jobs"},
	"CronJob":                  {Group: "batch", Version: "v1", Resource: "cronjobs"},
	"Pod":                      {Group: "", Version: "v1", Resource: "pods"},
	"ServiceAccount":           {Group: "", Version: "v1", Resource: "serviceaccounts"},
	"ClusterRole":              {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
	"ClusterRoleBinding":       {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
	"Role":                     {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
	"RoleBinding":              {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
	"PersistentVolumeClaim":    {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
	"StatefulSet":              {Group: "apps", Version: "v1", Resource: "statefulsets"},
	"DaemonSet":                {Group: "apps", Version: "v1", Resource: "daemonsets"},
	"ReplicaSet":               {Group: "apps", Version: "v1", Resource: "replicasets"},
	"HorizontalPodAutoscaler":  {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
	"NetworkPolicy":            {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
	"IngressClass":             {Group: "networking.k8s.io", Version: "v1", Resource: "ingressclasses"},
	"StorageClass":             {Group: "storage.k8s.io", Version: "v1", Resource: "storageclasses"},
	"CustomResourceDefinition": {Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"},
}

// parseAPIVersion splits an apiVersion string into group and version.
func parseAPIVersion(apiVersion string) (group, version string) {
	parts := strings.Split(apiVersion, "/")
	switch len(parts) {
	case 2:
		return parts[0], parts[1]
	case 1:
		return "", parts[0]
	}
	return "", ""
}
