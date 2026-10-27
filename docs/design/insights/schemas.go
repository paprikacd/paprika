// Package insightsschema embeds the published authoring contracts. The UI's
// schema-artifacts tests compare these exact files with the canonical Zod models.
package insightsschema

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
)

//go:embed dashboard.schema.json
var dashboardSchema []byte

//go:embed saved-query.schema.json
var savedQuerySchema []byte

var ErrUnknownKind = errors.New("schema kind must be dashboard, widget, or saved_query")

// Document returns an independent, compact schema. Widget extraction retains
// the root definitions because recursive plugin configuration refers to them.
func Document(kind string) (json.RawMessage, error) {
	var source []byte
	switch kind {
	case "dashboard":
		source = dashboardSchema
	case "saved_query":
		source = savedQuerySchema
	case "widget":
		return widgetDocument()
	default:
		return nil, ErrUnknownKind
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, source); err != nil {
		return nil, fmt.Errorf("decode embedded authoring schema: %w", err)
	}
	return json.RawMessage(compact.Bytes()), nil
}

func widgetDocument() (json.RawMessage, error) {
	var root struct {
		Dialect     json.RawMessage `json:"$schema"`
		Definitions json.RawMessage `json:"$defs"`
		Comment     json.RawMessage `json:"$comment"`
		Properties  struct {
			Widgets struct {
				Items map[string]json.RawMessage `json:"items"`
			} `json:"widgets"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(dashboardSchema, &root); err != nil {
		return nil, fmt.Errorf("decode embedded dashboard schema: %w", err)
	}
	widget := root.Properties.Widgets.Items
	if len(widget) == 0 || len(root.Dialect) == 0 {
		return nil, errors.New("embedded dashboard schema has no widget contract")
	}
	widget["$schema"] = root.Dialect
	if len(root.Definitions) > 0 {
		widget["$defs"] = root.Definitions
	}
	if len(root.Comment) > 0 {
		widget["$comment"] = root.Comment
	}
	encoded, err := json.Marshal(widget)
	if err != nil {
		return nil, fmt.Errorf("encode embedded widget schema: %w", err)
	}
	return encoded, nil
}
