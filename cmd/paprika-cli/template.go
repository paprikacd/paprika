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
	"errors"
	"fmt"
	"os"

	"sigs.k8s.io/yaml"
)

func readTemplateSpec(path string) (specJSON []byte, sourceType string, err error) {
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		return nil, "", fmt.Errorf("read template file: %w", readErr)
	}

	var raw map[string]interface{}
	if unmarshalErr := yaml.Unmarshal(data, &raw); unmarshalErr != nil {
		return nil, "", fmt.Errorf("parse template file: %w", unmarshalErr)
	}

	// If the file is a full Template CRD, extract .spec.
	if spec, ok := raw["spec"].(map[string]interface{}); ok {
		raw = spec
	}

	sourceType, _ = raw["type"].(string)
	if sourceType == "" {
		return nil, "", errors.New("template type is required")
	}

	specJSON, marshalErr := json.Marshal(raw)
	if marshalErr != nil {
		return nil, "", fmt.Errorf("encode template spec: %w", marshalErr)
	}
	return specJSON, sourceType, nil
}
