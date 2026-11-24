package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// pluginConfigSchemaURL names the published bundle inside the compiler. It is not fetched.
const pluginConfigSchemaURL = "https://paprika.invalid/widget-plugin-configs.schema.json"

// pluginConfigSchemas compiles every built-in plugin's published configuration schema once. It returns an error
// only when the embedded bundle is malformed, which a test guards.
var pluginConfigSchemas = sync.OnceValues(compilePluginConfigSchemas)

func compilePluginConfigSchemas() (map[string]*jsonschema.Schema, error) {
	bundle := insightsschema.PluginConfigSchemas()
	var raw any
	if err := json.Unmarshal(bundle, &raw); err != nil {
		return nil, fmt.Errorf("decode plugin configuration bundle: %w", err)
	}
	var ids struct {
		Defs map[string]json.RawMessage `json:"$defs"`
	}
	if err := json.Unmarshal(bundle, &ids); err != nil {
		return nil, fmt.Errorf("read plugin configuration ids: %w", err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(pluginConfigSchemaURL, raw); err != nil {
		return nil, fmt.Errorf("add plugin configuration bundle: %w", err)
	}
	schemas := make(map[string]*jsonschema.Schema, len(ids.Defs))
	for id := range ids.Defs {
		schema, err := compiler.Compile(pluginConfigSchemaURL + "#/$defs/" + id)
		if err != nil {
			return nil, fmt.Errorf("compile plugin %q configuration schema: %w", id, err)
		}
		schemas[id] = schema
	}
	return schemas, nil
}

// maxPluginConfigMessageRunes bounds the message a refused plugin configuration reports.
const maxPluginConfigMessageRunes = 200

// pluginConfigProblem checks a plugin widget's configuration against the published schema of its plugin. It returns
// the JSON Pointer of the first problem, relative to the configuration, and a message. The first problem is the one
// with the smallest pointer, then the smallest message, so the same configuration always names the same member.
// refused is false for a plugin the bundle does not describe, so a host plugin is never refused here, and for a
// configuration the schema accepts. An empty or null configuration is checked as {}.
func pluginConfigProblem(id string, config json.RawMessage) (pointer, message string, refused bool) {
	schemas, err := pluginConfigSchemas()
	if err != nil {
		return "", "", false
	}
	schema := schemas[id]
	if schema == nil {
		return "", "", false
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(configOrEmpty(config)))
	if err != nil {
		return "", truncateRunes(fmt.Sprintf("plugin %q config is invalid: %s", id, err), maxPluginConfigMessageRunes), true
	}
	err = schema.Validate(value)
	if err == nil {
		return "", "", false
	}
	var validation *jsonschema.ValidationError
	if !errors.As(err, &validation) {
		return "", truncateRunes(fmt.Sprintf("plugin %q config is invalid", id), maxPluginConfigMessageRunes), true
	}
	leaves := leafOutputUnits(validation.BasicOutput())
	if len(leaves) == 0 {
		return "", truncateRunes(fmt.Sprintf("plugin %q config is invalid", id), maxPluginConfigMessageRunes), true
	}
	sort.SliceStable(leaves, func(i, j int) bool {
		if leaves[i].InstanceLocation != leaves[j].InstanceLocation {
			return leaves[i].InstanceLocation < leaves[j].InstanceLocation
		}
		return leaves[i].Error.String() < leaves[j].Error.String()
	})
	first := leaves[0]
	return first.InstanceLocation, truncateRunes(fmt.Sprintf("plugin %q config is invalid: %s", id, first.Error.String()), maxPluginConfigMessageRunes), true
}

// leafOutputUnits returns the failing leaves of a basic output, each with its own pointer and message.
func leafOutputUnits(unit *jsonschema.OutputUnit) []jsonschema.OutputUnit {
	if len(unit.Errors) == 0 {
		if unit.Error != nil {
			return []jsonschema.OutputUnit{*unit}
		}
		return nil
	}
	var leaves []jsonschema.OutputUnit
	for i := range unit.Errors {
		leaves = append(leaves, leafOutputUnits(&unit.Errors[i])...)
	}
	return leaves
}

// configOrEmpty returns the configuration bytes, or {} when there are none or the configuration is null.
func configOrEmpty(config json.RawMessage) []byte {
	if len(config) == 0 || string(bytes.TrimSpace(config)) == "null" {
		return []byte("{}")
	}
	return config
}
