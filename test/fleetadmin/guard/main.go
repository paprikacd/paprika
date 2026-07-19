package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	k8syaml "k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/yaml"
)

const (
	namespacePrefix = "paprika-fleet-e2e-"
	suiteLabelKey   = "paprika.io/e2e-suite"
	suiteLabelValue = "fleet-admin-dashboard"
	runLabelKey     = "paprika.io/e2e-run"

	applicationNameLabelKey  = "app.paprika.io/name"
	releaseNameLabelKey      = "app.paprika.io/release"
	defaultKubernetesTimeout = 60 * time.Second
)

var (
	namespaceGVR   = schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}
	applicationGVR = schema.GroupVersionResource{
		Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "applications",
	}
	stageGVR = schema.GroupVersionResource{
		Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "stages",
	}
	releaseGVR = schema.GroupVersionResource{
		Group: "pipelines.paprika.io", Version: "v1alpha1", Resource: "releases",
	}
	rolloutGVR = schema.GroupVersionResource{
		Group: "rollouts.paprika.io", Version: "v1alpha1", Resource: "rollouts",
	}
	expectedApplications = map[string]string{
		"billing":       "",
		"catalog":       "",
		"checkout":      "",
		"ledger":        "",
		"notifications": "",
		"search":        "",
	}
	expectedStages = map[string]string{
		"billing-production":        "billing",
		"catalog-staging":           "catalog",
		"checkout-production":       "checkout",
		"ledger-production":         "ledger",
		"notifications-development": "notifications",
		"search-development":        "search",
	}
	expectedReleases = map[string]string{
		"billing-gated":     "billing",
		"catalog-active":    "catalog",
		"checkout-complete": "checkout",
		"ledger-failed":     "ledger",
	}
	expectedRollouts = map[string]fixtureRolloutAssociation{
		"billing-gated-rollout": {
			application: "billing",
			release:     "billing-gated",
		},
		"catalog-active-rollout": {
			application: "catalog",
			release:     "catalog-active",
		},
		"checkout-complete-rollout": {
			application: "checkout",
			release:     "checkout-complete",
		},
		"ledger-failed-rollout": {
			application: "ledger",
			release:     "ledger-failed",
		},
	}
)

type fixtureRolloutAssociation struct {
	application string
	release     string
}

type namespaceClient interface {
	Get(context.Context, string, metav1.GetOptions) (*corev1.Namespace, error)
	Create(context.Context, *corev1.Namespace, metav1.CreateOptions) (*corev1.Namespace, error)
	Delete(context.Context, string, metav1.DeleteOptions) error
}

type namespaceOwnership struct {
	Namespace string    `json:"namespace"`
	RunID     string    `json:"runId"`
	UID       types.UID `json:"uid"`
}

type ownershipCommandFlags struct {
	ownership  namespaceOwnership
	kubeconfig string
	context    string
	timeout    time.Duration
}

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New(
			"usage: fleetadmin-guard <create|delete|fixture-documents|link|overlay>",
		)
	}
	switch args[0] {
	case "create":
		return runCreate(ctx, args[1:], output)
	case "delete":
		return runDelete(ctx, args[1:])
	case "fixture-documents":
		return runFixtureDocuments(args[1:], output)
	case "link":
		return runLink(ctx, args[1:])
	case "overlay":
		return runOverlay(args[1:], output)
	default:
		return fmt.Errorf("unknown fleetadmin-guard command %q", args[0])
	}
}

func runFixtureDocuments(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("fixture-documents", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	mode := flags.String("mode", "", "document partition: objects or stages")
	inputPath := flags.String("input", "", "rendered fixture document path")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("parse fixture-documents flags: %w", err)
	}
	if *inputPath == "" {
		return errors.New("fixture-documents input is required")
	}
	if *mode != "objects" && *mode != "stages" {
		return fmt.Errorf("fixture-documents mode must be objects or stages, got %q", *mode)
	}
	// #nosec G304 -- the caller supplies a harness-owned temporary fixture path.
	input, err := os.Open(*inputPath)
	if err != nil {
		return fmt.Errorf("open fixture documents: %w", err)
	}
	partitionErr := partitionFixtureDocuments(input, output, *mode)
	closeErr := input.Close()
	if partitionErr != nil {
		return partitionErr
	}
	if closeErr != nil {
		return fmt.Errorf("close fixture documents: %w", closeErr)
	}
	return nil
}

func partitionFixtureDocuments(input io.Reader, output io.Writer, mode string) error {
	decoder := k8syaml.NewYAMLOrJSONDecoder(input, 4096)
	var selected [][]byte
	for {
		var document map[string]any
		err := decoder.Decode(&document)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("decode fixture document: %w", err)
		}
		if len(document) == 0 {
			continue
		}
		rendered, include, err := renderSelectedFixtureDocument(document, mode)
		if err != nil {
			return err
		}
		if !include {
			continue
		}
		selected = append(selected, rendered)
	}
	return writeFixtureDocuments(output, selected)
}

func renderSelectedFixtureDocument(
	document map[string]any,
	mode string,
) (rendered []byte, include bool, err error) {
	apiVersion, kind, identityErr := fixtureDocumentIdentity(document)
	if identityErr != nil {
		return nil, false, identityErr
	}
	isControllerOwnedStage := apiVersion == "pipelines.paprika.io/v1alpha1" &&
		kind == "Stage"
	validationErr := validateControllerOwnedStageDocument(document, isControllerOwnedStage)
	if validationErr != nil {
		return nil, false, validationErr
	}
	include = mode == "objects" && !isControllerOwnedStage ||
		mode == "stages" && isControllerOwnedStage
	if !include {
		return nil, false, nil
	}
	rendered, err = yaml.Marshal(document)
	if err != nil {
		return nil, false, fmt.Errorf("render fixture document: %w", err)
	}
	return rendered, true, nil
}

func fixtureDocumentIdentity(
	document map[string]any,
) (apiVersion, kind string, err error) {
	apiVersion, apiVersionOK := document["apiVersion"].(string)
	kind, kindOK := document["kind"].(string)
	if !apiVersionOK || apiVersion == "" || !kindOK || kind == "" {
		return "", "", errors.New("fixture document must have non-empty apiVersion and kind")
	}
	return apiVersion, kind, nil
}

func validateControllerOwnedStageDocument(
	document map[string]any,
	isControllerOwnedStage bool,
) error {
	if !isControllerOwnedStage {
		return nil
	}
	if _, hasSpec := document["spec"]; !hasSpec {
		return nil
	}
	return fmt.Errorf(
		"stage %q contains spec; application controller must be the only Stage spec owner",
		pathString(document, "metadata", "name"),
	)
}

func writeFixtureDocuments(output io.Writer, documents [][]byte) error {
	for index, document := range documents {
		if index != 0 {
			if _, err := io.WriteString(output, "---\n"); err != nil {
				return fmt.Errorf("write fixture document separator: %w", err)
			}
		}
		if _, err := output.Write(document); err != nil {
			return fmt.Errorf("write fixture document: %w", err)
		}
	}
	return nil
}

func pathString(document map[string]any, keys ...string) string {
	var current any = document
	for _, key := range keys {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	value, ok := current.(string)
	if !ok {
		return ""
	}
	return value
}

func runCreate(ctx context.Context, args []string, output io.Writer) error {
	flags := flag.NewFlagSet("create", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	runID := flags.String("run-id", "", "unique fleet-admin run ID")
	kubeconfig := flags.String("kubeconfig", "", "path to kubeconfig")
	contextName := flags.String("context", "", "kubeconfig context")
	timeout := flags.Duration(
		"timeout",
		defaultKubernetesTimeout,
		"maximum duration for Kubernetes operations",
	)
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("parse create flags: %w", err)
	}
	if _, err := namespaceForRun(*runID); err != nil {
		return err
	}
	operationCtx, cancel, err := boundedKubernetesContext(ctx, *timeout)
	if err != nil {
		return err
	}
	defer cancel()
	client, err := newNamespaceClient(*kubeconfig, *contextName)
	if err != nil {
		return err
	}
	ownership, err := createOwnedNamespace(operationCtx, client, *runID)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(output).Encode(ownership); err != nil {
		return fmt.Errorf("write namespace ownership: %w", err)
	}
	return nil
}

func runDelete(ctx context.Context, args []string) error {
	settings, err := parseOwnershipCommandFlags("delete", args)
	if err != nil {
		return err
	}
	client, err := newNamespaceClient(settings.kubeconfig, settings.context)
	if err != nil {
		return err
	}
	operationCtx, cancel, err := boundedKubernetesContext(ctx, settings.timeout)
	if err != nil {
		return err
	}
	defer cancel()
	return deleteOwnedNamespace(operationCtx, client, settings.ownership)
}

func runLink(ctx context.Context, args []string) error {
	settings, err := parseOwnershipCommandFlags("link", args)
	if err != nil {
		return err
	}
	client, err := newDynamicClient(settings.kubeconfig, settings.context)
	if err != nil {
		return err
	}
	operationCtx, cancel, err := boundedKubernetesContext(ctx, settings.timeout)
	if err != nil {
		return err
	}
	defer cancel()
	return linkFixtureOwners(operationCtx, client, settings.ownership)
}

func parseOwnershipCommandFlags(command string, args []string) (ownershipCommandFlags, error) {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	settings := ownershipCommandFlags{}
	flags.StringVar(&settings.ownership.RunID, "run-id", "", "fleet-admin run ID")
	flags.StringVar(&settings.ownership.Namespace, "namespace", "", "recorded namespace")
	flags.Func("uid", "recorded namespace UID", func(value string) error {
		settings.ownership.UID = types.UID(value)
		return nil
	})
	flags.StringVar(&settings.kubeconfig, "kubeconfig", "", "path to kubeconfig")
	flags.StringVar(&settings.context, "context", "", "kubeconfig context")
	flags.DurationVar(
		&settings.timeout,
		"timeout",
		defaultKubernetesTimeout,
		"maximum duration for Kubernetes operations",
	)
	if err := flags.Parse(args); err != nil {
		return ownershipCommandFlags{}, fmt.Errorf("parse %s flags: %w", command, err)
	}
	if err := validateOwnership(settings.ownership); err != nil {
		return ownershipCommandFlags{}, err
	}
	if settings.timeout <= 0 {
		return ownershipCommandFlags{}, errors.New("timeout must be positive")
	}
	return settings, nil
}

func boundedKubernetesContext(
	ctx context.Context,
	timeout time.Duration,
) (context.Context, context.CancelFunc, error) {
	if timeout <= 0 {
		return nil, nil, errors.New("timeout must be positive")
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	return bounded, cancel, nil
}

func runOverlay(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("overlay", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	runID := flags.String("run-id", "", "unique fleet-admin run ID")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("parse overlay flags: %w", err)
	}
	rendered, err := renderOverlayKustomization(*runID)
	if err != nil {
		return err
	}
	if _, err := output.Write(rendered); err != nil {
		return fmt.Errorf("write overlay: %w", err)
	}
	return nil
}

func namespaceForRun(runID string) (string, error) {
	if problems := validation.IsDNS1123Label(runID); len(problems) != 0 {
		return "", fmt.Errorf("invalid run ID: %s", problems[0])
	}
	name := namespacePrefix + runID
	if problems := validation.IsDNS1123Label(name); len(problems) != 0 {
		return "", fmt.Errorf("invalid run ID for namespace: %s", problems[0])
	}
	return name, nil
}

func renderOverlayKustomization(runID string) ([]byte, error) {
	namespace, err := namespaceForRun(runID)
	if err != nil {
		return nil, err
	}
	overlay := struct {
		APIVersion string   `json:"apiVersion"`
		Kind       string   `json:"kind"`
		Namespace  string   `json:"namespace"`
		Resources  []string `json:"resources"`
		Labels     []struct {
			Pairs            map[string]string `json:"pairs"`
			IncludeSelectors bool              `json:"includeSelectors"`
		} `json:"labels"`
	}{
		APIVersion: "kustomize.config.k8s.io/v1beta1",
		Kind:       "Kustomization",
		Namespace:  namespace,
		Resources:  []string{"../base"},
	}
	overlay.Labels = append(overlay.Labels, struct {
		Pairs            map[string]string `json:"pairs"`
		IncludeSelectors bool              `json:"includeSelectors"`
	}{
		Pairs:            map[string]string{runLabelKey: runID},
		IncludeSelectors: false,
	})
	rendered, err := yaml.Marshal(overlay)
	if err != nil {
		return nil, fmt.Errorf("render overlay: %w", err)
	}
	return rendered, nil
}

func createOwnedNamespace(
	ctx context.Context,
	client namespaceClient,
	runID string,
) (namespaceOwnership, error) {
	name, err := namespaceForRun(runID)
	if err != nil {
		return namespaceOwnership{}, err
	}
	existing, err := client.Get(ctx, name, metav1.GetOptions{})
	switch {
	case err == nil && existing != nil:
		return namespaceOwnership{}, fmt.Errorf("namespace %q already exists; refusing adoption", name)
	case err == nil:
		return namespaceOwnership{}, fmt.Errorf("checking namespace ownership: empty response for %q", name)
	case !apierrors.IsNotFound(err):
		return namespaceOwnership{}, fmt.Errorf("checking namespace ownership: %w", err)
	}

	created, err := client.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: name,
		Labels: map[string]string{
			suiteLabelKey: suiteLabelValue,
			runLabelKey:   runID,
		},
	}}, metav1.CreateOptions{})
	if err != nil {
		return namespaceOwnership{}, fmt.Errorf("creating owned namespace: %w", err)
	}
	if created == nil || created.Name != name {
		return namespaceOwnership{}, errors.New("created namespace identity does not match request")
	}
	if created.UID == "" {
		return namespaceOwnership{}, errors.New("created namespace has empty UID")
	}
	return namespaceOwnership{Namespace: name, RunID: runID, UID: created.UID}, nil
}

func deleteOwnedNamespace(
	ctx context.Context,
	client namespaceClient,
	ownership namespaceOwnership,
) error {
	if err := validateOwnership(ownership); err != nil {
		return err
	}
	current, err := client.Get(ctx, ownership.Namespace, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("re-reading owned namespace: %w", err)
	}
	if current == nil {
		return errors.New("re-reading owned namespace returned an empty response")
	}
	if current.Name != ownership.Namespace || current.UID != ownership.UID {
		return errors.New("namespace identity changed; refusing delete")
	}
	if current.Labels[suiteLabelKey] != suiteLabelValue ||
		current.Labels[runLabelKey] != ownership.RunID {
		return errors.New("namespace ownership labels changed; refusing delete")
	}
	uid := ownership.UID
	if err := client.Delete(ctx, ownership.Namespace, metav1.DeleteOptions{
		Preconditions: &metav1.Preconditions{UID: &uid},
	}); err != nil {
		return fmt.Errorf("deleting owned namespace: %w", err)
	}
	return nil
}

func validateOwnership(ownership namespaceOwnership) error {
	namespace, err := namespaceForRun(ownership.RunID)
	if err != nil {
		return err
	}
	if ownership.Namespace != namespace {
		return errors.New("recorded namespace does not match run ID")
	}
	if ownership.UID == "" {
		return errors.New("recorded namespace UID is required")
	}
	return nil
}

func newNamespaceClient(kubeconfig, contextName string) (namespaceClient, error) {
	config, err := kubernetesConfig(kubeconfig, contextName)
	if err != nil {
		return nil, err
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create Kubernetes client: %w", err)
	}
	return clientset.CoreV1().Namespaces(), nil
}

func newDynamicClient(kubeconfig, contextName string) (dynamic.Interface, error) {
	config, err := kubernetesConfig(kubeconfig, contextName)
	if err != nil {
		return nil, err
	}
	client, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create Kubernetes dynamic client: %w", err)
	}
	return client, nil
}

func kubernetesConfig(kubeconfig, contextName string) (*rest.Config, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if kubeconfig != "" {
		loadingRules.ExplicitPath = kubeconfig
	}
	overrides := &clientcmd.ConfigOverrides{CurrentContext: contextName}
	config, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules,
		overrides,
	).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("load Kubernetes client configuration: %w", err)
	}
	return config, nil
}

type fixtureObjects struct {
	applications map[string]*unstructured.Unstructured
	stages       map[string]*unstructured.Unstructured
	releases     map[string]*unstructured.Unstructured
	rollouts     map[string]*unstructured.Unstructured
}

type ownerPatch struct {
	gvr              schema.GroupVersionResource
	name             string
	resourceVersion  string
	ownerReferences  []metav1.OwnerReference
	expectedOwnerRef *metav1.OwnerReference
}

type jsonPatchOperation struct {
	Operation string `json:"op"`
	Path      string `json:"path"`
	Value     any    `json:"value"`
}

func linkFixtureOwners(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
) error {
	if err := validateOwnership(ownership); err != nil {
		return err
	}
	if err := validateDynamicNamespaceOwnership(ctx, client, ownership); err != nil {
		return err
	}
	objects, err := loadOwnedFixtureObjects(ctx, client, ownership)
	if err != nil {
		return err
	}
	if inventoryErr := validateExactFixtureInventory(ctx, client, ownership, objects); inventoryErr != nil {
		return inventoryErr
	}
	patches, err := planFixtureOwnerPatches(ctx, client, ownership, objects)
	if err != nil {
		return err
	}
	for index := range patches {
		if err := applyOwnerPatch(ctx, client, ownership.Namespace, &patches[index]); err != nil {
			return err
		}
	}
	return nil
}

func validateDynamicNamespaceOwnership(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
) error {
	namespace, err := client.Resource(namespaceGVR).Get(ctx, ownership.Namespace, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("re-read namespace ownership: %w", err)
	}
	if namespace.GetName() != ownership.Namespace ||
		namespace.GetUID() != ownership.UID ||
		namespace.GetLabels()[suiteLabelKey] != suiteLabelValue ||
		namespace.GetLabels()[runLabelKey] != ownership.RunID {
		return errors.New("namespace ownership UID or labels do not match the recorded namespace")
	}
	return nil
}

func loadOwnedFixtureObjects(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
) (fixtureObjects, error) {
	selector := labels.Set{
		suiteLabelKey: suiteLabelValue,
		runLabelKey:   ownership.RunID,
	}.AsSelector().String()
	applications, err := listOwnedFixtureKind(
		ctx, client, ownership, applicationGVR, "Application", selector,
	)
	if err != nil {
		return fixtureObjects{}, err
	}
	stages, err := listOwnedFixtureKind(ctx, client, ownership, stageGVR, "Stage", selector)
	if err != nil {
		return fixtureObjects{}, err
	}
	releases, err := listOwnedFixtureKind(ctx, client, ownership, releaseGVR, "Release", selector)
	if err != nil {
		return fixtureObjects{}, err
	}
	rollouts, err := listOwnedFixtureKind(ctx, client, ownership, rolloutGVR, "Rollout", selector)
	if err != nil {
		return fixtureObjects{}, err
	}
	return fixtureObjects{
		applications: applications,
		stages:       stages,
		releases:     releases,
		rollouts:     rollouts,
	}, nil
}

func validateExactFixtureInventory(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	objects fixtureObjects,
) error {
	for _, inventory := range []struct {
		kind     string
		gvr      schema.GroupVersionResource
		objects  map[string]*unstructured.Unstructured
		expected map[string]string
	}{
		{kind: "Application", gvr: applicationGVR, objects: objects.applications, expected: expectedApplications},
		{kind: "Stage", gvr: stageGVR, objects: objects.stages, expected: expectedStages},
		{kind: "Release", gvr: releaseGVR, objects: objects.releases, expected: expectedReleases},
	} {
		if err := validateExactFixtureNames(
			ctx,
			client,
			ownership,
			inventory.gvr,
			inventory.kind,
			inventory.objects,
			inventory.expected,
		); err != nil {
			return err
		}
	}
	if err := validateExactFixtureNames(
		ctx,
		client,
		ownership,
		rolloutGVR,
		"Rollout",
		objects.rollouts,
		expectedRolloutNames(),
	); err != nil {
		return err
	}
	if err := validateApplicationAssociations("Stage", objects.stages, expectedStages); err != nil {
		return err
	}
	if err := validateApplicationAssociations("Release", objects.releases, expectedReleases); err != nil {
		return err
	}
	return validateRolloutAssociations(objects.rollouts)
}

func expectedRolloutNames() map[string]string {
	names := make(map[string]string, len(expectedRollouts))
	for name := range expectedRollouts {
		names[name] = ""
	}
	return names
}

func validateApplicationAssociations(
	kind string,
	objects map[string]*unstructured.Unstructured,
	expected map[string]string,
) error {
	for name, application := range expected {
		if actual := objects[name].GetLabels()[applicationNameLabelKey]; actual != application {
			return fmt.Errorf(
				"fixture inventory: %s %q application association is %q, expected %q",
				kind,
				name,
				actual,
				application,
			)
		}
	}
	return nil
}

func validateRolloutAssociations(rollouts map[string]*unstructured.Unstructured) error {
	for name, expected := range expectedRollouts {
		labels := rollouts[name].GetLabels()
		if actual := labels[applicationNameLabelKey]; actual != expected.application {
			return fmt.Errorf(
				"fixture inventory: Rollout %q application association is %q, expected %q",
				name,
				actual,
				expected.application,
			)
		}
		if actual := labels[releaseNameLabelKey]; actual != expected.release {
			return fmt.Errorf(
				"fixture inventory: Rollout %q release association is %q, expected %q",
				name,
				actual,
				expected.release,
			)
		}
	}
	return nil
}

func validateExactFixtureNames(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	gvr schema.GroupVersionResource,
	kind string,
	objects map[string]*unstructured.Unstructured,
	expected map[string]string,
) error {
	for _, name := range sortedFixtureNames(objects) {
		if _, exists := expected[name]; !exists {
			return fmt.Errorf("fixture inventory: unexpected %s %q", kind, name)
		}
	}
	expectedNames := make([]string, 0, len(expected))
	for name := range expected {
		expectedNames = append(expectedNames, name)
	}
	sort.Strings(expectedNames)
	for _, name := range expectedNames {
		if objects[name] != nil {
			continue
		}
		candidate, err := client.Resource(gvr).Namespace(ownership.Namespace).Get(
			ctx,
			name,
			metav1.GetOptions{},
		)
		if apierrors.IsNotFound(err) {
			return fmt.Errorf("fixture inventory: expected %s %q is missing", kind, name)
		}
		if err != nil {
			return fmt.Errorf("fixture inventory: get expected %s %q: %w", kind, name, err)
		}
		if !hasFixtureOwnershipLabels(candidate, ownership) {
			return fmt.Errorf(
				"fixture inventory: expected %s %q ownership labels do not match the run",
				kind,
				name,
			)
		}
		return fmt.Errorf(
			"fixture inventory: expected %s %q was not returned by the exact run selector",
			kind,
			name,
		)
	}
	return nil
}

func listOwnedFixtureKind(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	gvr schema.GroupVersionResource,
	kind, selector string,
) (map[string]*unstructured.Unstructured, error) {
	list, err := client.Resource(gvr).Namespace(ownership.Namespace).List(
		ctx,
		metav1.ListOptions{LabelSelector: selector},
	)
	if err != nil {
		return nil, fmt.Errorf("list owned %s fixtures: %w", kind, err)
	}
	result := make(map[string]*unstructured.Unstructured, len(list.Items))
	for index := range list.Items {
		object := list.Items[index].DeepCopy()
		if object.GetNamespace() != ownership.Namespace {
			return nil, fmt.Errorf("%s %q namespace mismatch", kind, object.GetName())
		}
		if !hasFixtureOwnershipLabels(object, ownership) {
			return nil, fmt.Errorf("%s %q ownership labels do not match the run", kind, object.GetName())
		}
		if object.GetName() == "" {
			return nil, fmt.Errorf("%s fixture has an empty name", kind)
		}
		if _, duplicate := result[object.GetName()]; duplicate {
			return nil, fmt.Errorf("ambiguous %s %q in owned fixture list", kind, object.GetName())
		}
		result[object.GetName()] = object
	}
	return result, nil
}

func planFixtureOwnerPatches(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	objects fixtureObjects,
) ([]ownerPatch, error) {
	stagePatches, err := planApplicationChildOwnerPatches(
		ctx, client, ownership, objects.applications, objects.stages, stageGVR, "Stage",
	)
	if err != nil {
		return nil, err
	}
	releasePatches, err := planApplicationChildOwnerPatches(
		ctx, client, ownership, objects.applications, objects.releases, releaseGVR, "Release",
	)
	if err != nil {
		return nil, err
	}
	rolloutPatches, err := planRolloutOwnerPatches(ctx, client, ownership, objects)
	if err != nil {
		return nil, err
	}
	patches := make([]ownerPatch, 0, len(stagePatches)+len(releasePatches)+len(rolloutPatches))
	patches = append(patches, stagePatches...)
	patches = append(patches, releasePatches...)
	patches = append(patches, rolloutPatches...)
	return patches, nil
}

func planApplicationChildOwnerPatches(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	applications map[string]*unstructured.Unstructured,
	children map[string]*unstructured.Unstructured,
	childGVR schema.GroupVersionResource,
	childKind string,
) ([]ownerPatch, error) {
	patches := make([]ownerPatch, 0, len(children))
	for _, name := range sortedFixtureNames(children) {
		child := children[name]
		application, err := resolveFixtureParent(
			ctx,
			client,
			ownership,
			applications,
			applicationGVR,
			"Application",
			child.GetLabels()[applicationNameLabelKey],
		)
		if err != nil {
			return nil, fmt.Errorf("link %s %q: %w", childKind, name, err)
		}
		patch, needed, err := planOwnerPatch(
			child,
			childGVR,
			controllerOwner(application, "pipelines.paprika.io/v1alpha1", "Application"),
		)
		if err != nil {
			return nil, fmt.Errorf("link %s %q: %w", childKind, name, err)
		}
		if needed {
			patches = append(patches, patch)
		}
	}
	return patches, nil
}

func planRolloutOwnerPatches(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	objects fixtureObjects,
) ([]ownerPatch, error) {
	patches := make([]ownerPatch, 0, len(objects.rollouts))
	for _, name := range sortedFixtureNames(objects.rollouts) {
		rollout := objects.rollouts[name]
		release, err := resolveFixtureParent(
			ctx,
			client,
			ownership,
			objects.releases,
			releaseGVR,
			"Release",
			rollout.GetLabels()[releaseNameLabelKey],
		)
		if err != nil {
			return nil, fmt.Errorf("link Rollout %q: %w", name, err)
		}
		if rollout.GetLabels()[applicationNameLabelKey] == "" ||
			rollout.GetLabels()[applicationNameLabelKey] != release.GetLabels()[applicationNameLabelKey] {
			return nil, fmt.Errorf("link Rollout %q: application association does not match Release %q", name, release.GetName())
		}
		patch, needed, err := planOwnerPatch(
			rollout,
			rolloutGVR,
			controllerOwner(release, "pipelines.paprika.io/v1alpha1", "Release"),
		)
		if err != nil {
			return nil, fmt.Errorf("link Rollout %q: %w", name, err)
		}
		if needed {
			patches = append(patches, patch)
		}
	}
	return patches, nil
}

func resolveFixtureParent(
	ctx context.Context,
	client dynamic.Interface,
	ownership namespaceOwnership,
	selected map[string]*unstructured.Unstructured,
	gvr schema.GroupVersionResource,
	kind, name string,
) (*unstructured.Unstructured, error) {
	if name == "" {
		return nil, fmt.Errorf("parent %s reference is empty", kind)
	}
	parent := selected[name]
	if parent == nil {
		candidate, err := client.Resource(gvr).Namespace(ownership.Namespace).Get(
			ctx,
			name,
			metav1.GetOptions{},
		)
		if apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("parent %s %q is missing", kind, name)
		}
		if err != nil {
			return nil, fmt.Errorf("get parent %s %q: %w", kind, name, err)
		}
		if !hasFixtureOwnershipLabels(candidate, ownership) {
			return nil, fmt.Errorf("parent %s %q ownership labels do not match the run", kind, name)
		}
		return nil, fmt.Errorf("parent %s %q was not returned by the exact run selector", kind, name)
	}
	if parent.GetNamespace() != ownership.Namespace {
		return nil, fmt.Errorf("parent %s %q namespace mismatch", kind, name)
	}
	if !hasFixtureOwnershipLabels(parent, ownership) {
		return nil, fmt.Errorf("parent %s %q ownership labels do not match the run", kind, name)
	}
	if parent.GetUID() == "" {
		return nil, fmt.Errorf("parent %s %q has empty UID", kind, name)
	}
	return parent, nil
}

func planOwnerPatch(
	object *unstructured.Unstructured,
	gvr schema.GroupVersionResource,
	expected *metav1.OwnerReference,
) (ownerPatch, bool, error) {
	owners := object.GetOwnerReferences()
	controllerIndex := -1
	for index := range owners {
		if owners[index].Controller == nil || !*owners[index].Controller {
			continue
		}
		if controllerIndex >= 0 || !sameControllerIdentity(&owners[index], expected) {
			return ownerPatch{}, false, errors.New("pre-existing conflicting controller owner")
		}
		controllerIndex = index
	}
	if controllerIndex >= 0 {
		if sameControllerOwner(&owners[controllerIndex], expected) {
			return ownerPatch{}, false, nil
		}
		if object.GetResourceVersion() == "" {
			return ownerPatch{}, false, errors.New("child resourceVersion is empty")
		}
		owners[controllerIndex] = *expected
		return ownerPatch{
			gvr:              gvr,
			name:             object.GetName(),
			resourceVersion:  object.GetResourceVersion(),
			ownerReferences:  owners,
			expectedOwnerRef: expected,
		}, true, nil
	}
	if object.GetResourceVersion() == "" {
		return ownerPatch{}, false, errors.New("child resourceVersion is empty")
	}
	owners = append(owners, *expected)
	return ownerPatch{
		gvr:              gvr,
		name:             object.GetName(),
		resourceVersion:  object.GetResourceVersion(),
		ownerReferences:  owners,
		expectedOwnerRef: expected,
	}, true, nil
}

func applyOwnerPatch(
	ctx context.Context,
	client dynamic.Interface,
	namespace string,
	patch *ownerPatch,
) error {
	payload, err := json.Marshal([]jsonPatchOperation{
		{Operation: "test", Path: "/metadata/resourceVersion", Value: patch.resourceVersion},
		{Operation: "add", Path: "/metadata/ownerReferences", Value: patch.ownerReferences},
	})
	if err != nil {
		return fmt.Errorf("encode owner patch for %q: %w", patch.name, err)
	}
	updated, err := client.Resource(patch.gvr).Namespace(namespace).Patch(
		ctx,
		patch.name,
		types.JSONPatchType,
		payload,
		metav1.PatchOptions{},
	)
	if err != nil {
		return fmt.Errorf("patch owner for %q with resourceVersion precondition: %w", patch.name, err)
	}
	if !hasOnlyExpectedController(updated.GetOwnerReferences(), patch.expectedOwnerRef) {
		return fmt.Errorf("patched owner for %q did not persist the exact controller", patch.name)
	}
	return nil
}

func controllerOwner(
	parent *unstructured.Unstructured,
	apiVersion, kind string,
) *metav1.OwnerReference {
	controller := true
	blockOwnerDeletion := true
	return &metav1.OwnerReference{
		APIVersion:         apiVersion,
		Kind:               kind,
		Name:               parent.GetName(),
		UID:                parent.GetUID(),
		Controller:         &controller,
		BlockOwnerDeletion: &blockOwnerDeletion,
	}
}

func hasFixtureOwnershipLabels(
	object *unstructured.Unstructured,
	ownership namespaceOwnership,
) bool {
	return object.GetLabels()[suiteLabelKey] == suiteLabelValue &&
		object.GetLabels()[runLabelKey] == ownership.RunID
}

func sameControllerIdentity(left, right *metav1.OwnerReference) bool {
	return left.APIVersion == right.APIVersion &&
		left.Kind == right.Kind &&
		left.Name == right.Name &&
		left.UID != "" &&
		left.UID == right.UID
}

func sameControllerOwner(left, right *metav1.OwnerReference) bool {
	return sameControllerIdentity(left, right) &&
		left.Controller != nil && *left.Controller &&
		right.Controller != nil && *right.Controller &&
		left.BlockOwnerDeletion != nil && *left.BlockOwnerDeletion &&
		right.BlockOwnerDeletion != nil && *right.BlockOwnerDeletion
}

func hasOnlyExpectedController(
	owners []metav1.OwnerReference,
	expected *metav1.OwnerReference,
) bool {
	controllers := 0
	matched := false
	for index := range owners {
		if owners[index].Controller == nil || !*owners[index].Controller {
			continue
		}
		controllers++
		matched = matched || sameControllerOwner(&owners[index], expected)
	}
	return controllers == 1 && matched
}

func sortedFixtureNames(objects map[string]*unstructured.Unstructured) []string {
	names := make([]string, 0, len(objects))
	for name := range objects {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
