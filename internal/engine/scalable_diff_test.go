package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestEnsureManagedLabels(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		initialLabels map[string]interface{}
		wantExisting  string
	}{
		{
			name:         "adds labels when absent",
			wantExisting: "",
		},
		{
			name:          "preserves existing labels",
			initialLabels: map[string]interface{}{"existing": "label"},
			wantExisting:  "label",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			metadata := map[string]interface{}{
				"name":      "app",
				"namespace": "default",
			}
			if tc.initialLabels != nil {
				metadata["labels"] = tc.initialLabels
			}

			obj := &unstructured.Unstructured{Object: map[string]interface{}{
				"apiVersion": "apps/v1",
				"kind":       "Deployment",
				"metadata":   metadata,
			}}

			require.NoError(t, ensureManagedLabels(obj, &DiffOptions{ApplicationName: "my-app"}))

			labels := obj.GetLabels()
			assert.Equal(t, ManagedByLabelValue, labels[ManagedByLabelKey])
			assert.Equal(t, "my-app", labels[ApplicationNameLabelKey])
			if tc.wantExisting != "" {
				assert.Equal(t, tc.wantExisting, labels["existing"])
			}
		})
	}
}

func TestComputeDiff_MatchesManagedCronJobs(t *testing.T) {
	t.Parallel()

	desired := []unstructured.Unstructured{{
		Object: map[string]interface{}{
			"apiVersion": "batch/v1",
			"kind":       "CronJob",
			"metadata": map[string]interface{}{
				"name":      "search-index-sync",
				"namespace": "default",
				"labels": map[string]interface{}{
					"app.kubernetes.io/name": "search-index-sync",
				},
			},
			"spec": map[string]interface{}{
				"schedule": "0 3 * * *",
				"suspend":  true,
				"jobTemplate": map[string]interface{}{
					"spec": map[string]interface{}{
						"template": map[string]interface{}{
							"spec": map[string]interface{}{
								"restartPolicy": "Never",
								"containers": []interface{}{
									map[string]interface{}{
										"name":  "search-index-sync",
										"image": "example.com/search-index-sync:test",
									},
								},
							},
						},
					},
				},
			},
		},
	}}
	live := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "search-index-sync",
			Namespace: "default",
			Labels: map[string]string{
				"app.kubernetes.io/name": "search-index-sync",
				ManagedByLabelKey:        ManagedByLabelValue,
				ApplicationNameLabelKey:  "greenveil-meilisearch",
			},
		},
		Spec: batchv1.CronJobSpec{
			Schedule: "0 3 * * *",
			Suspend:  ptrBool(true),
			JobTemplate: batchv1.JobTemplateSpec{
				Spec: batchv1.JobSpec{
					Template: corev1.PodTemplateSpec{
						Spec: corev1.PodSpec{
							RestartPolicy: corev1.RestartPolicyNever,
							Containers: []corev1.Container{{
								Name:  "search-index-sync",
								Image: "example.com/search-index-sync:test",
							}},
						},
					},
				},
			},
		},
	}

	scheme := runtime.NewScheme()
	require.NoError(t, batchv1.AddToScheme(scheme))
	dynClient := fake.NewSimpleDynamicClient(scheme, live)
	eng := NewScalableDiffEngine(dynClient)
	eng.SetLiveCache(nil)

	result, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "default",
		LabelSelector:   ManagedByAppSelector("greenveil-meilisearch").String(),
		ApplicationName: "greenveil-meilisearch",
	})
	require.NoError(t, err)

	assert.Empty(t, result.Added)
	assert.Empty(t, result.Modified)
	assert.Empty(t, result.Deleted)
	require.Len(t, result.Unchanged, 1)
	assert.Equal(t, "CronJob", result.Unchanged[0].Kind)
	assert.Equal(t, 0, result.OutOfSyncCount())
}

func ptrBool(v bool) *bool {
	return &v
}

func TestComputeDiff_AddsManagedLabels(t *testing.T) {
	t.Parallel()
	app := &paprikav1.Application{ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "default"}}
	desired := []unstructured.Unstructured{{
		Object: map[string]interface{}{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata": map[string]interface{}{
				"name":      "app",
				"namespace": "default",
			},
		},
	}}

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "DeploymentList"}, &unstructured.UnstructuredList{})
	dynClient := fake.NewSimpleDynamicClient(scheme)
	eng := NewScalableDiffEngine(dynClient)

	_, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "default",
		ApplicationName: app.Name,
	})
	require.NoError(t, err)

	assert.Equal(t, ManagedByLabelValue, desired[0].GetLabels()[ManagedByLabelKey])
	assert.Equal(t, "my-app", desired[0].GetLabels()[ApplicationNameLabelKey])
}

func TestResourceEqual_TreatsNullAsAbsent(t *testing.T) {
	t.Parallel()

	base := map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "worker",
			"namespace": "deephost",
			"labels": map[string]interface{}{
				ManagedByLabelKey:       ManagedByLabelValue,
				ApplicationNameLabelKey: "deephost",
			},
		},
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{map[string]interface{}{
						"name": "worker",
						"env": []interface{}{
							map[string]interface{}{
								"name":  "AWS_ACCESS_KEY_ID",
								"value": nil,
								"valueFrom": map[string]interface{}{
									"secretKeyRef": map[string]interface{}{
										"name": "deephost-aws",
										"key":  "accessKeyId",
									},
								},
							},
							map[string]interface{}{
								"name":  "AWS_REGION",
								"value": nil,
							},
						},
					}},
					"volumes": []interface{}{map[string]interface{}{
						"name":     "data",
						"emptyDir": nil,
						"persistentVolumeClaim": map[string]interface{}{
							"claimName": "deephost-minio",
						},
					}},
				},
			},
		},
	}
	desired := unstructured.Unstructured{Object: base}

	// server-side apply drops declared-null keys from the stored object.
	live := desired.DeepCopy()
	e := live.Object["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})
	env := e["containers"].([]interface{})[0].(map[string]interface{})["env"].([]interface{})
	delete(env[0].(map[string]interface{}), "value")
	delete(env[1].(map[string]interface{}), "value")
	vol := e["volumes"].([]interface{})[0].(map[string]interface{})
	delete(vol, "emptyDir")

	assert.True(t, resourceEqual(desired, *live))

	// A declared null that live still carries as a value must remain drift.
	stale := desired.DeepCopy()
	s := stale.Object["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})
	s["containers"].([]interface{})[0].(map[string]interface{})["env"].([]interface{})[0].(map[string]interface{})["value"] = "AKIA-STALE"
	assert.False(t, resourceEqual(desired, *stale))
}

func TestComputeDiff_UsesClusterScopeForClusterResources(t *testing.T) {
	t.Parallel()

	desired := []unstructured.Unstructured{
		{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Namespace",
			"metadata": map[string]interface{}{
				"name": "target",
			},
		}},
		{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      "config",
				"namespace": "target",
			},
			"data": map[string]interface{}{"key": "value"},
		}},
	}

	namespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: "target",
		Labels: map[string]string{
			ManagedByLabelKey:       ManagedByLabelValue,
			ApplicationNameLabelKey: "app",
		},
	}}
	configMap := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{
		Name:      "config",
		Namespace: "target",
		Labels: map[string]string{
			ManagedByLabelKey:       ManagedByLabelValue,
			ApplicationNameLabelKey: "app",
		},
	}, Data: map[string]string{"key": "value"}}

	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	dynClient := fake.NewSimpleDynamicClient(scheme, namespace, configMap)
	eng := NewScalableDiffEngine(dynClient)
	eng.SetLiveCache(nil)

	result, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "target",
		LabelSelector:   ManagedByAppSelector("app").String(),
		ApplicationName: "app",
	})
	require.NoError(t, err)
	assert.Empty(t, result.Added)
	assert.Empty(t, result.Deleted)
	assert.Len(t, result.Unchanged, 2)
	assert.Empty(t, result.Modified)
}

func TestResourceEqual_IgnoresKubernetesOmittedDefaults(t *testing.T) {
	t.Parallel()

	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "controlplane",
			"namespace": "deephost",
			"labels": map[string]interface{}{
				ManagedByLabelKey:       ManagedByLabelValue,
				ApplicationNameLabelKey: "deephost",
			},
		},
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{map[string]interface{}{
						"name": "controlplane",
						"env": []interface{}{map[string]interface{}{
							"name":  "DH_BASE_DOMAIN",
							"value": "",
						}},
					}},
				},
			},
		},
	}}
	live := desired.DeepCopy()
	delete(live.Object["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})["containers"].([]interface{})[0].(map[string]interface{})["env"].([]interface{})[0].(map[string]interface{}), "value")
	live.Object["spec"].(map[string]interface{})["strategy"] = map[string]interface{}{"type": "RollingUpdate"}

	assert.True(t, resourceEqual(desired, *live))
}

func TestComputeDiff_IgnoresReleaseOwnedInternalConfigMaps(t *testing.T) {
	t.Parallel()

	desired := []unstructured.Unstructured{{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      "app-config",
				"namespace": "default",
				"labels": map[string]interface{}{
					"app.kubernetes.io/name": "app",
				},
			},
			"data": map[string]interface{}{
				"ENV": "prod",
			},
		},
	}}

	liveConfig := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-config",
			Namespace: "default",
			Labels: map[string]string{
				"app.kubernetes.io/name": "app",
				ManagedByLabelKey:        ManagedByLabelValue,
				ApplicationNameLabelKey:  "my-app",
			},
		},
		Data: map[string]string{"ENV": "prod"},
	}
	internalSnapshot := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "my-app-release-manifest-snapshot",
			Namespace: "default",
			Labels: map[string]string{
				ManagedByLabelKey:        ManagedByLabelValue,
				ApplicationNameLabelKey:  "my-app",
				"app.paprika.io/release": "my-app-release",
			},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: "pipelines.paprika.io/v1alpha1",
				Kind:       "Release",
				Name:       "my-app-release",
				UID:        types.UID("release-uid"),
			}},
		},
		Data: map[string]string{"manifests.yaml": "---"},
	}

	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	dynClient := fake.NewSimpleDynamicClient(scheme, liveConfig, internalSnapshot)
	eng := NewScalableDiffEngine(dynClient)
	eng.SetLiveCache(nil)

	result, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "default",
		LabelSelector:   ManagedByAppSelector("my-app").String(),
		ApplicationName: "my-app",
	})
	require.NoError(t, err)

	assert.Empty(t, result.Added)
	assert.Empty(t, result.Modified)
	assert.Empty(t, result.Deleted)
	require.Len(t, result.Unchanged, 1)
	assert.Equal(t, "app-config", result.Unchanged[0].Name)
	assert.Equal(t, 0, result.OutOfSyncCount())
}

func TestResourceEqual_NormalizesKubernetesResourceQuantities(t *testing.T) {
	t.Parallel()

	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "runner",
			"namespace": "default",
			"labels": map[string]interface{}{
				"app.kubernetes.io/name": "runner",
			},
		},
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{
						map[string]interface{}{
							"name": "runner",
							"resources": map[string]interface{}{
								"limits": map[string]interface{}{
									"cpu":    "1000m",
									"memory": "1024Mi",
								},
							},
						},
					},
				},
			},
		},
	}}
	live := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "runner",
			"namespace": "default",
			"labels": map[string]interface{}{
				"app.kubernetes.io/name": "runner",
			},
		},
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{
						map[string]interface{}{
							"name": "runner",
							"resources": map[string]interface{}{
								"limits": map[string]interface{}{
									"cpu":    "1",
									"memory": "1Gi",
								},
							},
						},
					},
				},
			},
		},
	}}

	assert.True(t, resourceEqual(desired, live))
}

func TestResourceEqual_IgnoresHelmAdoptionAnnotations(t *testing.T) {
	t.Parallel()

	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]interface{}{
			"name":      "search-env",
			"namespace": "default",
			"labels": map[string]interface{}{
				"app.kubernetes.io/name": "meilisearch",
			},
		},
		"data": map[string]interface{}{
			"MEILI_ENV": "production",
		},
	}}
	live := desired.DeepCopy()
	live.SetAnnotations(map[string]string{
		"meta.helm.sh/release-name":      "greenveil-meilisearch",
		"meta.helm.sh/release-namespace": "paprika-e2e",
	})

	assert.True(t, resourceEqual(desired, *live))
}

func TestResourceEqual_IgnoresControllerInjectedLiveMetadata(t *testing.T) {
	t.Parallel()

	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "PersistentVolumeClaim",
		"metadata": map[string]interface{}{
			"name":      "greenveil-meilisearch",
			"namespace": "paprika-e2e",
			"labels": map[string]interface{}{
				"app.kubernetes.io/name": "meilisearch",
			},
			"annotations": map[string]interface{}{
				"backup.velero.io/backup-volumes": "data",
			},
		},
		"spec": map[string]interface{}{
			"accessModes": []interface{}{"ReadWriteOnce"},
			"resources": map[string]interface{}{
				"requests": map[string]interface{}{
					"storage": "10Gi",
				},
			},
		},
	}}
	live := desired.DeepCopy()
	live.SetLabels(map[string]string{
		"app.kubernetes.io/name":       "meilisearch",
		"app.paprika.io/managed-by":    "paprika",
		"app.paprika.io/name":          "greenveil-meilisearch",
		"controller-added.example/key": "value",
	})
	live.SetAnnotations(map[string]string{
		"backup.velero.io/backup-volumes":               "data",
		"pv.kubernetes.io/bind-completed":               "yes",
		"pv.kubernetes.io/bound-by-controller":          "yes",
		"volume.beta.kubernetes.io/storage-provisioner": "bs.csi.vultr.com",
		"volume.kubernetes.io/storage-provisioner":      "bs.csi.vultr.com",
	})

	assert.True(t, resourceEqual(desired, *live))
}

func TestResourceEqual_RequiresDesiredMetadata(t *testing.T) {
	t.Parallel()

	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]interface{}{
			"name":      "app-config",
			"namespace": "default",
			"labels": map[string]interface{}{
				"app.kubernetes.io/name": "app",
			},
			"annotations": map[string]interface{}{
				"checksum/config": "abc123",
			},
		},
		"data": map[string]interface{}{
			"MODE": "prod",
		},
	}}

	missingLabel := desired.DeepCopy()
	missingLabel.SetLabels(map[string]string{})
	assert.False(t, resourceEqual(desired, *missingLabel))

	changedAnnotation := desired.DeepCopy()
	changedAnnotation.SetAnnotations(map[string]string{
		"checksum/config": "def456",
	})
	assert.False(t, resourceEqual(desired, *changedAnnotation))
}

func TestResourceEqual_IgnoresOmittedProbeInitialDelayDefault(t *testing.T) {
	t.Parallel()

	desiredWithLivenessDelay := func(delay interface{}) unstructured.Unstructured {
		return unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata": map[string]interface{}{
				"name":      "api",
				"namespace": "default",
			},
			"spec": map[string]interface{}{
				"template": map[string]interface{}{
					"spec": map[string]interface{}{
						"containers": []interface{}{
							map[string]interface{}{
								"name": "api",
								"livenessProbe": map[string]interface{}{
									"initialDelaySeconds": delay,
									"httpGet": map[string]interface{}{
										"path": "/health",
										"port": "http",
									},
								},
								"readinessProbe": map[string]interface{}{
									"initialDelaySeconds": "0",
									"httpGet": map[string]interface{}{
										"path": "/ready",
										"port": "http",
									},
								},
							},
						},
					},
				},
			},
		}}
	}

	desired := desiredWithLivenessDelay(int64(0))
	live := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "api",
			"namespace": "default",
		},
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{
						map[string]interface{}{
							"name": "api",
							"livenessProbe": map[string]interface{}{
								"httpGet": map[string]interface{}{
									"path": "/health",
									"port": "http",
								},
							},
							"readinessProbe": map[string]interface{}{
								"httpGet": map[string]interface{}{
									"path": "/ready",
									"port": "http",
								},
							},
						},
					},
				},
			},
		},
	}}

	assert.True(t, resourceEqual(desired, live))
	assert.False(t, resourceEqual(desiredWithLivenessDelay(int64(5)), live))
}

func TestComputeDiff_KnativeServiceAndChildServiceDoNotCollide(t *testing.T) {
	t.Parallel()

	ksvc := func() *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "serving.knative.dev/v1",
			"kind":       "Service",
			"metadata": map[string]interface{}{
				"name":      "deephost-hydra",
				"namespace": "deephost",
			},
			"spec": map[string]interface{}{
				"template": map[string]interface{}{
					"spec": map[string]interface{}{
						"containers": []interface{}{map[string]interface{}{
							"name": "hydra",
							"env": []interface{}{map[string]interface{}{
								"name":  "AWS_ACCESS_KEY_ID",
								"value": nil,
								"valueFrom": map[string]interface{}{
									"secretKeyRef": map[string]interface{}{"name": "deephost-aws", "key": "accessKeyId"},
								},
							}},
						}},
					},
				},
			},
		}}
	}
	desired := []unstructured.Unstructured{*ksvc()}

	// Live Knative Service: server-side apply dropped the declared-null value.
	liveKsvc := ksvc()
	liveKsvc.SetLabels(map[string]string{ManagedByLabelKey: ManagedByLabelValue, ApplicationNameLabelKey: "deephost"})
	liveEnv := liveKsvc.Object["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})["containers"].([]interface{})[0].(map[string]interface{})["env"].([]interface{})
	delete(liveEnv[0].(map[string]interface{}), "value")

	// Knative Route child: core Service with the same name; controllers copy
	// the applied resource's labels onto generated children.
	childSvc := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata": map[string]interface{}{
			"name":      "deephost-hydra",
			"namespace": "deephost",
			"labels": map[string]interface{}{
				ManagedByLabelKey:       ManagedByLabelValue,
				ApplicationNameLabelKey: "deephost",
			},
			"ownerReferences": []interface{}{map[string]interface{}{
				"apiVersion": "serving.knative.dev/v1",
				"kind":       "Route",
				"name":       "deephost-hydra",
				"controller": true,
			}},
		},
		"spec": map[string]interface{}{
			"type":         "ExternalName",
			"externalName": "kourier-internal.kourier-system.svc.cluster.local",
		},
	}}

	scheme := runtime.NewScheme()
	listKinds := map[schema.GroupVersionResource]string{
		{Group: "", Version: "v1", Resource: "services"}:                    "ServiceList",
		{Group: "serving.knative.dev", Version: "v1", Resource: "services"}: "ServiceList",
	}
	dynClient := fake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, liveKsvc, childSvc)
	eng := NewScalableDiffEngine(dynClient)
	eng.SetLiveCache(nil)

	result, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "deephost",
		LabelSelector:   ManagedByAppSelector("deephost").String(),
		ApplicationName: "deephost",
	})
	require.NoError(t, err)
	assert.Empty(t, result.Added)
	assert.Empty(t, result.Modified)
	assert.Empty(t, result.Deleted)
	require.Len(t, result.Unchanged, 1)
	assert.Equal(t, "deephost-hydra", result.Unchanged[0].Name)
	assert.Zero(t, result.OutOfSyncCount())
}
