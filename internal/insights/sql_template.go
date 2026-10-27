package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

var sqlPlaceholder = regexp.MustCompile(`\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}`)

// SQL bodies are fixed source text. Dynamic values belong to the envelope's
// driver-bound parameters array, never JSON-quoted substitutions into SQL.
func validateSQLTemplate(providerType, template string) error {
	if providerType != "postgresql" || !strings.Contains(template, "{{") {
		return nil
	}
	types := map[string]string{}
	for _, token := range sqlPlaceholder.FindAllString(template, -1) {
		types[token[2:len(token)-2]] = "string"
	}
	if err := validateSavedQueryTemplate(template, types); err != nil {
		return err
	}
	envelope, err := sqlEnvelopeFragments(template)
	if err != nil {
		return err
	}
	return validateBoundSQLEnvelope(envelope)
}

func validateBoundSQLEnvelope(envelope map[string]json.RawMessage) error {
	var parameters []any
	if json.Unmarshal(envelope["parameters"], &parameters) != nil || !strings.HasPrefix(strings.TrimSpace(string(envelope["parameters"])), "[") {
		return errors.New("SQL query variables require a bound parameters array")
	}
	var sql string
	if json.Unmarshal(envelope["sql"], &sql) != nil || strings.TrimSpace(sql) == "" || !strings.HasPrefix(strings.TrimSpace(string(envelope["sql"])), `"`) {
		return errors.New("SQL body cannot be supplied by a query variable; bind values in the parameters array")
	}
	return nil
}

func sqlEnvelopeFragments(template string) (map[string]json.RawMessage, error) {
	invalid := errors.New("SQL query variables require a JSON envelope with a fixed sql string and placeholders only in its bound parameters array")
	// Keep byte offsets identical so we can inspect each original field after
	// decoding a structurally valid shadow of unresolved placeholder values.
	shadow := sqlPlaceholder.ReplaceAllStringFunc(template, func(token string) string { return "null" + strings.Repeat(" ", len(token)-4) })
	decoder := json.NewDecoder(bytes.NewBufferString(shadow))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, invalid
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		if err := readSQLTemplateField(decoder, fields, template); err != nil {
			return nil, invalid
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, invalid
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return nil, invalid
	}
	return fields, nil
}

func readSQLTemplateField(decoder *json.Decoder, fields map[string]json.RawMessage, template string) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("SQL envelope has an invalid field")
	}
	key, ok := token.(string)
	if !ok || fields[key] != nil {
		return errors.New("SQL envelope fields must be unique")
	}
	before := decoder.InputOffset()
	var value json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return errors.New("SQL envelope has an invalid field value")
	}
	if key != "parameters" && strings.Contains(template[before:decoder.InputOffset()], "{{") {
		return errors.New("SQL variables belong only in the bound parameters array")
	}
	fields[key] = value
	return nil
}
