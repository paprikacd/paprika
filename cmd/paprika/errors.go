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
	"fmt"

	"connectrpc.com/connect"
)

// friendlyError translates a Connect error into an actionable CLI message.
// Connect surfaces codes like CodeUnavailable on transport failure; wrapping
// them raw prints "unavailable: ..." with no hint about what to do next.
func friendlyError(err error) error {
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		return err
	}
	if hint, ok := connectCodeHints[cerr.Code()]; ok {
		return fmt.Errorf("%s: %s", hint, cerr.Message())
	}
	return fmt.Errorf("%s: %s", cerr.Code().String(), cerr.Message())
}

var connectCodeHints = map[connect.Code]string{
	connect.CodeUnauthenticated:    "authentication failed — run 'paprika login' or check your configured credentials",
	connect.CodePermissionDenied:   "permission denied",
	connect.CodeNotFound:           "not found",
	connect.CodeFailedPrecondition: "precondition failed",
	connect.CodeInvalidArgument:    "invalid arguments",
	connect.CodeUnimplemented:      "the server does not support this operation — upgrade the server or the CLI",
	connect.CodeUnavailable:        "server unavailable — check the server URL and that the API is reachable",
	connect.CodeDeadlineExceeded:   "request timed out",
	connect.CodeResourceExhausted:  "rate limited",
}
