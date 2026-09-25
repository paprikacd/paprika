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
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
)

func TestParseResourceSelector(t *testing.T) {
	tests := []struct {
		in        string
		wantGroup string
		wantKind  string
		wantNS    string
		wantName  string
		wantErr   bool
	}{
		{in: "deployment/web", wantKind: "deployment", wantName: "web"},
		{in: "apps:Deployment:web", wantGroup: "apps", wantKind: "Deployment", wantName: "web"},
		{in: "apps:Deployment:prod:web", wantGroup: "apps", wantKind: "Deployment", wantNS: "prod", wantName: "web"},
		{in: ":Deployment:web", wantGroup: "", wantKind: "Deployment", wantName: "web"},
		{in: "", wantErr: true},
		{in: "justname", wantErr: true},
		{in: "a:b", wantErr: true},
		{in: "a:b:c:d:e", wantErr: true},
		{in: "/web", wantErr: true},
		{in: "deployment/", wantErr: true},
	}
	for _, tc := range tests {
		sel, err := parseResourceSelector(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%q: expected error, got %+v", tc.in, sel)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", tc.in, err)
			continue
		}
		if sel.Group != tc.wantGroup || sel.Kind != tc.wantKind ||
			sel.Namespace != tc.wantNS || sel.Name != tc.wantName {
			t.Errorf("%q: got %+v", tc.in, sel)
		}
	}
}

func TestParseResourceSelectors_DefaultNamespace(t *testing.T) {
	sels, err := parseResourceSelectors([]string{"deployment/web", "apps:Deployment:prod:api"}, "fallback")
	if err != nil {
		t.Fatal(err)
	}
	if sels[0].Namespace != "fallback" {
		t.Errorf("default ns not applied: %q", sels[0].Namespace)
	}
	if sels[1].Namespace != "prod" {
		t.Errorf("selector-carried ns overwritten: %q", sels[1].Namespace)
	}
}

func TestRestartableKinds(t *testing.T) {
	for _, in := range []string{"deployment", "deploy", "Deployment", "sts", "StatefulSet", "ds", "DaemonSet"} {
		if _, ok := restartableKinds[strings.ToLower(in)]; !ok {
			t.Errorf("%q should be restartable", in)
		}
	}
	for _, in := range []string{"configmap", "service", "pod", "secret"} {
		if _, ok := restartableKinds[strings.ToLower(in)]; ok {
			t.Errorf("%q should NOT be restartable", in)
		}
	}
}

func TestFriendlyError(t *testing.T) {
	cases := []struct {
		code    connect.Code
		wantSub string
	}{
		{connect.CodeUnauthenticated, "paprika login"},
		{connect.CodePermissionDenied, "permission denied"},
		{connect.CodeNotFound, "not found"},
		{connect.CodeUnavailable, "server unavailable"},
		{connect.CodeUnimplemented, "does not support"},
		{connect.CodeInvalidArgument, "invalid arguments"},
		{connect.CodeResourceExhausted, "rate limited"},
	}
	for _, tc := range cases {
		err := friendlyError(connect.NewError(tc.code, errors.New("upstream detail")))
		if !strings.Contains(err.Error(), tc.wantSub) {
			t.Errorf("code %s: got %q, want substring %q", tc.code, err, tc.wantSub)
		}
	}
	// Non-connect errors pass through untouched.
	plain := errors.New("plain")
	if !errors.Is(friendlyError(plain), plain) {
		t.Error("non-connect error should pass through unchanged")
	}
}
