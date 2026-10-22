package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/api/mcp"
)

func newMCPClientRegistry(ctx context.Context, cfg *cliConfig, objects client.Client, protocolPath string) (mcp.DynamicClientRegistry, error) {
	if cfg.MCPClientRegistryConfigMap == "" && cfg.MCPClientRegistryNamespace == "" {
		return nil, nil
	}
	if cfg.MCPClientRegistryConfigMap == "" || cfg.MCPClientRegistryNamespace == "" {
		return nil, errors.New("MCP client registry ConfigMap and namespace must both be configured")
	}
	registry, err := mcp.NewKubernetesClientRegistry(ctx, objects, cfg.MCPClientRegistryNamespace, cfg.MCPClientRegistryConfigMap, strings.TrimRight(cfg.MCPPublicURL, "/")+protocolPath)
	if err != nil {
		return nil, fmt.Errorf("configure persistent MCP client registry: %w", err)
	}
	return registry, nil
}
