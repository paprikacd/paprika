//go:build e2e_split
// +build e2e_split

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/benebsworth/paprika/test/utils"
)

var _ = Describe("Split-plane cloud-run API", Ordered, func() {
	cloudRunBase := "http://localhost:" + cloudRunPort
	connectRPC := cloudRunBase + "/paprika.v1.PaprikaService"

	AfterAll(func() {
		By("cleaning up test resources")
		cmd := exec.Command("kubectl", "delete", "pipeline", "split-e2e-pipeline",
			"-n", splitNamespace, "--ignore-not-found", "--timeout=10s")
		_, _ = utils.Run(cmd)
	})

	Context("Health and readiness", func() {
		It("should respond 200 on healthz", func() {
			resp, err := http.Get(cloudRunBase + "/healthz")
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			Expect(strings.TrimSpace(string(body))).To(Equal("ok"))
		})

		It("should serve the UI index page", func() {
			resp, err := http.Get(cloudRunBase + "/")
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			Expect(string(body)).To(ContainSubstring("<!DOCTYPE html>"))
		})
	})

	Context("Connect RPC API", func() {
		It("should list pipelines via Connect unary RPC", func() {
			reqBody := `{}`
			contentType := "application/json"
			resp, err := http.Post(
				connectRPC+"/ListPipelines",
				contentType,
				strings.NewReader(reqBody),
			)
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusOK),
				"ListPipelines should succeed: %s", string(body))

			var envelope struct {
				Msg struct {
					Pipelines []any `json:"pipelines"`
				} `json:"msg"`
			}
			err = json.Unmarshal(body, &envelope)
			Expect(err).NotTo(HaveOccurred())
			Expect(envelope.Msg.Pipelines).NotTo(BeNil())
		})

		It("should list applications via Connect unary RPC", func() {
			reqBody := `{}`
			resp, err := http.Post(
				connectRPC+"/ListApplications",
				"application/json",
				strings.NewReader(reqBody),
			)
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusOK),
				"ListApplications should succeed: %s", string(body))

			var envelope struct {
				Msg struct {
					Applications []any `json:"applications"`
				} `json:"msg"`
			}
			err = json.Unmarshal(body, &envelope)
			Expect(err).NotTo(HaveOccurred())
			Expect(envelope.Msg.Applications).NotTo(BeNil())
		})
	})

	Context("Cross-plane reconciliation", func() {
		It("should see controller-created CRDs via cloud-run API", func() {
			By("creating a Pipeline via kubectl (controllers in Kind)")
			pipeline := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Pipeline",
				"metadata": {"name": "split-e2e-pipeline", "namespace": "%s"},
				"spec": {
					"maxParallel": 1,
					"steps": [{"name": "greet", "image": "alpine:3.19", "script": "echo hello-split"}]
				}
			}`, splitNamespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(pipeline)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create pipeline")

			By("waiting for the controller to reconcile the pipeline")
			Eventually(func(g Gomega) {
				phaseCmd := exec.Command("kubectl", "get", "pipeline", "split-e2e-pipeline",
					"-n", splitNamespace, "-o", "jsonpath={.status.phase}")
				out, phaseErr := utils.Run(phaseCmd)
				g.Expect(phaseErr).NotTo(HaveOccurred())
				g.Expect(out).To(Or(Equal("Succeeded"), Equal("Failed")),
					"Pipeline should have reached terminal state")
			}, 3*time.Minute, time.Second).Should(Succeed())

			By("listing pipelines via cloud-run API to verify cross-plane visibility")
			resp, err := http.Post(
				connectRPC+"/ListPipelines",
				"application/json",
				strings.NewReader(`{}`),
			)
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

			var envelope struct {
				Msg struct {
					Pipelines []struct {
						Name string `json:"name"`
					} `json:"pipelines"`
				} `json:"msg"`
			}
			err = json.Unmarshal(body, &envelope)
			Expect(err).NotTo(HaveOccurred())

			found := false
			for _, p := range envelope.Msg.Pipelines {
				if p.Name == "split-e2e-pipeline" {
					found = true
					break
				}
			}
			Expect(found).To(BeTrue(), "Cloud-run API should see the pipeline created via kubectl")
		})
	})

	Context("Webhook receiver", func() {
		It("should accept webhook events on /webhook", func() {
			By("sending a GitHub push webhook event")
			payload := `{
				"ref": "refs/heads/main",
				"repository": {"clone_url": "https://github.com/example/split-e2e.git"}
			}`
			resp, err := http.Post(
				cloudRunBase+"/webhook",
				"application/json",
				strings.NewReader(payload),
			)
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()

			Expect(resp.StatusCode).To(Equal(http.StatusAccepted),
				"Webhook should be accepted")

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			var result map[string]string
			err = json.Unmarshal(body, &result)
			Expect(err).NotTo(HaveOccurred())
			Expect(result["status"]).To(Equal("accepted"))
		})
	})

	Context("SSE events", func() {
		It("should serve SSE event stream", func() {
			By("connecting to the SSE endpoint")
			resp, err := http.Get(cloudRunBase + "/events?topic=test")
			Expect(err).NotTo(HaveOccurred())
			defer func() { _ = resp.Body.Close() }()

			Expect(resp.StatusCode).To(Equal(http.StatusOK))
			Expect(resp.Header.Get("Content-Type")).To(Equal("text/event-stream"))

			buf := make([]byte, 256)
			n, readErr := resp.Body.Read(buf)
			Expect(readErr).NotTo(HaveOccurred())
			Expect(string(buf[:n])).To(ContainSubstring(":ok"))
		})
	})
})
