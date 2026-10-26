package httphelp

import "encoding/json"

// LimitDiscoveryArray keeps a native discovery envelope while bounding one
// array and marking incomplete results explicitly. Callers request limit+1 from
// providers so exactly limit results do not imply truncation.
func LimitDiscoveryArray(data json.RawMessage, key string, limit int) json.RawMessage {
	var body map[string]json.RawMessage
	if json.Unmarshal(data, &body) != nil {
		return data
	}
	var values []json.RawMessage
	if json.Unmarshal(body[key], &values) != nil || len(values) <= limit {
		return data
	}
	trimmed, err := json.Marshal(values[:limit])
	if err != nil {
		return data
	}
	body[key] = trimmed
	body["truncated"] = json.RawMessage("true")
	result, err := json.Marshal(body)
	if err != nil {
		return data
	}
	return result
}
