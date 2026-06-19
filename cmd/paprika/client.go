/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func newClient(cfg *Config) (v1connect.PaprikaServiceClient, error) {
	if cfg.Server == "" {
		return nil, errors.New("server URL is not configured; run 'paprika config init' or use --server")
	}

	interceptors := []connect.Interceptor{}
	if cfg.Username != "" && cfg.Password != "" {
		interceptors = append(interceptors, basicAuthInterceptor(cfg.Username, cfg.Password))
	} else if cfg.Token != "" {
		interceptors = append(interceptors, bearerAuthInterceptor(cfg.Token))
	}

	return v1connect.NewPaprikaServiceClient(
		http.DefaultClient,
		cfg.Server,
		connect.WithInterceptors(interceptors...),
	), nil
}

func basicAuthInterceptor(username, password string) connect.UnaryInterceptorFunc {
	creds := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
	header := "Basic " + creds

	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Authorization", header)
			return next(ctx, req)
		}
	}
}

func bearerAuthInterceptor(token string) connect.UnaryInterceptorFunc {
	header := "Bearer " + token
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Authorization", header)
			return next(ctx, req)
		}
	}
}
