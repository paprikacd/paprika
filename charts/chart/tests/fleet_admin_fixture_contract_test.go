package charttests

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"

	k8syaml "k8s.io/apimachinery/pkg/util/yaml"
)

func TestHelmStageCRDMatchesApprovalGateSchema(t *testing.T) {
	authoritative := readYAMLFile(t, filepath.Join(
		repoRoot(t),
		"config",
		"crd",
		"bases",
		"pipelines.paprika.io_stages.yaml",
	))
	_, rendered := renderChart(t)
	packaged := requireManifest(
		t,
		rendered,
		"CustomResourceDefinition",
		"stages.pipelines.paprika.io",
	)

	authoritativeSchema := stageApprovalGateSchema(t, authoritative)
	packagedSchema := stageApprovalGateSchema(t, packaged)
	authoritativeJSON, err := json.Marshal(authoritativeSchema)
	if err != nil {
		t.Fatalf("encode authoritative Stage approvalGates schema: %v", err)
	}
	packagedJSON, err := json.Marshal(packagedSchema)
	if err != nil {
		t.Fatalf("encode packaged Stage approvalGates schema: %v", err)
	}
	if !bytes.Equal(packagedJSON, authoritativeJSON) {
		t.Fatalf(
			"Helm Stage CRD approvalGates schema drifted from config/crd/bases:\npackaged: %s\nauthoritative: %s",
			packagedJSON,
			authoritativeJSON,
		)
	}
}

func TestHelmApplicationPromotionStageCRDMatchesApprovalGateSchema(t *testing.T) {
	authoritative := readYAMLFile(t, filepath.Join(
		repoRoot(t),
		"config",
		"crd",
		"bases",
		"pipelines.paprika.io_applications.yaml",
	))
	_, rendered := renderChart(t)
	packaged := requireManifest(
		t,
		rendered,
		"CustomResourceDefinition",
		"applications.pipelines.paprika.io",
	)

	authoritativeSchema := applicationPromotionStageApprovalGateSchema(t, authoritative)
	packagedSchema := applicationPromotionStageApprovalGateSchema(t, packaged)
	authoritativeJSON, err := json.Marshal(authoritativeSchema)
	if err != nil {
		t.Fatalf("encode authoritative Application stage approvalGates schema: %v", err)
	}
	packagedJSON, err := json.Marshal(packagedSchema)
	if err != nil {
		t.Fatalf("encode packaged Application stage approvalGates schema: %v", err)
	}
	if !bytes.Equal(packagedJSON, authoritativeJSON) {
		t.Fatalf(
			"Helm Application promotion-stage approvalGates schema drifted from config/crd/bases:\npackaged: %s\nauthoritative: %s",
			packagedJSON,
			authoritativeJSON,
		)
	}
}

func TestHelmFleetAdminStatusFieldsMatchAuthoritativeCRDs(t *testing.T) {
	_, rendered := renderChart(t)
	for _, test := range []struct {
		name        string
		baseFile    string
		crdName     string
		statusField string
	}{
		{
			name:        "Stage observedGeneration",
			baseFile:    "pipelines.paprika.io_stages.yaml",
			crdName:     "stages.pipelines.paprika.io",
			statusField: "observedGeneration",
		},
		{
			name:        "Release rolloutRef",
			baseFile:    "pipelines.paprika.io_releases.yaml",
			crdName:     "releases.pipelines.paprika.io",
			statusField: "rolloutRef",
		},
		{
			name:        "Release phase",
			baseFile:    "pipelines.paprika.io_releases.yaml",
			crdName:     "releases.pipelines.paprika.io",
			statusField: "phase",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			authoritative := readYAMLFile(t, filepath.Join(
				repoRoot(t),
				"config",
				"crd",
				"bases",
				test.baseFile,
			))
			packaged := requireManifest(
				t,
				rendered,
				"CustomResourceDefinition",
				test.crdName,
			)
			authoritativeSchema := crdStatusFieldSchema(
				t,
				authoritative,
				test.statusField,
			)
			packagedSchema := crdStatusFieldSchema(t, packaged, test.statusField)
			authoritativeJSON, err := json.Marshal(authoritativeSchema)
			if err != nil {
				t.Fatalf("encode authoritative %s schema: %v", test.name, err)
			}
			packagedJSON, err := json.Marshal(packagedSchema)
			if err != nil {
				t.Fatalf("encode packaged %s schema: %v", test.name, err)
			}
			if !bytes.Equal(packagedJSON, authoritativeJSON) {
				t.Fatalf(
					"Helm %s schema drifted from config/crd/bases:\npackaged: %s\nauthoritative: %s",
					test.name,
					packagedJSON,
					authoritativeJSON,
				)
			}
		})
	}
}

func TestHelmFleetAdminFixtureStatusSchemasMatchAuthoritativeCRDs(t *testing.T) {
	_, rendered := renderChart(t)
	for _, resource := range []struct {
		name        string
		fixtureFile string
		baseFile    string
		crdName     string
	}{
		{
			name:        "AppProject",
			fixtureFile: "projects.yaml",
			baseFile:    "core.paprika.io_appprojects.yaml",
			crdName:     "appprojects.core.paprika.io",
		},
		{
			name:        "Cluster",
			fixtureFile: "clusters.yaml",
			baseFile:    "clusters.paprika.io_clusters.yaml",
			crdName:     "clusters.clusters.paprika.io",
		},
		{
			name:        "Application",
			fixtureFile: "applications.yaml",
			baseFile:    "pipelines.paprika.io_applications.yaml",
			crdName:     "applications.pipelines.paprika.io",
		},
		{
			name:        "Stage",
			fixtureFile: "stages.yaml",
			baseFile:    "pipelines.paprika.io_stages.yaml",
			crdName:     "stages.pipelines.paprika.io",
		},
		{
			name:        "Release",
			fixtureFile: "releases.yaml",
			baseFile:    "pipelines.paprika.io_releases.yaml",
			crdName:     "releases.pipelines.paprika.io",
		},
		{
			name:        "Pipeline",
			fixtureFile: "pipelines.yaml",
			baseFile:    "pipelines.paprika.io_pipelines.yaml",
			crdName:     "pipelines.pipelines.paprika.io",
		},
		{
			name:        "Rollout",
			fixtureFile: "rollouts.yaml",
			baseFile:    "rollouts.paprika.io_rollouts.yaml",
			crdName:     "rollouts.rollouts.paprika.io",
		},
	} {
		t.Run(resource.name, func(t *testing.T) {
			root := repoRoot(t)
			authoritative := readYAMLFile(t, filepath.Join(
				root,
				"config",
				"crd",
				"bases",
				resource.baseFile,
			))
			packaged := requireManifest(
				t,
				rendered,
				"CustomResourceDefinition",
				resource.crdName,
			)
			fixtures := readYAMLDocuments(t, filepath.Join(
				root,
				"config",
				"e2e",
				"fleet-admin",
				"base",
				resource.fixtureFile,
			))
			fields := make(map[string]struct{})
			for _, fixture := range fixtures {
				status := object(
					t,
					path(fixture, "status"),
					resource.name+" fixture status",
				)
				for field := range status {
					fields[field] = struct{}{}
				}
			}
			fieldNames := make([]string, 0, len(fields))
			for field := range fields {
				fieldNames = append(fieldNames, field)
			}
			sort.Strings(fieldNames)
			for _, field := range fieldNames {
				authoritativeSchema := crdStatusFieldSchema(
					t,
					authoritative,
					field,
				)
				packagedSchema := crdStatusFieldSchema(t, packaged, field)
				authoritativeJSON, err := json.Marshal(authoritativeSchema)
				if err != nil {
					t.Fatalf("encode authoritative %s status.%s schema: %v", resource.name, field, err)
				}
				packagedJSON, err := json.Marshal(packagedSchema)
				if err != nil {
					t.Fatalf("encode packaged %s status.%s schema: %v", resource.name, field, err)
				}
				if !bytes.Equal(packagedJSON, authoritativeJSON) {
					t.Errorf(
						"Helm %s status.%s schema drifted from config/crd/bases:\npackaged: %s\nauthoritative: %s",
						resource.name,
						field,
						packagedJSON,
						authoritativeJSON,
					)
				}
			}
		})
	}
}

func TestFleetAdminStageFixturesLeaveSpecOwnershipToApplicationController(t *testing.T) {
	applications := readYAMLDocuments(t, filepath.Join(
		repoRoot(t),
		"config",
		"e2e",
		"fleet-admin",
		"base",
		"applications.yaml",
	))
	stages := readYAMLDocuments(t, filepath.Join(
		repoRoot(t),
		"config",
		"e2e",
		"fleet-admin",
		"base",
		"stages.yaml",
	))

	var billing manifest
	for _, application := range applications {
		if stringValue(path(application, "metadata", "name")) == "billing" {
			billing = application
			break
		}
	}
	if billing == nil {
		t.Fatal("billing Application fixture is missing")
	}
	promotionStages := list(t, path(billing, "spec", "stages"), "billing promotion stages")
	if len(promotionStages) != 1 {
		t.Fatalf("billing must have one promotion stage, got %d", len(promotionStages))
	}
	gates := list(
		t,
		path(object(t, promotionStages[0], "billing promotion stage"), "approvalGates"),
		"billing approval gates",
	)
	if len(gates) != 1 {
		t.Fatalf("billing promotion stage must own one approval gate, got %d", len(gates))
	}
	gate := object(t, gates[0], "billing approval gate")
	if stringValue(gate["name"]) != "change-review" ||
		stringValue(gate["type"]) != "manual" ||
		stringValue(gate["stage"]) != "production" {
		t.Fatalf("unexpected billing approval gate: %#v", gate)
	}

	if len(stages) != 6 {
		t.Fatalf("expected six Stage status fixtures, got %d", len(stages))
	}
	for _, stage := range stages {
		name := stringValue(path(stage, "metadata", "name"))
		if _, hasSpec := stage["spec"]; hasSpec {
			t.Errorf("Stage fixture %q contains spec; Application controller must be the only spec owner", name)
		}
		if stage["status"] == nil {
			t.Errorf("Stage fixture %q has no status payload", name)
		}
	}
}

func stageApprovalGateSchema(t *testing.T, crd any) any {
	t.Helper()
	for _, versionValue := range list(t, path(crd, "spec", "versions"), "CRD versions") {
		version := object(t, versionValue, "CRD version")
		if stringValue(version["name"]) != "v1alpha1" {
			continue
		}
		schema := path(
			version,
			"schema",
			"openAPIV3Schema",
			"properties",
			"spec",
			"properties",
			"approvalGates",
		)
		if schema == nil {
			t.Fatal("Stage v1alpha1 CRD has no approvalGates schema")
		}
		return schema
	}
	t.Fatal("Stage CRD has no v1alpha1 version")
	return nil
}

func applicationPromotionStageApprovalGateSchema(t *testing.T, crd any) any {
	t.Helper()
	for _, versionValue := range list(t, path(crd, "spec", "versions"), "CRD versions") {
		version := object(t, versionValue, "CRD version")
		if stringValue(version["name"]) != "v1alpha1" {
			continue
		}
		schema := path(
			version,
			"schema",
			"openAPIV3Schema",
			"properties",
			"spec",
			"properties",
			"stages",
			"items",
			"properties",
			"approvalGates",
		)
		if schema == nil {
			t.Fatal("Application v1alpha1 CRD promotion stage has no approvalGates schema")
		}
		return schema
	}
	t.Fatal("Application CRD has no v1alpha1 version")
	return nil
}

func crdStatusFieldSchema(t *testing.T, crd any, field string) any {
	t.Helper()
	for _, versionValue := range list(t, path(crd, "spec", "versions"), "CRD versions") {
		version := object(t, versionValue, "CRD version")
		if stringValue(version["name"]) != "v1alpha1" {
			continue
		}
		schema := path(
			version,
			"schema",
			"openAPIV3Schema",
			"properties",
			"status",
			"properties",
			field,
		)
		if schema == nil {
			t.Fatalf("v1alpha1 CRD status has no %s schema", field)
		}
		return schema
	}
	t.Fatal("CRD has no v1alpha1 version")
	return nil
}

func readYAMLDocuments(t *testing.T, path string) []manifest {
	t.Helper()
	// #nosec G304 -- paths are constructed solely from this test's repository root.
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()

	decoder := k8syaml.NewYAMLOrJSONDecoder(file, 4096)
	var documents []manifest
	for {
		var document manifest
		err := decoder.Decode(&document)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if len(document) != 0 {
			documents = append(documents, document)
		}
	}
	return documents
}
