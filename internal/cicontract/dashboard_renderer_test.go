package cicontract

import (
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
	step, rendererIndex := requireNamedStepAt(t, publish, "Publish isolated dashboard renderer", "publish")
	if !strings.HasPrefix(scalarString(step["uses"]), "docker/build-push-action@") || !stepFailureEnforcing(step) {
		t.Fatal("renderer publication must run unconditionally and enforce failure")
	}
	with := requireMappingValue(t, step, "with", "renderer publish")
	if with["push"] != true || scalarString(with["file"]) != "ui/Dockerfile.render-worker" || scalarString(with["platforms"]) != "linux/amd64" {
		t.Fatal("renderer publication must build the isolated amd64 worker")
	}
	if scalarString(with["tags"]) != "ghcr.io/paprikacd/paprika:render-worker-sha-${{ github.sha }}" {
		t.Fatal("renderer must use a disjoint tag in the existing public application package")
	}
	application, applicationIndex := requireNamedStepAt(t, publish, "Build and push", "publish")
	applicationWith := requireMappingValue(t, application, "with", "application publish")
	if !sameStrings(delimitedValues(applicationWith["tags"]), []string{"ghcr.io/paprikacd/paprika:latest", "ghcr.io/paprikacd/paprika:sha-${{ github.sha }}"}) {
		t.Fatal("application tags must remain application images")
	}
	preflight, preflightIndex := requireNamedStepAt(t, publish, "Verify anonymous image access", "publish")
	if !stepFailureEnforcing(preflight) || preflightIndex <= rendererIndex || preflightIndex <= applicationIndex {
		t.Fatal("both images must pass anonymous registry access after publication and before deployment")
	}
	preflightEnv := requireMappingValue(t, preflight, "env", "anonymous image preflight")
	if scalarString(preflightEnv["APPLICATION_IMAGE_REFERENCE"]) != "ghcr.io/paprikacd/paprika@${{ steps.build-push.outputs.digest }}" ||
		scalarString(preflightEnv["RENDER_WORKER_IMAGE_REFERENCE"]) != "ghcr.io/paprikacd/paprika@${{ steps.render-worker.outputs.digest }}" {
		t.Fatal("anonymous access must verify both exact published digests")
	}
	if strings.TrimSpace(scalarString(preflight["run"])) != `bash hack/check-anonymous-image-access.sh "${APPLICATION_IMAGE_REFERENCE}" "${RENDER_WORKER_IMAGE_REFERENCE}"` {
		t.Fatal("anonymous image preflight must enforce the helper result for both images")
	}
	deploy := requireMappingValue(t, workflow.jobs, "deploy-vke", "ci.yml jobs")
	with = requireMappingValue(t, deploy, "with", "deploy-vke")
	if scalarString(with["render_worker_image_ref"]) != "ghcr.io/paprikacd/paprika@${{ needs.publish.outputs.render_worker_digest }}" {
		t.Fatal("VKE must consume the renderer digest from this same validated publication")
	}
	fleet := requireMappingValue(t, workflow.jobs, "fleet-ui-smoke", "ci.yml jobs")
	smoke := requireNamedStep(t, fleet, "Run Insights MCP and dashboard browser smoke", "fleet-ui-smoke")
	if !strings.Contains(scalarString(smoke["run"]), "e2e/insights-render-worker.e2e.mjs") {
		t.Fatal("publication must be gated by a real authenticated browser render")
	}
	vke := vkeDeployJob(t)
	chart := requireNamedStep(t, vke, "Deploy Paprika chart", "deploy-vke")
	run := scalarString(chart["run"])
	if !strings.Contains(run, "bash hack/prepare-dashboard-renderer.sh") || !strings.Contains(run, `--values "${RUNNER_TEMP}/dashboard-renderer-values.json"`) {
		t.Fatal("renderer image and secret setup must be applied through the normal Helm release")
	}
	validation := requireNamedStep(t, vke, "Validate image reference", "deploy-vke")
	if !strings.Contains(scalarString(validation["run"]), `^ghcr\.io/paprikacd/paprika(-render-worker)?@sha256:[0-9a-f]{64}$`) {
		t.Fatal("reject untrusted renderer image references before privileged deployment")
	}
}
