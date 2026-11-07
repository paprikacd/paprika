package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/go-logr/logr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/cache"
)

func newAPIMCPCache(ctx context.Context, cfg *cliConfig, clients *apiClients, log logr.Logger) (*cache.Cache, error) {
	local, err := newCacheFromConfig(ctx, cfg.cacheConfig(), log)
	if err != nil {
		return nil, fmt.Errorf("create MCP cache: %w", err)
	}
	if cfg.MCPSessionSecret == "" && cfg.MCPSessionNamespace == "" {
		return local, nil
	}
	// Session reads must bypass informer snapshots of single-use grants.
	direct, err := client.New(negotiateProtobuf(clients.restConfig), client.Options{Scheme: clients.client.Scheme()})
	if err != nil {
		return local, fmt.Errorf("create MCP session client: %w", err)
	}
	direct = namespaceScopedAPIClient(direct, cfg.APINamespace)
	persistent, err := newMCPSessionCache(ctx, cfg, direct, "/mcp", clients.authCfg.TokenSecret)
	if err != nil {
		return local, err
	}
	if err := local.Close(); err != nil {
		return local, fmt.Errorf("close temporary MCP cache: %w", err)
	}
	return persistent, nil
}

func newMCPSessionCache(ctx context.Context, cfg *cliConfig, objects client.Client, protocolPath string, secret []byte) (*cache.Cache, error) {
	if cfg.MCPSessionSecret == "" || cfg.MCPSessionNamespace == "" {
		return nil, errors.New("MCP session Secret and namespace must both be configured")
	}
	resource := strings.TrimRight(cfg.MCPPublicURL, "/") + protocolPath
	store, err := cache.NewKubernetesSecretCache(ctx, objects, cfg.MCPSessionNamespace, cfg.MCPSessionSecret, resource, secret)
	if err != nil {
		return nil, fmt.Errorf("configure persistent MCP sessions: %w", err)
	}
	return store, nil
}
