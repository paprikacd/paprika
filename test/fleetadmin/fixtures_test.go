package fleetadmin_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/yaml"
)

const (
	suiteLabel       = "paprika.io/e2e-suite"
	suiteName        = "fleet-admin-dashboard"
	projectLabel     = "app.paprika.io/project"
	applicationLabel = "app.paprika.io/name"
)

var fixtureGVKs = map[string]string{
	"AppProject":  "core.paprika.io/v1alpha1",
	"Cluster":     "clusters.paprika.io/v1alpha1",
	"Application": "pipelines.paprika.io/v1alpha1",
	"Stage":       "pipelines.paprika.io/v1alpha1",
	"Release":     "pipelines.paprika.io/v1alpha1",
	"Pipeline":    "pipelines.paprika.io/v1alpha1",
	"Rollout":     "rollouts.paprika.io/v1alpha1",
}

func TestFleetAdminFixturesAreDeterministicAndIsolated(t *testing.T) {
	objects := loadFixtureObjects(t)
	require.NotEmpty(t, objects)

	identities := make(map[string]struct{}, len(objects))
	for _, object := range objects {
		wantAPIVersion, knownKind := fixtureGVKs[object.GetKind()]
		require.Truef(t, knownKind, "unexpected fixture kind %q", object.GetKind())
		require.Equal(t, wantAPIVersion, object.GetAPIVersion(), object.GetKind())
		require.NotEmpty(t, object.GetName())
		require.NotEqual(t, "paprika-e2e", object.GetNamespace(), object.GetName())
		require.Equal(t, suiteName, object.GetLabels()[suiteLabel], object.GetName())
		require.Empty(t, object.GetGenerateName(), "%s must have a stable name", object.GetName())
		require.Empty(t, object.GetUID(), "%s must not carry cluster-assigned identity", object.GetName())
		require.Empty(t, object.GetResourceVersion(), "%s must not carry live metadata", object.GetName())

		identity := strings.Join([]string{
			object.GetAPIVersion(), object.GetKind(), object.GetNamespace(), object.GetName(),
		}, "/")
		_, duplicate := identities[identity]
		require.Falsef(t, duplicate, "duplicate fixture identity %s", identity)
		identities[identity] = struct{}{}

		serialized, err := object.MarshalJSON()
		require.NoError(t, err)
		lower := strings.ToLower(string(serialized))
		for _, forbidden := range []string{
			"kubeconfig", "secretref", "password", "clientsecret", "bearer", "credential",
		} {
			require.NotContainsf(t, lower, forbidden, "%s embeds forbidden credential material", identity)
		}
	}
}

func TestFleetAdminFixtureTopologyUsesProductionAssociations(t *testing.T) {
	objects := loadFixtureObjects(t)
	byKind := indexByKind(t, objects)

	require.GreaterOrEqual(t, len(byKind["AppProject"]), 2)
	require.GreaterOrEqual(t, len(byKind["Cluster"]), 2)
	require.GreaterOrEqual(t, len(byKind["Stage"]), 2)
	require.Len(t, byKind["Application"], 6)

	projects := byKind["AppProject"]
	clusters := byKind["Cluster"]
	pipelines := byKind["Pipeline"]
	stages := byKind["Stage"]
	releases := byKind["Release"]
	rollouts := byKind["Rollout"]
	applications := byKind["Application"]

	for name, pipeline := range pipelines {
		project := pipeline.GetLabels()[projectLabel]
		require.NotEmpty(t, project, "Pipeline %s must be project-labelled", name)
		require.Contains(t, projects, project, "Pipeline %s project", name)
	}

	for name, application := range applications {
		project := nestedString(t, application, "spec", "project")
		require.Equal(t, project, application.GetLabels()[projectLabel], "Application %s project label", name)
		require.Contains(t, projects, project, "Application %s project", name)

		pipelineRef := nestedString(t, application, "status", "pipelineRef")
		pipeline := requireObject(t, pipelines, pipelineRef, "Application %s pipelineRef", name)
		require.Equal(t, project, pipeline.GetLabels()[projectLabel], "Application %s pipeline project", name)

		specStages := nestedSlice(t, application, "spec", "stages")
		statusStageRefs := nestedStringSlice(t, application, "status", "stageRefs")
		require.NotEmpty(t, specStages, "Application %s spec.stages", name)
		require.Len(t, statusStageRefs, len(specStages), "Application %s stageRefs", name)
		for _, stageRef := range statusStageRefs {
			stage := requireObject(t, stages, stageRef, "Application %s stageRef", name)
			require.Equal(t, name, stage.GetLabels()[applicationLabel], "Stage %s application", stageRef)
			require.Equal(t, project, stage.GetLabels()[projectLabel], "Stage %s project", stageRef)
			clusterRef := nestedString(t, stage, "spec", "cluster", "name")
			require.Contains(t, clusters, clusterRef, "Stage %s cluster", stageRef)
			logicalName := nestedString(t, stage, "spec", "name")
			require.Truef(t, applicationHasStage(specStages, logicalName), "Application %s misses logical stage %s", name, logicalName)
		}
	}

	for name, release := range releases {
		applicationName := release.GetLabels()[applicationLabel]
		application := requireObject(t, applications, applicationName, "Release %s application", name)
		require.Equal(t, release.GetLabels()[projectLabel], application.GetLabels()[projectLabel], "Release %s project", name)
		require.Equal(t, name, nestedString(t, application, "status", "releaseRef"), "Release %s reverse application ref", name)
		require.Equal(t, nestedString(t, application, "status", "pipelineRef"), nestedString(t, release, "spec", "pipeline"), "Release %s pipeline", name)
		require.Equal(t, nestedString(t, application, "status", "currentStage"), nestedString(t, release, "spec", "target"), "Release %s stage", name)

		rolloutRef := nestedString(t, release, "status", "rolloutRef")
		rollout := requireObject(t, rollouts, rolloutRef, "Release %s rolloutRef", name)
		require.Equal(t, applicationName, rollout.GetLabels()[applicationLabel], "Rollout %s application", rolloutRef)
		require.Equal(t, name, rollout.GetLabels()["app.paprika.io/release"], "Rollout %s release", rolloutRef)
		require.Equal(t, release.GetLabels()[projectLabel], rollout.GetLabels()[projectLabel], "Rollout %s project", rolloutRef)
	}
}

func TestFleetAdminBaseDefersControllerOwnersUntilRuntimeUIDsExist(t *testing.T) {
	byKind := indexByKind(t, loadFixtureObjects(t))
	for _, application := range byKind["Application"] {
		require.Empty(t, application.GetUID(), "base must not hardcode an Application UID")
	}
	for _, kind := range []string{"Stage", "Release", "Rollout"} {
		for _, object := range byKind[kind] {
			require.Emptyf(t, object.GetOwnerReferences(),
				"%s/%s controller owner must be linked from the live parent UID", kind, object.GetName())
		}
	}
}

func TestFleetAdminFixturesCoverEveryFleetHealthAndDeliveryState(t *testing.T) {
	byKind := indexByKind(t, loadFixtureObjects(t))

	healthStates := make(map[string]bool)
	for _, application := range byKind["Application"] {
		healthStates[fixtureFleetHealth(t, application)] = true
	}
	require.Equal(t, map[string]bool{
		"Healthy": true, "Progressing": true, "Degraded": true,
		"Failed": true, "Unknown": true, "Missing": true,
	}, healthStates)

	releaseStates := objectPhases(t, byKind["Release"])
	for _, phase := range []string{"Promoting", "Complete", "Failed", "AwaitingApproval"} {
		require.Truef(t, releaseStates[phase], "missing Release phase %s", phase)
	}

	rolloutStates := objectPhases(t, byKind["Rollout"])
	for _, phase := range []string{"Progressing", "Healthy", "Failed", "Paused"} {
		require.Truef(t, rolloutStates[phase], "missing Rollout phase %s", phase)
	}
}

func TestFleetAdminFixtureStatusesCanBePatchedSeparately(t *testing.T) {
	for _, object := range loadFixtureObjects(t) {
		status, hasStatus := object.Object["status"]
		require.Truef(t, hasStatus, "%s/%s needs a deterministic status fixture", object.GetKind(), object.GetName())
		_, statusIsMap := status.(map[string]any)
		require.Truef(t, statusIsMap, "%s/%s status must be an object", object.GetKind(), object.GetName())

		objectOnly := object.DeepCopy()
		delete(objectOnly.Object, "status")
		require.NotEmpty(t, objectOnly.GetAPIVersion())
		require.NotEmpty(t, objectOnly.GetKind())
		require.NotEmpty(t, objectOnly.GetName())
		require.Contains(t, objectOnly.Object, "spec")

		statusOnly := map[string]any{
			"apiVersion": object.GetAPIVersion(),
			"kind":       object.GetKind(),
			"metadata": map[string]any{
				"name": object.GetName(),
			},
			"status": status,
		}
		metadata, metadataOK := statusOnly["metadata"].(map[string]any)
		require.True(t, metadataOK)
		if object.GetNamespace() != "" {
			metadata["namespace"] = object.GetNamespace()
		}
		require.NotContains(t, statusOnly, "spec")
	}
}

func TestFleetAdminDeployerRBACAddsOnlyExactFixtureAuthority(t *testing.T) {
	objects := decodeYAMLFile(t, filepath.Join(repoRoot(t), "terraform", "github-actions-deployer-rbac.yaml"))
	var clusterRole *unstructured.Unstructured
	for _, object := range objects {
		if object.GetKind() == "ClusterRole" && object.GetName() == "github-actions-vke-deployer" {
			clusterRole = object
			break
		}
	}
	require.NotNil(t, clusterRole)
	rules := nestedSlice(t, clusterRole, "rules")

	type exactRule struct {
		group     string
		resources []string
		verbs     []string
	}
	want := []exactRule{
		{group: "", resources: []string{"namespaces"}, verbs: []string{"create", "delete", "get"}},
		{group: "core.paprika.io", resources: []string{"appprojects"}, verbs: []string{"create", "delete", "get", "list", "patch", "watch"}},
		{group: "core.paprika.io", resources: []string{"appprojects/status"}, verbs: []string{"patch", "update"}},
		{group: "clusters.paprika.io", resources: []string{"clusters"}, verbs: []string{"create", "delete", "get", "list", "patch", "watch"}},
		{group: "clusters.paprika.io", resources: []string{"clusters/status"}, verbs: []string{"patch", "update"}},
		{group: "pipelines.paprika.io", resources: []string{"applications", "pipelines", "releases", "stages"}, verbs: []string{"create", "delete", "get", "list", "patch", "watch"}},
		{group: "pipelines.paprika.io", resources: []string{"applications/status", "pipelines/status", "releases/status", "stages/status"}, verbs: []string{"patch", "update"}},
		{group: "rollouts.paprika.io", resources: []string{"rollouts"}, verbs: []string{"create", "delete", "get", "list", "patch", "watch"}},
		{group: "rollouts.paprika.io", resources: []string{"rollouts/status"}, verbs: []string{"patch", "update"}},
	}
	for _, expected := range want {
		require.Truef(t, containsExactRule(rules, expected.group, expected.resources, expected.verbs),
			"missing exact fixture rule group=%q resources=%v verbs=%v", expected.group, expected.resources, expected.verbs)
	}

	// Legacy deployment rules remain out of scope. These assertions inspect only
	// the newly granted Paprika fixture authority and its namespace rule.
	for _, rawRule := range rules {
		rule, ruleOK := rawRule.(map[string]any)
		require.True(t, ruleOK)
		groups := stringValues(t, rule["apiGroups"])
		resources := stringValues(t, rule["resources"])
		verbs := stringValues(t, rule["verbs"])
		isFixtureRule := slices.Contains(groups, "core.paprika.io") ||
			slices.Contains(groups, "clusters.paprika.io") ||
			slices.Contains(groups, "pipelines.paprika.io") ||
			slices.Contains(groups, "rollouts.paprika.io") ||
			(len(groups) == 1 && groups[0] == "" && slices.Equal(resources, []string{"namespaces"}))
		if !isFixtureRule {
			continue
		}
		require.NotContains(t, groups, "*")
		require.NotContains(t, resources, "*")
		require.NotContains(t, verbs, "*")
		for _, forbidden := range []string{
			"secrets", "serviceaccounts", "roles", "rolebindings",
			"clusterroles", "clusterrolebindings", "users", "groups", "serviceaccounts/token",
		} {
			require.NotContains(t, resources, forbidden)
		}
		require.NotContains(t, verbs, "impersonate")
		require.NotContains(t, verbs, "bind")
		require.NotContains(t, verbs, "escalate")
	}

	role := findObject(t, objects, "Role", "github-actions-vke-deployer")
	roleRules := nestedSlice(t, role, "rules")
	require.True(t, containsPermission(roleRules, "", "pods/portforward", "create"),
		"existing pod port-forward permission must be retained")
}

func loadFixtureObjects(t *testing.T) []*unstructured.Unstructured {
	t.Helper()
	base := filepath.Join(repoRoot(t), "config", "e2e", "fleet-admin", "base")
	// #nosec G304 -- this path is anchored to the checked-in test fixture directory.
	kustomizationBytes, err := os.ReadFile(filepath.Join(base, "kustomization.yaml"))
	require.NoError(t, err)
	var kustomization struct {
		Resources []string `yaml:"resources"`
	}
	require.NoError(t, yaml.Unmarshal(kustomizationBytes, &kustomization))
	require.Equal(t, []string{
		"projects.yaml", "clusters.yaml", "applications.yaml", "stages.yaml",
		"releases.yaml", "rollouts.yaml", "pipelines.yaml",
	}, kustomization.Resources)

	objects := make([]*unstructured.Unstructured, 0, len(kustomization.Resources))
	for _, resource := range kustomization.Resources {
		require.Equal(t, filepath.Base(resource), resource, "base resources must not escape their directory")
		objects = append(objects, decodeYAMLFile(t, filepath.Join(base, resource))...)
	}
	return objects
}

func decodeYAMLFile(t *testing.T, path string) []*unstructured.Unstructured {
	t.Helper()
	// #nosec G304 -- callers provide paths anchored to this repository's committed fixtures.
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	decoder := yaml.NewYAMLOrJSONDecoder(bytes.NewReader(data), 4096)
	var objects []*unstructured.Unstructured
	for {
		object := &unstructured.Unstructured{}
		err = decoder.Decode(object)
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoError(t, err, path)
		if len(object.Object) != 0 {
			objects = append(objects, object)
		}
	}
	require.NotEmpty(t, objects, path)
	return objects
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	require.True(t, ok)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func indexByKind(t *testing.T, objects []*unstructured.Unstructured) map[string]map[string]*unstructured.Unstructured {
	t.Helper()
	result := make(map[string]map[string]*unstructured.Unstructured)
	for _, object := range objects {
		if result[object.GetKind()] == nil {
			result[object.GetKind()] = make(map[string]*unstructured.Unstructured)
		}
		require.NotContains(t, result[object.GetKind()], object.GetName())
		result[object.GetKind()][object.GetName()] = object
	}
	return result
}

func nestedString(t *testing.T, object *unstructured.Unstructured, fields ...string) string {
	t.Helper()
	value, found, err := unstructured.NestedString(object.Object, fields...)
	require.NoError(t, err)
	require.Truef(t, found, "%s/%s misses %s", object.GetKind(), object.GetName(), strings.Join(fields, "."))
	require.NotEmpty(t, value, "%s/%s %s", object.GetKind(), object.GetName(), strings.Join(fields, "."))
	return value
}

func nestedSlice(t *testing.T, object *unstructured.Unstructured, fields ...string) []any {
	t.Helper()
	value, found, err := unstructured.NestedSlice(object.Object, fields...)
	require.NoError(t, err)
	require.Truef(t, found, "%s/%s misses %s", object.GetKind(), object.GetName(), strings.Join(fields, "."))
	return value
}

func nestedStringSlice(t *testing.T, object *unstructured.Unstructured, fields ...string) []string {
	t.Helper()
	raw := nestedSlice(t, object, fields...)
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		value, ok := item.(string)
		require.True(t, ok)
		require.NotEmpty(t, value)
		result = append(result, value)
	}
	return result
}

func requireObject(
	t *testing.T,
	objects map[string]*unstructured.Unstructured,
	name, format string,
	args ...any,
) *unstructured.Unstructured {
	t.Helper()
	object := objects[name]
	require.NotNilf(t, object, format, args...)
	return object
}

func applicationHasStage(stages []any, name string) bool {
	for _, rawStage := range stages {
		stage, ok := rawStage.(map[string]any)
		if ok && stage["name"] == name {
			return true
		}
	}
	return false
}

func fixtureFleetHealth(t *testing.T, application *unstructured.Unstructured) string {
	t.Helper()
	resources, _, err := unstructured.NestedSlice(application.Object, "status", "resources")
	require.NoError(t, err)
	for _, rawResource := range resources {
		resource, ok := rawResource.(map[string]any)
		require.True(t, ok)
		if resource["status"] == "Missing" {
			return "Missing"
		}
	}
	health, _, err := unstructured.NestedString(application.Object, "status", "health")
	require.NoError(t, err)
	if health != "" {
		return health
	}
	phase := nestedString(t, application, "status", "phase")
	switch phase {
	case "Pending", "Building", "Promoting", "Canarying", "Verifying":
		return "Progressing"
	case "Degraded", "RolledBack":
		return "Degraded"
	case "Failed":
		return "Failed"
	case "Healthy":
		return "Healthy"
	default:
		return "Unknown"
	}
}

func objectPhases(t *testing.T, objects map[string]*unstructured.Unstructured) map[string]bool {
	t.Helper()
	result := make(map[string]bool, len(objects))
	for _, object := range objects {
		result[nestedString(t, object, "status", "phase")] = true
	}
	return result
}

func containsExactRule(rules []any, group string, resources, verbs []string) bool {
	wantResources := append([]string(nil), resources...)
	wantVerbs := append([]string(nil), verbs...)
	slices.Sort(wantResources)
	slices.Sort(wantVerbs)
	for _, rawRule := range rules {
		rule, ok := rawRule.(map[string]any)
		if !ok {
			continue
		}
		groups := values(rule["apiGroups"])
		gotResources := values(rule["resources"])
		gotVerbs := values(rule["verbs"])
		slices.Sort(gotResources)
		slices.Sort(gotVerbs)
		if slices.Equal(groups, []string{group}) &&
			slices.Equal(gotResources, wantResources) &&
			slices.Equal(gotVerbs, wantVerbs) {
			return true
		}
	}
	return false
}

func containsPermission(rules []any, group, resource, verb string) bool {
	for _, rawRule := range rules {
		rule, ok := rawRule.(map[string]any)
		if !ok {
			continue
		}
		if slices.Contains(values(rule["apiGroups"]), group) &&
			slices.Contains(values(rule["resources"]), resource) &&
			slices.Contains(values(rule["verbs"]), verb) {
			return true
		}
	}
	return false
}

func stringValues(t *testing.T, raw any) []string {
	t.Helper()
	result := values(raw)
	require.NotNil(t, result)
	return result
}

func values(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		value, ok := item.(string)
		if !ok {
			return nil
		}
		result = append(result, value)
	}
	return result
}

func findObject(
	t *testing.T,
	objects []*unstructured.Unstructured,
	kind, name string,
) *unstructured.Unstructured {
	t.Helper()
	for _, object := range objects {
		if object.GetKind() == kind && object.GetName() == name {
			return object
		}
	}
	t.Fatalf("missing %s/%s", kind, name)
	return nil
}
