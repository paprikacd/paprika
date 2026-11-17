package uptime

import (
	"encoding/json"
	"errors"
	"strings"
)

// checkJSON rejects duplicate keys and excessive nesting before typed decoding.
// The second typed decode supplies unknown-field and single-document checks.
func checkJSON(raw string) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	return checkJSONValue(decoder, 0)
}

func checkJSONValue(decoder *json.Decoder, depth int) error {
	if depth > 8 {
		return errors.New("uptime JSON nesting exceeds its limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return errors.New("uptime JSON is invalid")
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	if delimiter == '{' {
		return checkJSONObject(decoder, depth)
	}
	if delimiter != '[' {
		return errors.New("uptime JSON is invalid")
	}
	for decoder.More() {
		if err := checkJSONValue(decoder, depth+1); err != nil {
			return err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return errors.New("uptime JSON is invalid")
	}
	return nil
}

func checkJSONObject(decoder *json.Decoder, depth int) error {
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errors.New("uptime JSON is invalid")
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return errors.New("uptime JSON contains duplicate or invalid keys")
		}
		seen[key] = true
		if err := checkJSONValue(decoder, depth+1); err != nil {
			return err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return errors.New("uptime JSON is invalid")
	}
	return nil
}
