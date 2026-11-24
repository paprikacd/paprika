package cicontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestDashboardRendererDeploymentContract(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	publish := requireMappingValue(t, workflow.jobs, "publish", "ci.yml jobs")
	outputs := requireMappingValue(t, publish, "outputs", "publish")
	if normalizeExpression(scalarString(outputs["render_worker_digest"])) != "steps.render-worker.outputs.digest" {
		t.Fatal("renderer output must come from the trusted image publication step")
	}
	step := requireNamedStep(t, publish, "Publish isolated dashboard renderer", "publish")
	if !strings.HasPrefix(scalarString(step["uses"]), "docker/build-push-action@") || !stepFailureEnforcing(step) {
		t.Fatal("renderer publication must run unconditionally and enforce failure")
	}
	with := requireMappingValue(t, step, "with", "renderer publish")
	if with["push"] != true || scalarString(with["file"]) != "ui/Dockerfile.render-worker" || scalarString(with["platforms"]) != "linux/amd64" {
		t.Fatal("renderer publication must build the isolated amd64 worker")
	}
	deploy := requireMappingValue(t, workflow.jobs, "deploy-vke", "ci.yml jobs")
	with = requireMappingValue(t, deploy, "with", "deploy-vke")
	if scalarString(with["render_worker_image_ref"]) != "ghcr.io/paprikacd/paprika-render-worker@${{ needs.publish.outputs.render_worker_digest }}" {
		t.Fatal("VKE must consume the renderer digest from this same validated publication")
	}
	fleet := requireMappingValue(t, workflow.jobs, "fleet-ui-smoke", "ci.yml jobs")
	smoke := requireNamedStep(t, fleet, "Run Insights MCP and dashboard browser smoke", "fleet-ui-smoke")
	// The smoke step runs the manifest's smoke tag; the render worker must be a member of that tag.
	if !strings.Contains(scalarString(smoke["run"]), "--tag smoke") {
		t.Fatal("smoke step must run the smoke tag from ui/e2e/insights-suites.json")
	}
	requireRenderWorkerInSmoke(t, repositoryRoot(t))
	vke := vkeDeployJob(t)
	chart := requireNamedStep(t, vke, "Deploy Paprika chart", "deploy-vke")
	run := scalarString(chart["run"])
	if !strings.Contains(run, "bash hack/prepare-dashboard-renderer.sh") || !strings.Contains(run, `--values "${RUNNER_TEMP}/dashboard-renderer-values.json"`) {
		t.Fatal("renderer image and secret setup must be applied through the normal Helm release")
	}
	validation := requireNamedStep(t, vke, "Validate image reference", "deploy-vke")
	if !strings.Contains(scalarString(validation["run"]), `^ghcr\.io/paprikacd/paprika-render-worker@sha256:[0-9a-f]{64}$`) {
		t.Fatal("reject untrusted renderer image references before privileged deployment")
	}
	health := requireNamedStep(t, vke, "Verify dashboard renderer", "deploy-vke")
	if !stepFailureEnforcing(health) || health["timeout-minutes"] != 2 {
		t.Fatal("renderer health verification must fail the deployment and have a bounded timeout")
	}
	healthRun := scalarString(health["run"])
	if !strings.Contains(healthRun, `bash hack/check-dashboard-renderer-health.sh "${VKE_NAMESPACE}" "${HELM_RELEASE}"`) || strings.Contains(healthRun, " exec ") {
		t.Fatal("renderer verification must use the existing port-forward permission, not pod exec")
	}
}

// requireRenderWorkerInSmoke checks that the Insights render worker suite carries the smoke tag in the suite
// manifest, so the browser render that gates the renderer image publication runs in CI.
func requireRenderWorkerInSmoke(t *testing.T, root string) {
	t.Helper()
	// #nosec G304 -- the path is a fixed repository location.
	manifestData, err := os.ReadFile(filepath.Join(root, "ui", "e2e", "insights-suites.json"))
	if err != nil {
		t.Fatalf("read Insights suite manifest: %v", err)
	}
	var manifest struct {
		Suites []struct {
			File string   `json:"file"`
			Tags []string `json:"tags"`
		} `json:"suites"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatalf("parse Insights suite manifest: %v", err)
	}
	renderWorkerInSmoke := false
	for _, suite := range manifest.Suites {
		if suite.File == "e2e/insights-render-worker.e2e.mjs" && slices.Contains(suite.Tags, "smoke") {
			renderWorkerInSmoke = true
		}
	}
	if !renderWorkerInSmoke {
		t.Fatal("publication must be gated by a real authenticated browser render: the render worker suite must carry the smoke tag")
	}
}
