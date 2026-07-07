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

// negotiateProtobuf configures the client-go rest.Config to prefer protobuf
// over JSON for built-in K8s kinds. CRDs and Watch payloads without protobuf
// schemas fall back to JSON automatically because AcceptContentTypes lists
// both content types.
func negotiateProtobuf(cfg *rest.Config) {
	cfg.ContentConfig.ContentType = runtime.ContentTypeProtobuf
	cfg.ContentConfig.AcceptContentTypes = runtime.ContentTypeProtobuf + "," + runtime.ContentTypeJSON
}
