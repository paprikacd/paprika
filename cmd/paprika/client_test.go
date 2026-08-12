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
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func TestClientPrefersBearerAuthorizationOverBasic(t *testing.T) {
	authorization := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization <- r.Header.Get("Authorization")
		http.Error(w, "test response", http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)

	client, err := newClient(&Config{
		Server:   server.URL,
		Username: "basic-user",
		Password: "basic-password",
		Token:    "bearer-token",
	})
	if err != nil {
		t.Fatalf("newClient() error = %v", err)
	}
	_, _ = client.GetSystemStatus(context.Background(), connect.NewRequest(&v1.GetSystemStatusRequest{}))

	select {
	case got := <-authorization:
		if got != "Bearer bearer-token" {
			t.Errorf("Authorization = %q, want %q", got, "Bearer bearer-token")
		}
	case <-time.After(time.Second):
		t.Fatal("server did not receive API request")
	}
}

func TestClientHTTPTimeout(t *testing.T) {
	if got, want := apiHTTPClient.Timeout, 30*time.Second; got != want {
		t.Errorf("apiHTTPClient.Timeout = %s, want %s", got, want)
	}
}
