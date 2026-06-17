//go:build e2e_split
// +build e2e_split

package e2e

import (
	"context"
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

// splitPlanePost performs a POST to the split-plane Connect RPC endpoint and returns the response body.
func splitPlanePost(method, reqBody string) (body []byte, statusCode int, err error) {
	cloudRunBase := "http://localhost:" + cloudRunPort
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cloudRunBase+"/paprika.v1.PaprikaService/"+method,
		strings.NewReader(reqBody))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err = io.ReadAll(resp.Body)
	return body, resp.StatusCode, err
}

var _ = Describe("Split-plane API mirrors controller state", Ordered, func() {
	afterEachCleanup := func() {
		for _, r := range []string{"application", "release", "stage", "template", "pipeline"} {
			cmd := exec.Command("kubectl", "delete", r, "-n", splitNamespace, "-l", "e2e-split-test=true", "--ignore-not-found", "--timeout=10s")
			_, _ = utils.Run(cmd)
		}
	}

	AfterEach(afterEachCleanup)
	AfterAll(afterEachCleanup)

	Context("Application lifecycle via split-plane API", func() {
		It("should create an Application via kubectl and observe it via the cloud-run API", func() {
			By("creating an Application via kubectl")
			app := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Application",
				"metadata": {"name": "split-api-app", "namespace": "%s", "labels": {"e2e-split-test": "true"}},
				"spec": {
					"source": {"type": "helm", "chart": {"path": "/charts/demo-app"}},
					"stages": [{"name": "dev", "ring": 1}],
					"strategy": "Rolling",
					"syncPolicy": "Auto",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, splitNamespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(app)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Application")

			By("waiting for the controller to create owned resources")
			Eventually(func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "template", "split-api-app-template", "-n", splitNamespace)
				_, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
			}, 60*time.Second, 2*time.Second).Should(Succeed())

			By("listing applications via the cloud-run API")
			Eventually(func(g Gomega) {
				body, status, err := splitPlanePost("ListApplications", `{}`)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(status).To(Equal(http.StatusOK), "ListApplications should succeed: %s", string(body))

				var result struct {
					Applications []struct {
						Name      string `json:"name"`
						Namespace string `json:"namespace"`
					} `json:"applications"`
				}
				g.Expect(json.Unmarshal(body, &result)).NotTo(HaveOccurred())

				found := false
				for _, a := range result.Applications {
					if a.Name == "split-api-app" && a.Namespace == splitNamespace {
						found = true
						break
					}
				}
				g.Expect(found).To(BeTrue(), "Cloud-run API should list the created Application")
			}, 30*time.Second, time.Second).Should(Succeed())

			By("getting the application via the cloud-run API")
			Eventually(func(g Gomega) {
				body, status, err := splitPlanePost("GetApplication", fmt.Sprintf(`{"name":"split-api-app","namespace":"%s"}`, splitNamespace))
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(status).To(Equal(http.StatusOK), "GetApplication should succeed: %s", string(body))

				var result struct {
					Application struct {
						Name string `json:"name"`
					} `json:"application"`
				}
				g.Expect(json.Unmarshal(body, &result)).NotTo(HaveOccurred())
				g.Expect(result.Application.Name).To(Equal("split-api-app"))
			}, 30*time.Second, time.Second).Should(Succeed())
		})
	})

	Context("Release lifecycle via split-plane API", func() {
		It("should create a Release via kubectl and observe it via the cloud-run API", func() {
			By("creating a Template, Stage, and Release via kubectl")
			template := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Template",
				"metadata": {"name": "split-api-template", "namespace": "%s", "labels": {"e2e-split-test": "true"}},
				"spec": {"type": "helm", "chart": {"path": "/charts/demo-app"}}
			}`, splitNamespace)
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(template)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Template")

			stage := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Stage",
				"metadata": {"name": "split-api-stage", "namespace": "%s", "labels": {"e2e-split-test": "true"}},
				"spec": {"name": "split-api-stage", "ring": 1, "templates": ["split-api-template"]}
			}`, splitNamespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(stage)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Stage")

			release := fmt.Sprintf(`{
				"apiVersion": "pipelines.paprika.io/v1alpha1",
				"kind": "Release",
				"metadata": {"name": "split-api-release", "namespace": "%s", "labels": {"e2e-split-test": "true"}},
				"spec": {
					"pipeline": "split-api-pipeline",
					"target": "split-api-stage",
					"parameters": {
						"replicaCount": "1",
						"features.canary.enabled": "false",
						"features.monitoring.enabled": "false",
						"features.ingress.enabled": "false"
					}
				}
			}`, splitNamespace)
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(release)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Release")

			By("listing releases via the cloud-run API")
			Eventually(func(g Gomega) {
				body, status, err := splitPlanePost("ListReleases", `{}`)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(status).To(Equal(http.StatusOK), "ListReleases should succeed: %s", string(body))

				var result struct {
					Releases []struct {
						Name      string `json:"name"`
						Namespace string `json:"namespace"`
					} `json:"releases"`
				}
				g.Expect(json.Unmarshal(body, &result)).NotTo(HaveOccurred())

				found := false
				for _, r := range result.Releases {
					if r.Name == "split-api-release" && r.Namespace == splitNamespace {
						found = true
						break
					}
				}
				g.Expect(found).To(BeTrue(), "Cloud-run API should list the created Release")
			}, 30*time.Second, time.Second).Should(Succeed())

			By("listing stages via the cloud-run API")
			Eventually(func(g Gomega) {
				body, status, err := splitPlanePost("ListStages", `{}`)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(status).To(Equal(http.StatusOK), "ListStages should succeed: %s", string(body))

				var result struct {
					Stages []struct {
						Name      string `json:"name"`
						Namespace string `json:"namespace"`
					} `json:"stages"`
				}
				g.Expect(json.Unmarshal(body, &result)).NotTo(HaveOccurred())

				found := false
				for _, s := range result.Stages {
					if s.Name == "split-api-stage" && s.Namespace == splitNamespace {
						found = true
						break
					}
				}
				g.Expect(found).To(BeTrue(), "Cloud-run API should list the created Stage")
			}, 30*time.Second, time.Second).Should(Succeed())
		})
	})
})
