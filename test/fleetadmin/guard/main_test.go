package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	k8syaml "k8s.io/apimachinery/pkg/util/yaml"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/yaml"
)

var (
	testApplicationGVR = schema.GroupVersionResource{
		Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "applications",
	}
	testStageGVR = schema.GroupVersionResource{
		Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "stages",
	}
	testReleaseGVR = schema.GroupVersionResource{
		Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "releases",
	}
	testRolloutGVR = schema.GroupVersionResource{
		Group: "rollouts.paprika.io", Version: "v1alpha1", Resource: "rollouts",
	}
)

const (
	testApplicationNameLabelKey = "app.paprika.io/name"
	testReleaseNameLabelKey     = "app.paprika.io/release"
)

func TestLinkFixtureOwnersMaterializesExactProductionControllerChain(t *testing.T) {
	ownership := testOwnership()
	objects := successfulLinkObjects(ownership)
	foreignStage := fixtureUnstructured(
		"pipelines.paprika.io/v1alpha1",
		"Stage",
		ownership.Namespace,
		"foreign-stage",
		"foreign-stage-uid",
		"21",
		map[string]string{
			suiteLabelKey:               suiteLabelValue,
			runLabelKey:                 "another-run",
			testApplicationNameLabelKey: "checkout",
		},
	)
	objects = append(objects, foreignStage)
	client := newFixtureDynamicClient(objects...)

	require.NoError(t, linkFixtureOwners(context.Background(), client, ownership))

	stage := getFixtureObject(t, client, testStageGVR, ownership.Namespace, "checkout-production")
	assertExactControllerOwner(t, stage, "pipelines.paprika.io/v1alpha1", "Application", "checkout", "app-uid")
	release := getFixtureObject(t, client, testReleaseGVR, ownership.Namespace, "checkout-complete")
	assertExactControllerOwner(t, release, "pipelines.paprika.io/v1alpha1", "Application", "checkout", "app-uid")
	rollout := getFixtureObject(t, client, testRolloutGVR, ownership.Namespace, "checkout-complete-rollout")
	assertExactControllerOwner(t, rollout, "pipelines.paprika.io/v1alpha1", "Release", "checkout-complete", "release-uid")
	require.Empty(t,
		getFixtureObject(t, client, testStageGVR, ownership.Namespace, "foreign-stage").GetOwnerReferences(),
		"a fixture from another run must not be modified",
	)

	patches := fixturePatchActions(client.Actions())
	require.Len(t, patches, 14)
	for _, patch := range patches {
		require.Equal(t, types.JSONPatchType, patch.GetPatchType())
		var operations []struct {
			Op    string `json:"op"`
			Path  string `json:"path"`
			Value any    `json:"value"`
		}
		require.NoError(t, json.Unmarshal(patch.GetPatch(), &operations))
		require.GreaterOrEqual(t, len(operations), 2)
		require.Equal(t, "test", operations[0].Op)
		require.Equal(t, "/metadata/resourceVersion", operations[0].Path)
		require.NotEmpty(t, operations[0].Value)
		require.Equal(t, "add", operations[1].Op)
		require.Equal(t, "/metadata/ownerReferences", operations[1].Path)
	}

	actionCount := len(client.Actions())
	require.NoError(t, linkFixtureOwners(context.Background(), client, ownership))
	require.Equal(t, actionCount+5, len(client.Actions()),
		"idempotent linking may revalidate/list but must not patch existing exact owners")
	require.Len(t, fixturePatchActions(client.Actions()), 14)
}

func TestLinkFixtureOwnersRejectsIncompleteOrUnexpectedExactInventoryBeforePatching(t *testing.T) {
	ownership := testOwnership()
	tests := map[string]func([]runtime.Object) []runtime.Object{
		"incomplete inventory": func(objects []runtime.Object) []runtime.Object {
			return removeFixtureKind(objects, "Rollout")
		},
		"unexpected dual-labeled fixture": func(objects []runtime.Object) []runtime.Object {
			return append(objects, fixtureUnstructured(
				"pipelines.paprika.io/v1alpha1",
				"Stage",
				ownership.Namespace,
				"unexpected-stage",
				"unexpected-stage-uid",
				"99",
				map[string]string{
					suiteLabelKey:               suiteLabelValue,
					runLabelKey:                 ownership.RunID,
					testApplicationNameLabelKey: "checkout",
				},
			))
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			client := newFixtureDynamicClient(mutate(successfulLinkObjects(ownership))...)
			err := linkFixtureOwners(context.Background(), client, ownership)
			require.ErrorContains(t, err, "fixture inventory")
			require.Empty(t, fixturePatchActions(client.Actions()),
				"the complete exact fixture graph must be validated before the first patch")
		})
	}
}

func TestLinkFixtureOwnersValidatesOwnedNamespaceBeforeListingFixtures(t *testing.T) {
	ownership := testOwnership()
	tests := map[string]func(*unstructured.Unstructured){
		"replacement UID": func(namespace *unstructured.Unstructured) {
			namespace.SetUID("replacement")
		},
		"wrong suite": func(namespace *unstructured.Unstructured) {
			labels := namespace.GetLabels()
			labels[suiteLabelKey] = "other"
			namespace.SetLabels(labels)
		},
		"wrong run": func(namespace *unstructured.Unstructured) {
			labels := namespace.GetLabels()
			labels[runLabelKey] = "other"
			namespace.SetLabels(labels)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			namespace := dynamicNamespace(ownership)
			mutate(namespace)
			client := newFixtureDynamicClient(namespace)
			err := linkFixtureOwners(context.Background(), client, ownership)
			require.ErrorContains(t, err, "namespace ownership")
			require.Len(t, client.Actions(), 1, "ownership failure must stop before fixture lists")
			require.Empty(t, fixturePatchActions(client.Actions()))
		})
	}
}

func TestLinkFixtureOwnersRejectsInvalidOwnershipBeforeKubernetes(t *testing.T) {
	client := newFixtureDynamicClient()
	err := linkFixtureOwners(context.Background(), client, namespaceOwnership{
		Namespace: "paprika-fleet-e2e-run-1",
		RunID:     "run-1",
	})
	require.ErrorContains(t, err, "UID")
	require.Empty(t, client.Actions())
}

func TestLinkFixtureOwnersPreflightsEveryAssociationBeforePatching(t *testing.T) {
	ownership := testOwnership()
	tests := map[string]struct {
		mutate      func([]runtime.Object) []runtime.Object
		errorSubstr string
	}{
		"missing parent": {
			mutate: func(objects []runtime.Object) []runtime.Object {
				return removeFixtureKind(objects, "Application")
			},
			errorSubstr: "fixture inventory",
		},
		"empty parent UID": {
			mutate: func(objects []runtime.Object) []runtime.Object {
				findFixtureKind(objects, "Application").SetUID("")
				return objects
			},
			errorSubstr: "empty UID",
		},
		"wrong-labelled parent": {
			mutate: func(objects []runtime.Object) []runtime.Object {
				application := findFixtureKind(objects, "Application")
				labels := application.GetLabels()
				labels[runLabelKey] = "another-run"
				application.SetLabels(labels)
				return objects
			},
			errorSubstr: "ownership labels",
		},
		"conflicting controller": {
			mutate: func(objects []runtime.Object) []runtime.Object {
				stage := findFixtureKind(objects, "Stage")
				stage.SetOwnerReferences([]metav1.OwnerReference{{
					APIVersion: "other.example/v1",
					Kind:       "Other",
					Name:       "conflict",
					UID:        "conflict-uid",
					Controller: testBoolPointer(true),
				}})
				return objects
			},
			errorSubstr: "conflicting controller",
		},
		"empty child resource version": {
			mutate: func(objects []runtime.Object) []runtime.Object {
				findFixtureKind(objects, "Stage").SetResourceVersion("")
				return objects
			},
			errorSubstr: "resourceVersion",
		},
		"rollout application mismatch": {
			mutate: func(objects []runtime.Object) []runtime.Object {
				rollout := findFixtureKind(objects, "Rollout")
				labels := rollout.GetLabels()
				labels[testApplicationNameLabelKey] = "other"
				rollout.SetLabels(labels)
				return objects
			},
			errorSubstr: "application association",
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			client := newFixtureDynamicClient(test.mutate(successfulLinkObjects(ownership))...)
			err := linkFixtureOwners(context.Background(), client, ownership)
			require.ErrorContains(t, err, test.errorSubstr)
			require.Empty(t, fixturePatchActions(client.Actions()),
				"linking must validate the complete graph before the first patch")
		})
	}
}

func TestLinkFixtureOwnersRejectsAmbiguousOrMismatchedListResults(t *testing.T) {
	ownership := testOwnership()
	tests := map[string]struct {
		resource    string
		mutateItems func([]unstructured.Unstructured) []unstructured.Unstructured
		errorSubstr string
	}{
		"ambiguous application": {
			resource: "applications",
			mutateItems: func(items []unstructured.Unstructured) []unstructured.Unstructured {
				return append(items, *items[0].DeepCopy())
			},
			errorSubstr: "ambiguous Application",
		},
		"wrong namespace stage": {
			resource: "stages",
			mutateItems: func(items []unstructured.Unstructured) []unstructured.Unstructured {
				items[0].SetNamespace("other")
				return items
			},
			errorSubstr: "namespace mismatch",
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			client := newFixtureDynamicClient(successfulLinkObjects(ownership)...)
			client.PrependReactor("list", test.resource, func(action k8stesting.Action) (bool, runtime.Object, error) {
				listAction, ok := action.(k8stesting.ListAction)
				require.True(t, ok)
				require.Equal(t,
					labels.Set{
						suiteLabelKey: suiteLabelValue,
						runLabelKey:   ownership.RunID,
					}.AsSelector().String(),
					listAction.GetListRestrictions().Labels.String(),
				)
				gvr := listAction.GetResource()
				tracked, err := client.Tracker().List(gvr, gvr.GroupVersion().WithKind(fixtureKind(gvr)), ownership.Namespace)
				require.NoError(t, err)
				list, ok := tracked.(*unstructured.UnstructuredList)
				require.True(t, ok)
				list.Items = test.mutateItems(list.Items)
				return true, list, nil
			})

			err := linkFixtureOwners(context.Background(), client, ownership)
			require.ErrorContains(t, err, test.errorSubstr)
			require.Empty(t, fixturePatchActions(client.Actions()))
		})
	}
}

func TestLinkFixtureOwnersFailsClosedOnConcurrentResourceVersionChange(t *testing.T) {
	ownership := testOwnership()
	client := newFixtureDynamicClient(successfulLinkObjects(ownership)...)
	client.PrependReactor("patch", "stages", func(action k8stesting.Action) (bool, runtime.Object, error) {
		current, err := client.Tracker().Get(
			testStageGVR,
			ownership.Namespace,
			"checkout-production",
		)
		require.NoError(t, err)
		stage, ok := current.(*unstructured.Unstructured)
		require.True(t, ok)
		stage = stage.DeepCopy()
		stage.SetResourceVersion("concurrent-version")
		require.NoError(t, client.Tracker().Update(testStageGVR, stage, ownership.Namespace))
		return false, nil, nil
	})

	err := linkFixtureOwners(context.Background(), client, ownership)
	require.ErrorContains(t, err, "resourceVersion")
	stage := getFixtureObject(t, client, testStageGVR, ownership.Namespace, "checkout-production")
	require.Empty(t, stage.GetOwnerReferences(), "a stale linker must not overwrite the concurrent object")
}

func TestPlanOwnerPatchRepairsExactControllerWithoutBlockOwnerDeletion(t *testing.T) {
	expected := &metav1.OwnerReference{
		APIVersion:         "pipelines.paprika.io/v1alpha1",
		Kind:               "Application",
		Name:               "checkout",
		UID:                "app-uid",
		Controller:         testBoolPointer(true),
		BlockOwnerDeletion: testBoolPointer(true),
	}
	for _, blockOwnerDeletion := range []*bool{nil, testBoolPointer(false)} {
		object := fixtureUnstructured(
			"pipelines.paprika.io/v1alpha1",
			"Stage",
			"apps",
			"checkout-production",
			"stage-uid",
			"17",
			nil,
		)
		existing := *expected
		existing.BlockOwnerDeletion = blockOwnerDeletion
		object.SetOwnerReferences([]metav1.OwnerReference{existing})

		patch, needed, err := planOwnerPatch(object, testStageGVR, expected)
		require.NoError(t, err)
		require.True(t, needed)
		require.Equal(t, "17", patch.resourceVersion)
		require.Equal(t, []metav1.OwnerReference{*expected}, patch.ownerReferences)
	}
}

func TestRenderOverlayKustomizationUsesRunNamespaceAndNonSelectorLabel(t *testing.T) {
	rendered, err := renderOverlayKustomization("run-1")
	require.NoError(t, err)
	var overlay struct {
		APIVersion string   `yaml:"apiVersion"`
		Kind       string   `yaml:"kind"`
		Namespace  string   `yaml:"namespace"`
		Resources  []string `yaml:"resources"`
		Labels     []struct {
			Pairs            map[string]string `yaml:"pairs"`
			IncludeSelectors *bool             `yaml:"includeSelectors"`
		} `yaml:"labels"`
	}
	require.NoError(t, yaml.Unmarshal(rendered, &overlay))
	require.Equal(t, "kustomize.config.k8s.io/v1beta1", overlay.APIVersion)
	require.Equal(t, "Kustomization", overlay.Kind)
	require.Equal(t, "paprika-fleet-e2e-run-1", overlay.Namespace)
	require.Equal(t, []string{"../base"}, overlay.Resources)
	require.Len(t, overlay.Labels, 1)
	require.Equal(t, map[string]string{runLabelKey: "run-1"}, overlay.Labels[0].Pairs)
	require.NotNil(t, overlay.Labels[0].IncludeSelectors)
	require.False(t, *overlay.Labels[0].IncludeSelectors)

	_, err = renderOverlayKustomization("../escape")
	require.Error(t, err)
}

func TestOverlayCommandWritesOnlyTheValidatedOverlay(t *testing.T) {
	var output bytes.Buffer
	err := run(context.Background(), []string{
		"overlay",
		"--run-id", "run-2",
	}, &output)
	require.NoError(t, err)
	require.NotContains(t, output.String(), "paprika-e2e")
	require.Contains(t, output.String(), "namespace: paprika-fleet-e2e-run-2")
	require.Contains(t, output.String(), "paprika.io/e2e-run: run-2")
	require.Contains(t, output.String(), "includeSelectors: false")
	require.Contains(t, output.String(), "- ../base")
}

func TestOverlayCommandUsesOnlyFixedSiblingBase(t *testing.T) {
	t.Run("fixed base", func(t *testing.T) {
		var output bytes.Buffer
		err := run(context.Background(), []string{
			"overlay",
			"--run-id", "run-2",
		}, &output)
		require.NoError(t, err)
		require.Contains(t, output.String(), "- ../base")
	})

	t.Run("override rejected", func(t *testing.T) {
		err := run(context.Background(), []string{
			"overlay",
			"--run-id", "run-2",
			"--base", "https://attacker.invalid/kustomization.yaml",
		}, io.Discard)
		require.ErrorContains(t, err, "flag provided but not defined")
	})
}

func TestFixtureDocumentsCommandPartitionsControllerOwnedStages(t *testing.T) {
	input := strings.Join([]string{
		"apiVersion: pipelines.paprika.io/v1alpha1",
		"kind: Application",
		"metadata:",
		"  name: billing",
		"---",
		"apiVersion: pipelines.paprika.io/v1alpha1",
		"kind: Stage",
		"metadata:",
		"  name: billing-production",
		"---",
		"apiVersion: pipelines.paprika.io/v1alpha1",
		"kind: Release",
		"metadata:",
		"  name: billing-gated",
		"",
	}, "\n")
	inputPath := t.TempDir() + "/fixtures.yaml"
	require.NoError(t, os.WriteFile(inputPath, []byte(input), 0o600))

	for _, test := range []struct {
		mode  string
		kinds []string
	}{
		{mode: "objects", kinds: []string{"Application", "Release"}},
		{mode: "stages", kinds: []string{"Stage"}},
	} {
		t.Run(test.mode, func(t *testing.T) {
			var output bytes.Buffer
			err := run(t.Context(), []string{
				"fixture-documents",
				"--mode", test.mode,
				"--input", inputPath,
			}, &output)
			require.NoError(t, err)
			require.Equal(t, test.kinds, decodeFixtureDocumentKinds(t, output.String()))
		})
	}
}

func TestFixtureDocumentsCommandRejectsStageSpecs(t *testing.T) {
	inputPath := t.TempDir() + "/fixtures.yaml"
	require.NoError(t, os.WriteFile(inputPath, []byte(strings.Join([]string{
		"apiVersion: pipelines.paprika.io/v1alpha1",
		"kind: Stage",
		"metadata:",
		"  name: billing-production",
		"spec:",
		"  name: production",
		"",
	}, "\n")), 0o600))

	err := run(t.Context(), []string{
		"fixture-documents",
		"--mode", "stages",
		"--input", inputPath,
	}, io.Discard)
	require.ErrorContains(t, err, "application controller must be the only Stage spec owner")
}

func decodeFixtureDocumentKinds(t *testing.T, input string) []string {
	t.Helper()
	decoder := k8syaml.NewYAMLOrJSONDecoder(strings.NewReader(input), 4096)
	var kinds []string
	for {
		var document map[string]any
		err := decoder.Decode(&document)
		if errors.Is(err, io.EOF) {
			return kinds
		}
		require.NoError(t, err)
		if len(document) != 0 {
			kind, ok := document["kind"].(string)
			require.True(t, ok)
			kinds = append(kinds, kind)
		}
	}
}

func TestCreateCommandRejectsInvalidRunIDBeforeClientConfiguration(t *testing.T) {
	err := run(context.Background(), []string{
		"create",
		"--run-id", "INVALID",
		"--kubeconfig", "/definitely/not/a/kubeconfig",
	}, io.Discard)
	require.ErrorContains(t, err, "invalid run ID")
	require.NotContains(t, err.Error(), "Kubernetes client")
	require.NotContains(t, err.Error(), "kubeconfig")
}

func TestGuardCommandsRejectNonPositiveTimeoutBeforeKubernetes(t *testing.T) {
	ownership := testOwnership()
	tests := [][]string{
		{"create", "--run-id", ownership.RunID, "--timeout", "0s"},
		{
			"link",
			"--run-id", ownership.RunID,
			"--namespace", ownership.Namespace,
			"--uid", string(ownership.UID),
			"--timeout", "-1s",
		},
		{
			"delete",
			"--run-id", ownership.RunID,
			"--namespace", ownership.Namespace,
			"--uid", string(ownership.UID),
			"--timeout", "0s",
		},
	}
	for _, args := range tests {
		err := run(t.Context(), args, io.Discard)
		require.ErrorContains(t, err, "timeout must be positive", args[0])
	}
}

func TestBoundedKubernetesContextUsesRequestedDeadline(t *testing.T) {
	start := time.Now()
	ctx, cancel, err := boundedKubernetesContext(t.Context(), 125*time.Millisecond)
	require.NoError(t, err)
	defer cancel()

	deadline, ok := ctx.Deadline()
	require.True(t, ok)
	require.WithinDuration(t, start.Add(125*time.Millisecond), deadline, 50*time.Millisecond)

	_, cancel, err = boundedKubernetesContext(t.Context(), 0)
	require.ErrorContains(t, err, "timeout must be positive")
	require.Nil(t, cancel)
}

func TestValidateRunIDBeforeKubernetes(t *testing.T) {
	client := &recordingNamespaceClient{}
	for _, runID := range []string{
		"", "UPPER", "-leading", "trailing-", "has/slash", "has space",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	} {
		t.Run(runID, func(t *testing.T) {
			client.calls = nil
			_, err := createOwnedNamespace(context.Background(), client, runID)
			require.Error(t, err)
			require.Empty(t, client.calls, "invalid run ID must fail before Kubernetes")
		})
	}

	for _, runID := range []string{"run-1", "20260718-012345", "a"} {
		t.Run("valid-"+runID, func(t *testing.T) {
			name, err := namespaceForRun(runID)
			require.NoError(t, err)
			require.Equal(t, "paprika-fleet-e2e-"+runID, name)
		})
	}
}

func TestCreateOwnedNamespaceRequiresNotFoundAndRecordsCreatedUID(t *testing.T) {
	const runID = "run-1"
	client := &recordingNamespaceClient{
		getErr: apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "paprika-fleet-e2e-run-1"),
		createResult: &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name: "paprika-fleet-e2e-run-1",
				UID:  types.UID("created-uid"),
			},
		},
	}

	ownership, err := createOwnedNamespace(context.Background(), client, runID)
	require.NoError(t, err)
	require.Equal(t, []string{"get", "create"}, client.calls)
	require.Equal(t, namespaceOwnership{
		Namespace: "paprika-fleet-e2e-run-1",
		RunID:     runID,
		UID:       types.UID("created-uid"),
	}, ownership)
	require.Equal(t, map[string]string{
		suiteLabelKey: suiteLabelValue,
		runLabelKey:   runID,
	}, client.created.GetLabels())
}

func TestCreateOwnedNamespaceNeverAdoptsExistingNamespace(t *testing.T) {
	client := &recordingNamespaceClient{
		getResult: &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name: "paprika-fleet-e2e-run-1",
			UID:  types.UID("preexisting"),
			Labels: map[string]string{
				suiteLabelKey: suiteLabelValue,
				runLabelKey:   "run-1",
			},
		}},
	}

	_, err := createOwnedNamespace(context.Background(), client, "run-1")
	require.ErrorContains(t, err, "already exists")
	require.Equal(t, []string{"get"}, client.calls)
	require.Nil(t, client.created)
}

func TestCreateOwnedNamespacePropagatesGetAndRejectsMissingUID(t *testing.T) {
	t.Run("get error", func(t *testing.T) {
		client := &recordingNamespaceClient{getErr: errors.New("transport failure")}
		_, err := createOwnedNamespace(context.Background(), client, "run-1")
		require.ErrorContains(t, err, "checking namespace ownership")
		require.Equal(t, []string{"get"}, client.calls)
	})

	t.Run("missing UID", func(t *testing.T) {
		client := &recordingNamespaceClient{
			getErr:       apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "paprika-fleet-e2e-run-1"),
			createResult: &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "paprika-fleet-e2e-run-1"}},
		}
		_, err := createOwnedNamespace(context.Background(), client, "run-1")
		require.ErrorContains(t, err, "empty UID")
		require.Equal(t, []string{"get", "create"}, client.calls)
	})
}

func TestDeleteOwnedNamespaceRechecksIdentityLabelsAndUIDPrecondition(t *testing.T) {
	ownership := namespaceOwnership{
		Namespace: "paprika-fleet-e2e-run-1",
		RunID:     "run-1",
		UID:       types.UID("created-uid"),
	}
	client := &recordingNamespaceClient{getResult: ownedNamespace(ownership)}

	err := deleteOwnedNamespace(context.Background(), client, ownership)
	require.NoError(t, err)
	require.Equal(t, []string{"get", "delete"}, client.calls)
	require.Equal(t, ownership.Namespace, client.deletedName)
	require.NotNil(t, client.deleteOptions.Preconditions)
	require.NotNil(t, client.deleteOptions.Preconditions.UID)
	require.Equal(t, ownership.UID, *client.deleteOptions.Preconditions.UID)
}

func TestDeleteOwnedNamespaceSafelyRefusesReplacementOrLabelMismatch(t *testing.T) {
	ownership := namespaceOwnership{
		Namespace: "paprika-fleet-e2e-run-1",
		RunID:     "run-1",
		UID:       types.UID("created-uid"),
	}
	tests := map[string]func(*corev1.Namespace){
		"replacement UID": func(namespace *corev1.Namespace) { namespace.UID = types.UID("replacement") },
		"missing suite label": func(namespace *corev1.Namespace) {
			delete(namespace.Labels, suiteLabelKey)
		},
		"wrong suite label": func(namespace *corev1.Namespace) {
			namespace.Labels[suiteLabelKey] = "other"
		},
		"missing run label": func(namespace *corev1.Namespace) {
			delete(namespace.Labels, runLabelKey)
		},
		"wrong run label": func(namespace *corev1.Namespace) {
			namespace.Labels[runLabelKey] = "other"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			namespace := ownedNamespace(ownership)
			mutate(namespace)
			client := &recordingNamespaceClient{getResult: namespace}
			err := deleteOwnedNamespace(context.Background(), client, ownership)
			require.Error(t, err)
			require.Equal(t, []string{"get"}, client.calls)
			require.Empty(t, client.deletedName)
		})
	}
}

func TestDeleteOwnedNamespaceRejectsInvalidRecordBeforeKubernetes(t *testing.T) {
	tests := []namespaceOwnership{
		{},
		{Namespace: "other", RunID: "run-1", UID: types.UID("uid")},
		{Namespace: "paprika-fleet-e2e-run-1", RunID: "", UID: types.UID("uid")},
		{Namespace: "paprika-fleet-e2e-run-1", RunID: "run-1"},
	}
	for _, ownership := range tests {
		client := &recordingNamespaceClient{}
		err := deleteOwnedNamespace(context.Background(), client, ownership)
		require.Error(t, err)
		require.Empty(t, client.calls)
	}
}

type recordingNamespaceClient struct {
	calls         []string
	getResult     *corev1.Namespace
	getErr        error
	createResult  *corev1.Namespace
	createErr     error
	deleteErr     error
	created       *corev1.Namespace
	deletedName   string
	deleteOptions metav1.DeleteOptions
}

func (c *recordingNamespaceClient) Get(_ context.Context, _ string, _ metav1.GetOptions) (*corev1.Namespace, error) {
	c.calls = append(c.calls, "get")
	if c.getResult == nil {
		return nil, c.getErr
	}
	return c.getResult.DeepCopy(), c.getErr
}

func (c *recordingNamespaceClient) Create(
	_ context.Context,
	namespace *corev1.Namespace,
	_ metav1.CreateOptions,
) (*corev1.Namespace, error) {
	c.calls = append(c.calls, "create")
	c.created = namespace.DeepCopy()
	if c.createResult == nil {
		return nil, c.createErr
	}
	return c.createResult.DeepCopy(), c.createErr
}

func (c *recordingNamespaceClient) Delete(
	_ context.Context,
	name string,
	options metav1.DeleteOptions,
) error {
	c.calls = append(c.calls, "delete")
	c.deletedName = name
	c.deleteOptions = options
	return c.deleteErr
}

func ownedNamespace(ownership namespaceOwnership) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: ownership.Namespace,
		UID:  ownership.UID,
		Labels: map[string]string{
			suiteLabelKey: suiteLabelValue,
			runLabelKey:   ownership.RunID,
		},
	}}
}

func testOwnership() namespaceOwnership {
	return namespaceOwnership{
		Namespace: "paprika-fleet-e2e-run-1",
		RunID:     "run-1",
		UID:       "namespace-uid",
	}
}

func successfulLinkObjects(ownership namespaceOwnership) []runtime.Object {
	baseLabels := map[string]string{
		suiteLabelKey: suiteLabelValue,
		runLabelKey:   ownership.RunID,
	}
	objects := make([]runtime.Object, 0, 21)
	objects = append(objects, dynamicNamespace(ownership))
	resourceVersion := 10
	for _, application := range []string{
		"checkout", "catalog", "billing", "ledger", "search", "notifications",
	} {
		uid := application + "-app-uid"
		if application == "checkout" {
			uid = "app-uid"
		}
		objects = append(objects, fixtureUnstructured(
			"pipelines.paprika.io/v1alpha1",
			"Application",
			ownership.Namespace,
			application,
			uid,
			strconv.Itoa(resourceVersion),
			baseLabels,
		))
		resourceVersion++
	}
	for _, stage := range []struct {
		name        string
		application string
	}{
		{name: "checkout-production", application: "checkout"},
		{name: "catalog-staging", application: "catalog"},
		{name: "billing-production", application: "billing"},
		{name: "ledger-production", application: "ledger"},
		{name: "search-development", application: "search"},
		{name: "notifications-development", application: "notifications"},
	} {
		objectLabels := cloneLabels(baseLabels)
		objectLabels[testApplicationNameLabelKey] = stage.application
		objects = append(objects, fixtureUnstructured(
			"pipelines.paprika.io/v1alpha1",
			"Stage",
			ownership.Namespace,
			stage.name,
			stage.name+"-uid",
			strconv.Itoa(resourceVersion),
			objectLabels,
		))
		resourceVersion++
	}
	for _, release := range []struct {
		name        string
		application string
	}{
		{name: "checkout-complete", application: "checkout"},
		{name: "catalog-active", application: "catalog"},
		{name: "billing-gated", application: "billing"},
		{name: "ledger-failed", application: "ledger"},
	} {
		objectLabels := cloneLabels(baseLabels)
		objectLabels[testApplicationNameLabelKey] = release.application
		uid := release.name + "-uid"
		if release.name == "checkout-complete" {
			uid = "release-uid"
		}
		objects = append(objects, fixtureUnstructured(
			"pipelines.paprika.io/v1alpha1",
			"Release",
			ownership.Namespace,
			release.name,
			uid,
			strconv.Itoa(resourceVersion),
			objectLabels,
		))
		resourceVersion++
	}
	for _, rollout := range []struct {
		name        string
		application string
		release     string
	}{
		{name: "checkout-complete-rollout", application: "checkout", release: "checkout-complete"},
		{name: "catalog-active-rollout", application: "catalog", release: "catalog-active"},
		{name: "billing-gated-rollout", application: "billing", release: "billing-gated"},
		{name: "ledger-failed-rollout", application: "ledger", release: "ledger-failed"},
	} {
		objectLabels := cloneLabels(baseLabels)
		objectLabels[testApplicationNameLabelKey] = rollout.application
		objectLabels[testReleaseNameLabelKey] = rollout.release
		objects = append(objects, fixtureUnstructured(
			"rollouts.paprika.io/v1alpha1",
			"Rollout",
			ownership.Namespace,
			rollout.name,
			rollout.name+"-uid",
			strconv.Itoa(resourceVersion),
			objectLabels,
		))
		resourceVersion++
	}
	return objects
}

func dynamicNamespace(ownership namespaceOwnership) *unstructured.Unstructured {
	return fixtureUnstructured(
		"v1", "Namespace", "", ownership.Namespace, string(ownership.UID), "1",
		map[string]string{
			suiteLabelKey: suiteLabelValue,
			runLabelKey:   ownership.RunID,
		},
	)
}

func fixtureUnstructured(
	apiVersion, kind, namespace, name, uid, resourceVersion string,
	labels map[string]string,
) *unstructured.Unstructured {
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": apiVersion,
		"kind":       kind,
		"metadata": map[string]any{
			"name":            name,
			"uid":             uid,
			"resourceVersion": resourceVersion,
		},
	}}
	object.SetNamespace(namespace)
	object.SetLabels(cloneLabels(labels))
	return object
}

func newFixtureDynamicClient(objects ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			testApplicationGVR: "ApplicationList",
			testStageGVR:       "StageList",
			testReleaseGVR:     "ReleaseList",
			testRolloutGVR:     "RolloutList",
		},
		objects...,
	)
}

func getFixtureObject(
	t *testing.T,
	client *dynamicfake.FakeDynamicClient,
	gvr schema.GroupVersionResource,
	namespace, name string,
) *unstructured.Unstructured {
	t.Helper()
	object, err := client.Resource(gvr).Namespace(namespace).Get(context.Background(), name, metav1.GetOptions{})
	require.NoError(t, err)
	return object
}

func assertExactControllerOwner(
	t *testing.T,
	object *unstructured.Unstructured,
	apiVersion, kind, name, uid string,
) {
	t.Helper()
	controllers := make([]metav1.OwnerReference, 0, 1)
	for _, owner := range object.GetOwnerReferences() {
		if owner.Controller != nil && *owner.Controller {
			controllers = append(controllers, owner)
		}
	}
	require.Equal(t, []metav1.OwnerReference{{
		APIVersion:         apiVersion,
		Kind:               kind,
		Name:               name,
		UID:                types.UID(uid),
		Controller:         testBoolPointer(true),
		BlockOwnerDeletion: testBoolPointer(true),
	}}, controllers)
}

func fixturePatchActions(actions []k8stesting.Action) []k8stesting.PatchAction {
	result := make([]k8stesting.PatchAction, 0)
	for _, action := range actions {
		if patch, ok := action.(k8stesting.PatchAction); ok {
			result = append(result, patch)
		}
	}
	return result
}

func findFixtureKind(objects []runtime.Object, kind string) *unstructured.Unstructured {
	for _, object := range objects {
		unstructuredObject, ok := object.(*unstructured.Unstructured)
		if ok && unstructuredObject.GetKind() == kind {
			return unstructuredObject
		}
	}
	return nil
}

func removeFixtureKind(objects []runtime.Object, kind string) []runtime.Object {
	result := make([]runtime.Object, 0, len(objects))
	for _, object := range objects {
		unstructuredObject, ok := object.(*unstructured.Unstructured)
		if !ok || unstructuredObject.GetKind() != kind {
			result = append(result, object)
		}
	}
	return result
}

func cloneLabels(labels map[string]string) map[string]string {
	result := make(map[string]string, len(labels))
	for key, value := range labels {
		result[key] = value
	}
	return result
}

func fixtureKind(gvr schema.GroupVersionResource) string {
	switch gvr {
	case testApplicationGVR:
		return "Application"
	case testStageGVR:
		return "Stage"
	case testReleaseGVR:
		return "Release"
	case testRolloutGVR:
		return "Rollout"
	default:
		return ""
	}
}

func testBoolPointer(value bool) *bool {
	return &value
}
