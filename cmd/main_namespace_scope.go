package main

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func validateAPINamespace(namespace string) error {
	if namespace != "" && len(validation.IsDNS1123Label(namespace)) != 0 {
		return errors.New("--api-namespace must be one valid Kubernetes namespace")
	}
	return nil
}

func apiCacheNamespaceOptions(namespace string) map[string]crcache.Config {
	if namespace == "" {
		return nil
	}
	return map[string]crcache.Config{namespace: {}}
}

// This supplements Kubernetes RBAC; it cannot replace a namespace-restricted
// service account. Typed Kubernetes clients and cluster-scoped reads still
// depend on that identity's actual permissions.
func namespaceScopedAPIClient(c client.Client, namespace string) client.Client {
	if namespace == "" {
		return c
	}
	return &namespaceListClient{Client: client.NewNamespacedClient(c, namespace), namespace: namespace}
}

type namespaceListClient struct {
	client.Client
	namespace string
}

func (c *namespaceListClient) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	options := &client.ListOptions{}
	options.ApplyOptions(opts)
	if options.Namespace != "" && options.Namespace != c.namespace {
		return apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("requested namespace is outside this API instance"))
	}
	if err := c.Client.List(ctx, list, opts...); err != nil {
		return fmt.Errorf("list namespace-scoped resources: %w", err)
	}
	return nil
}

func (c *namespaceListClient) DeleteAllOf(ctx context.Context, object client.Object, opts ...client.DeleteAllOfOption) error {
	options := &client.DeleteAllOfOptions{}
	options.ApplyOptions(opts)
	if options.Namespace != "" && options.Namespace != c.namespace {
		return apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("requested namespace is outside this API instance"))
	}
	if err := c.Client.DeleteAllOf(ctx, object, opts...); err != nil {
		return fmt.Errorf("delete namespace-scoped resources: %w", err)
	}
	return nil
}
