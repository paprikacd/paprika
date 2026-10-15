package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/version"
)

// ConnectionInfo describes this authenticated request's instance. It is
// constructed from server configuration and validated credentials, never
// Host/X-Forwarded-* headers, tool arguments, or a saved UI preference. A
// hostname and account label are display information, not a routing API.
type ConnectionInfo struct {
	Endpoint string            `json:"endpoint"`
	Origin   string            `json:"origin"`
	Name     string            `json:"name"`
	Account  ConnectionAccount `json:"account"`
	Scopes   []string          `json:"scopes"`
	Server   ConnectionBuild   `json:"server"`
}

type ConnectionAccount struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
}

type ConnectionBuild struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Date    string `json:"date"`
}

type connectionInfoKey struct{}

func (s *Server) connectionInfo(p *auth.Principal) (ConnectionInfo, error) {
	u, err := url.Parse(s.publicURL)
	if err != nil {
		return ConnectionInfo{}, errors.New("mcp: instance public URL is invalid")
	}
	info := ConnectionInfo{
		Endpoint: strings.TrimRight(s.publicURL, "/") + s.protocolPath,
		Origin:   u.Scheme + "://" + u.Host,
		Name:     u.Host,
		Scopes:   []string{},
		Server:   ConnectionBuild{Version: version.Version, Commit: version.Commit, Date: version.Date},
	}
	if p != nil {
		info.Account = ConnectionAccount{Name: p.Name, Email: p.Email}
		for _, scope := range s.supportedScopes {
			if principalHasScope(p, scope) {
				info.Scopes = append(info.Scopes, string(scope))
			}
		}
	}
	return info, nil
}

func connectionFromContext(ctx context.Context) (ConnectionInfo, bool) {
	info, ok := ctx.Value(connectionInfoKey{}).(ConnectionInfo)
	return info, ok
}

func readGetConnectionTool() Tool {
	return Tool{
		Name: "get_connection", Title: "Current Paprika instance",
		Description:  "Identify the authenticated Paprika instance, account display metadata, granted scopes, and server build. Use the endpoint to verify the target before acting on an application. Does not list or switch other connections.",
		Scope:        ScopeRead,
		InputSchema:  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		OutputSchema: json.RawMessage(`{"type":"object","properties":{"endpoint":{"type":"string"},"origin":{"type":"string"},"name":{"type":"string"},"account":{"type":"object","properties":{"name":{"type":"string"},"email":{"type":"string"}},"additionalProperties":false},"scopes":{"type":"array","items":{"type":"string"}},"server":{"type":"object","properties":{"version":{"type":"string"},"commit":{"type":"string"},"date":{"type":"string"}},"required":["version","commit","date"],"additionalProperties":false}},"required":["endpoint","origin","name","account","scopes","server"],"additionalProperties":false}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil || len(in) != 0 {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("get_connection accepts empty arguments only"))
			}
			info, ok := connectionFromContext(ctx)
			if !ok {
				return nil, errors.New("get_connection: authenticated server identity unavailable")
			}
			return info, nil
		},
	}
}
