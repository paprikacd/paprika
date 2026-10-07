//go:build e2e

package e2e

import (
	"encoding/json"
	"strings"
	"time"

	"connectrpc.com/connect"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	apiserver "github.com/benebsworth/paprika/internal/api"
	pb "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/test/utils"
)

var _ = Describe("PipelineStepRetry", func() {
	It("executes new Jobs after RetryStep reopens a terminal Pipeline without replaying a successful prerequisite", func(ctx SpecContext) {
		const namespace, name = "e2e-step-retry", "e2e-step-retry"
		current, err := utils.Kubectl("config", "current-context")
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(current)).To(Equal("kind-" + kindClusterName))
		var fx Fixture
		DeferCleanup(fx.Teardown)
		DeferCleanup(func() { DeleteByLabel("paprika-system", "paprika.io/pipeline="+name, "jobs", "pods") })
		fx.Apply(promotionJSON(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": namespace}}))
		control := func(value string) string {
			return promotionJSON(map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "retry-control", "namespace": namespace}, "data": map[string]string{"ready": value}})
		}
		fx.Apply(control("off"))
		fx.Apply(promotionJSON(map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": "retry-control", "namespace": namespace}, "spec": map[string]any{
			"replicas": 1, "selector": map[string]any{"matchLabels": map[string]string{"app": "retry-control"}},
			"template": map[string]any{"metadata": map[string]any{"labels": map[string]string{"app": "retry-control"}}, "spec": map[string]any{
				"securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": 1000},
				"containers":      []map[string]any{{"name": "http", "image": inlineArtifactImage, "command": []string{"httpd", "-f", "-p", "8080", "-h", "/www"}, "volumeMounts": []map[string]any{{"name": "control", "mountPath": "/www", "readOnly": true}}}},
				"volumes":         []map[string]any{{"name": "control", "configMap": map[string]string{"name": "retry-control"}}},
			}},
		}}))
		fx.Apply(promotionJSON(map[string]any{"apiVersion": "v1", "kind": "Service", "metadata": map[string]any{"name": "retry-control", "namespace": namespace}, "spec": map[string]any{"selector": map[string]string{"app": "retry-control"}, "ports": []map[string]any{{"port": 8080, "targetPort": 8080}}}}))
		_, err = utils.Kubectl("-n", namespace, "rollout", "status", "deployment/retry-control", "--timeout=90s")
		Expect(err).NotTo(HaveOccurred())
		fx.Apply(promotionJSON(map[string]any{"apiVersion": api.GroupVersion.String(), "kind": "Pipeline", "metadata": map[string]any{"name": name, "namespace": namespace, "labels": map[string]string{"app.paprika.io/project": "default"}}, "spec": api.PipelineSpec{MaxParallel: 1, Steps: []api.PipelineStep{
			{Name: "prerequisite", Image: inlineArtifactImage, Script: "true", Timeout: 15},
			{Name: "verification", Image: inlineArtifactImage, Script: "set -eu\ntest \"$(wget -qO- -T 5 http://retry-control." + namespace + ".svc:8080/ready)\" = on", Timeout: 15, Retry: 1, Depends: []string{"prerequisite"}},
			{Name: "publish", Image: inlineArtifactImage, Script: "true", Timeout: 15, Depends: []string{"verification"}},
		}}}))
		read := func() api.Pipeline {
			raw, err := utils.Kubectl("-n", namespace, "get", "pipeline", name, "-o", "json")
			Expect(err).NotTo(HaveOccurred())
			var pipeline api.Pipeline
			Expect(json.Unmarshal([]byte(raw), &pipeline)).To(Succeed())
			return pipeline
		}
		Eventually(func() api.PipelinePhase { return read().Status.Phase }, 2*time.Minute, time.Second).Should(Equal(api.PipelineFailed))
		before := promotionRetryJobs(name)
		Expect(before.Items).To(HaveLen(3)) // one prerequisite + initial failure + configured retry
		fx.Apply(control("on"))
		Eventually(func(g Gomega) {
			value, err := utils.Kubectl("-n", namespace, "exec", "deployment/retry-control", "--", "cat", "/www/ready")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(value)).To(Equal("on"))
		}, 2*time.Minute, time.Second).Should(Succeed())
		scheme := runtime.NewScheme()
		Expect(api.AddToScheme(scheme)).To(Succeed())
		configuration := ctrl.GetConfigOrDie()
		kube, err := client.New(configuration, client.Options{Scheme: scheme})
		Expect(err).NotTo(HaveOccurred())
		rawKube, err := kubernetes.NewForConfig(configuration)
		Expect(err).NotTo(HaveOccurred())
		// Exercise the production API handler against the real API server. The
		// deployed manager, rather than the test process, executes the new Jobs.
		_, err = apiserver.NewPaprikaServer(kube, nil, apiserver.WithK8sClient(rawKube), apiserver.WithControlPlaneNamespace("paprika-system")).RetryStep(ctx, connect.NewRequest(&pb.RetryStepRequest{PipelineNamespace: namespace, PipelineName: name, StepName: "verification"}))
		Expect(err).NotTo(HaveOccurred())
		Eventually(func() api.PipelinePhase { return read().Status.Phase }, 2*time.Minute, time.Second).Should(Equal(api.PipelineSucceeded))
		after := promotionRetryJobs(name)
		Expect(after.Items).To(HaveLen(5))
		prerequisites, newSucceeded := 0, 0
		for _, job := range after.Items {
			if job.Labels["paprika.io/step"] == "prerequisite" {
				prerequisites++
			}
			old := false
			for _, prior := range before.Items {
				old = old || prior.UID == job.UID
			}
			if !old && job.Status.Succeeded == 1 {
				newSucceeded++
			}
		}
		Expect(prerequisites).To(Equal(1))
		Expect(newSucceeded).To(Equal(2))
	})
})
