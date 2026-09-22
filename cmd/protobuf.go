// Package main is the entry point for the paprika binary.
package main

import (
	"k8s.io/client-go/rest"

	"github.com/benebsworth/paprika/internal/kube"
)

// negotiateProtobuf returns a copy of cfg that accepts protobuf responses for
// built-in kinds while still sending JSON requests.
//
// The asymmetry is required, not a compromise: custom resources have no
// generated protobuf marshallers, so a protobuf request body is rejected with
// 415. See internal/kube for the full reasoning; this wrapper exists only
// because the binary's several modes all reach for the same defaults.
func negotiateProtobuf(cfg *rest.Config) *rest.Config {
	return kube.WithProtobufResponses(cfg)
}
