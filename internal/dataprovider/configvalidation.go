package dataprovider

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// validateNoConfig returns an error unless config is empty or absent,
// naming providerName in the message. It is shared by CapacitySource
// implementations that need no configuration at all, so a typo'd or stale
// config is rejected rather than silently ignored.
//
// The error names only the unexpected key(s), never their values: this
// error can surface through an admission rejection and reach API server
// logs, and a provider's config could carry a credential.
func validateNoConfig(providerName string, config json.RawMessage) error {
	trimmed := strings.TrimSpace(string(config))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var asObject map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &asObject); err != nil {
		return fmt.Errorf("%s accepts no configuration", providerName)
	}
	if len(asObject) == 0 {
		return nil
	}

	keys := make([]string, 0, len(asObject))
	for key := range asObject {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	return fmt.Errorf("%s accepts no configuration, but found key(s): %s", providerName, strings.Join(keys, ", "))
}
