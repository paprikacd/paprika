package apiserver

import (
	"context"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/validate/content"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// readTreeResource reads the live object a request names, if the application's
// resource tree holds it. The tree is the one GetResourceTree shows.
//
// A managed resource is a root of the tree, so it needs no owner walk. Its live
// read is best effort, as the status view always was: a failed read returns no
// object and no error. Any other resource is read, then checked against the tree
// through its owner references. A resource the tree does not hold gets the same
// CodeNotFound error whether it exists or not, so a caller cannot tell the two
// apart. The error is returned before the caller reads anything else about the
// resource.
//
// The returned object is raw: it still holds Secret values. A caller must redact it,
// alone or together with its desired object, before any response, diff or detector
// sees it. Callers copy its annotations into responses, and the last-applied
// annotation of a Secret holds its values.
//
// dyn and typed are the application's destination clients. Either is nil when
// the destination cannot be reached. A nil typed client reads no owner objects,
// so an object is in the tree only when it is managed or when an owner reference
// names a managed resource directly. A nil dyn client reads no object except
// managed roots, which then return no object.
func readTreeResource(
	ctx context.Context,
	app *pipelinesv1alpha1.Application,
	dyn dynamic.Interface,
	typed kubernetes.Interface,
	mapper meta.RESTMapper,
	kind, name, namespace string,
) (*unstructured.Unstructured, resolvedResourceMapping, error) {
	var none resolvedResourceMapping
	sc := newLogsTreeScope(app, typed)
	if err := validateTreeIdentifiers(sc, kind, name, namespace); err != nil {
		return nil, none, err
	}
	if !sc.inApplicationNamespace(namespace) {
		return nil, none, logsOutsideApplicationError(kind, namespace, name)
	}
	if sc.managed(kind, namespace, name) {
		return readManagedRoot(ctx, dyn, mapper, kind, name, namespace)
	}
	// Only a child kind can be in the tree without being managed. A kind with no
	// parent kind is never in the tree, so it gets the same answer as a missing
	// object of that kind, before any read.
	if len(childParentKinds[kind]) == 0 {
		return nil, none, logsOutsideApplicationError(kind, namespace, name)
	}
	// A kind the destination cannot resolve is not in the tree, so it gets the
	// same answer as a missing object of that kind.
	if dyn == nil {
		return nil, none, logsOutsideApplicationError(kind, namespace, name)
	}
	if _, err := resolveResourceMapping(mapper, kind); err != nil {
		return nil, none, logsOutsideApplicationError(kind, namespace, name)
	}
	obj, mapping, err := getLiveResource(ctx, dyn, mapper, kind, name, namespace)
	if err != nil {
		return nil, none, sc.resourceReadError(ctx, kind, namespace, name, err)
	}
	if err := sc.requireInTree(ctx, kind, namespace, name, obj.GetOwnerReferences()); err != nil {
		return nil, none, err
	}
	return obj, mapping, nil
}

// readManagedRoot reads a managed resource, which is a root of the tree. The read
// is best effort: without a client, or when the read fails, the result has no
// object and no error.
func readManagedRoot(
	ctx context.Context,
	dyn dynamic.Interface,
	mapper meta.RESTMapper,
	kind, name, namespace string,
) (*unstructured.Unstructured, resolvedResourceMapping, error) {
	var none resolvedResourceMapping
	if dyn == nil {
		return nil, none, nil
	}
	obj, mapping, err := getLiveResource(ctx, dyn, mapper, kind, name, namespace)
	if err != nil {
		return nil, none, nil
	}
	return obj, mapping, nil
}

// validateTreeIdentifiers checks the name and namespace of a request for the tree.
// A managed resource's name was accepted by the API server for its kind, and that
// rule is path-segment validity, not DNS-1123 subdomain validity: a ClusterRole
// named "shop:reader" is legal, so a managed name is checked against the path rule.
// Any other name must pass the DNS-1123 check, as before.
func validateTreeIdentifiers(sc *logsTreeScope, kind, name, namespace string) error {
	if sc.managed(kind, namespace, name) && name != "" && len(content.IsPathSegmentName(name)) == 0 {
		return validateLogsNamespace(namespace)
	}
	return validateLogsIdentifiers(name, namespace)
}
