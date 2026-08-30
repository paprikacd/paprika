// Package main is the entry point for the paprika binary.
//
// negotiateProtobuf is shared across all binary modes (operator, API server,
// Cloud Run). Defined once here rather than in each mode's main file to avoid
// duplicate-declaration errors at build time.
package main

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
)

// negotiateProtobuf configures the client-go rest.Config to ACCEPT protobuf
// responses for built-in K8s kinds while always SENDING JSON. Sending
// protobuf breaks controller-runtime typed writes for CRD groups (their Go
// types do not implement the protobuf marshaller), so requests stay JSON;
// responses may still be protobuf because built-in decoded types support it.
func negotiateProtobuf(cfg *rest.Config) {
	cfg.AcceptContentTypes = runtime.ContentTypeProtobuf + "," + runtime.ContentTypeJSON
	cfg.ContentType = runtime.ContentTypeJSON
}
