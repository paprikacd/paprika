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
	"encoding/json"
	"fmt"
	"io"
	"os"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"sigs.k8s.io/yaml"
)

const (
	outputJSON  = "json"
	outputYAML  = "yaml"
	outputTable = "table"
)

func writeProtoOutput(w io.Writer, output string, msg proto.Message) error {
	switch output {
	case outputJSON:
		data, err := protojson.MarshalOptions{Multiline: true}.Marshal(msg)
		if err != nil {
			return fmt.Errorf("marshal json: %w", err)
		}
		if _, err := w.Write(data); err != nil {
			return fmt.Errorf("write output: %w", err)
		}
		return nil
	case outputYAML:
		data, err := protojson.Marshal(msg)
		if err != nil {
			return fmt.Errorf("marshal proto json: %w", err)
		}
		var raw interface{}
		if unmarshalErr := json.Unmarshal(data, &raw); unmarshalErr != nil {
			return fmt.Errorf("unmarshal proto json: %w", unmarshalErr)
		}
		out, err := yaml.Marshal(raw)
		if err != nil {
			return fmt.Errorf("marshal yaml: %w", err)
		}
		if _, err := w.Write(out); err != nil {
			return fmt.Errorf("write output: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unknown output format %q", output)
	}
}

func printErrorf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "Error: "+format+"\n", args...)
}

func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
