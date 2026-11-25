package insights

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// schemaPluginKindNote opens the plugin kind's notes: which configuration goes with which plugin.
const schemaPluginKindNote = "Built-in plugin configuration: a widget with type=plugin sets pluginId, and its config must pass the schema for that plugin. Keys not listed below are refused. The dataKind of each plugin is in parentheses."

// schemaPluginSignatureNote explains the signature notation that follows.
const schemaPluginSignatureNote = "Signature: {key:type} lists keys and a ? marks an optional key; a|b lists allowed values; min..max bounds a number; T[min..max] is an array of T with that many items; nested objects repeat the same form. The full JSON Schema for each plugin is at $defs/<pluginId> in schema."

// schemaPluginPointerNote points the dashboard and widget kinds at the plugin configuration contract.
const schemaPluginPointerNote = "Plugin configuration: get_insights_schema with kind=plugin gives each built-in plugin's config keys, types and bounds. A save checks a plugin config against them and names the member it refuses."

// pluginSchemaNotes returns the notes of the plugin kind: two fixed lines, then one signature per built-in plugin with
// a configuration schema, in plugin id order. slo-summary is not listed; its rules are in the dashboard schema.
func pluginSchemaNotes() []string {
	var bundle struct {
		Defs map[string]map[string]any `json:"$defs"`
	}
	if err := json.Unmarshal(insightsschema.PluginConfigSchemas(), &bundle); err != nil {
		return nil
	}
	ids := make([]string, 0, len(bundle.Defs))
	for id := range bundle.Defs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	notes := []string{schemaPluginKindNote, schemaPluginSignatureNote}
	for _, id := range ids {
		node := bundle.Defs[id]
		dataKind := stringField(node, "x-dataKind")
		notes = append(notes, fmt.Sprintf("%s (%s) config %s", id, dataKind, pluginConfigSignature(node)))
	}
	return notes
}

// pluginConfigSignature renders one plugin's configuration schema as a compact signature. Keys are sorted, so the text
// is stable. A key is optional unless the schema requires it.
func pluginConfigSignature(node map[string]any) string {
	if enum, ok := node["enum"].([]any); ok {
		values := make([]string, 0, len(enum))
		for _, value := range enum {
			values = append(values, scalarText(value))
		}
		return strings.Join(values, "|")
	}
	switch typeName := stringField(node, "type"); typeName {
	case "object":
		return objectSignature(node)
	case "array":
		return arraySignature(node)
	case "number", "integer":
		if node["minimum"] != nil && node["maximum"] != nil {
			return boundText(node["minimum"], node["maximum"])
		}
		return typeName
	case "":
		return "any"
	default:
		return typeName
	}
}

// objectSignature renders an object's keys in sorted order, each marked ? when it is optional.
func objectSignature(node map[string]any) string {
	properties := objectField(node, "properties")
	if len(properties) == 0 {
		return "object"
	}
	required := requiredKeys(node["required"])
	keys := make([]string, 0, len(properties))
	for key := range properties {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	members := make([]string, 0, len(keys))
	for _, key := range keys {
		marker := "?"
		if required[key] {
			marker = ""
		}
		members = append(members, key+marker+":"+pluginConfigSignature(objectField(properties, key)))
	}
	return "{" + strings.Join(members, ",") + "}"
}

// arraySignature renders the item type with the item-count range. JSON Schema's default lower bound is 0, so a maximum
// alone still reads as a range.
func arraySignature(node map[string]any) string {
	items := objectField(node, "items")
	minimum := node["minItems"]
	if minimum == nil && node["maxItems"] != nil {
		minimum = float64(0)
	}
	return pluginConfigSignature(items) + "[" + boundText(minimum, node["maxItems"]) + "]"
}

// boundText renders a closed range as min..max, with an empty side when a bound is absent.
func boundText(minimum, maximum any) string {
	if minimum == nil && maximum == nil {
		return ""
	}
	return scalarText(minimum) + ".." + scalarText(maximum)
}

// stringField returns a string member, or empty when it is absent or not a string.
func stringField(node map[string]any, key string) string {
	value, ok := node[key].(string)
	if !ok {
		return ""
	}
	return value
}

// objectField returns an object member, or nil when it is absent or not an object.
func objectField(node map[string]any, key string) map[string]any {
	value, ok := node[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}

func requiredKeys(value any) map[string]bool {
	required := map[string]bool{}
	list, ok := value.([]any)
	if !ok {
		return required
	}
	for _, item := range list {
		if key, ok := item.(string); ok {
			required[key] = true
		}
	}
	return required
}

// scalarText renders a JSON scalar for a signature. Missing values render as an empty string.
func scalarText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprint(typed)
	}
}
