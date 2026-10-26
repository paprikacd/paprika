package insights

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDashboardDrilldownRoundTrip(t *testing.T) {
	s, _ := testService(t)
	document := extendedDashboard(`"type":"heatmap","drilldowns":[{"id":"details","title":"Inspect service","dashboardId":"service-details","carryTimeRange":true,"bindings":[{"variable":"service","source":"label","value":"service"},{"variable":"reading","source":"value"},{"variable":"series","source":"series"},{"variable":"environment","source":"constant","value":"production"}]}]`, `"variables":[{"name":"service","label":"Service","defaultValue":"api","options":["api","worker","","quoted\"\\\n{{service}}"]},{"name":"optional"}]`)
	saved := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
	if saved.Code != 200 {
		t.Fatalf("valid drilldowns rejected: %d %s", saved.Code, saved.Body)
	}
	loaded := request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
	var expected, actual any
	if err := json.Unmarshal(document, &expected); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(loaded.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expected, actual) {
		t.Fatalf("drilldown contract changed on round trip: %s", loaded.Body)
	}
}

func TestDashboardVariableOptions(t *testing.T) {
	for name, options := range map[string]string{
		"null":            `null`,
		"object":          `{}`,
		"string":          `"api"`,
		"empty array":     `[]`,
		"null option":     `[null]`,
		"numeric option":  `[1]`,
		"boolean option":  `[true]`,
		"object option":   `[{}]`,
		"array option":    `[["api"]]`,
		"duplicate":       `["api","api"]`,
		"duplicate empty": `["",""]`,
		"long Unicode":    `["` + strings.Repeat("😀", 513) + `"]`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboardVariables([]byte(`[{"name":"service","options":` + options + `}]`)); err == nil {
				t.Fatal("invalid dropdown options accepted")
			}
		})
	}
	options := make([]string, 101)
	for index := range options {
		options[index] = fmt.Sprintf("service-%d", index)
	}
	for _, count := range []int{100, 101} {
		raw, _ := json.Marshal([]map[string]any{{"name": "service", "options": options[:count]}})
		err := validateDashboardVariables(raw)
		if (err == nil) != (count == 100) {
			t.Fatalf("incorrect bound for %d options: %v", count, err)
		}
	}
	valid := []map[string]any{{"name": "service", "defaultValue": "outside-list", "options": []string{"", strings.Repeat("😀", 512), "api"}}}
	raw, _ := json.Marshal(valid)
	if err := validateDashboardVariables(raw); err != nil {
		t.Fatalf("valid empty and Unicode choices or outside default rejected: %v", err)
	}
}

func TestDashboardVariableValidation(t *testing.T) {
	for name, variables := range map[string]string{
		"object":          `{}`,
		"null":            `null`,
		"missing name":    `[{}]`,
		"duplicate name":  `[{"name":"service"},{"name":"service"}]`,
		"bad identifier":  `[{"name":"1service"}]`,
		"long identifier": `[{"name":"` + strings.Repeat("v", 65) + `"}]`,
		"prototype":       `[{"name":"__proto__"}]`,
		"constructor":     `[{"name":"constructor"}]`,
		"null label":      `[{"name":"service","label":null}]`,
		"unknown field":   `[{"name":"service","script":"bad"}]`,
		"numeric default": `[{"name":"service","defaultValue":1}]`,
		"long label":      `[{"name":"service","label":"` + strings.Repeat("a", 81) + `"}]`,
		"long default":    `[{"name":"service","defaultValue":"` + strings.Repeat("😀", 513) + `"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard("", `"variables":`+variables)); err == nil {
				t.Fatal("invalid variable definition accepted")
			}
		})
	}
	variables := make([]map[string]string, 21)
	for index := range variables {
		variables[index] = map[string]string{"name": fmt.Sprintf("v%d", index)}
	}
	tooMany, _ := json.Marshal(variables)
	if err := validateDashboard("demo", extendedDashboard("", `"variables":`+string(tooMany))); err == nil {
		t.Fatal("21 variables accepted")
	}
	if err := validateDashboard("demo", extendedDashboard("", `"variables":[{"name":"service","defaultValue":"`+strings.Repeat("😀", 512)+`"}]`)); err != nil {
		t.Fatalf("valid 1024 UTF-16 units rejected: %v", err)
	}
}

func TestDashboardDrilldownValidation(t *testing.T) {
	const valid = `{"id":"details","title":"Details","dashboardId":"service-details"}`
	for name, links := range map[string]string{
		"object":             `{}`,
		"null":               `null`,
		"missing title":      `[{"id":"details","dashboardId":"service-details"}]`,
		"external target":    `[{"id":"details","title":"Details","dashboardId":"https://example.com"}]`,
		"path target":        `[{"id":"details","title":"Details","dashboardId":"../service"}]`,
		"duplicate link":     `[` + valid + `,` + valid + `]`,
		"carry type":         `[{"id":"details","title":"Details","dashboardId":"service-details","carryTimeRange":"true"}]`,
		"bindings null":      `[{"id":"details","title":"Details","dashboardId":"service-details","bindings":null}]`,
		"external url field": `[{"id":"details","title":"Details","dashboardId":"service-details","url":"https://example.com"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(`"type":"heatmap","drilldowns":`+links, "")); err == nil {
				t.Fatal("invalid drilldown accepted")
			}
		})
	}
	links := make([]map[string]string, 9)
	for index := range links {
		links[index] = map[string]string{"id": fmt.Sprintf("d%d", index), "title": "Details", "dashboardId": "service-details"}
	}
	tooMany, _ := json.Marshal(links)
	if err := validateDrilldowns(tooMany); err == nil {
		t.Fatal("9 drilldowns accepted")
	}
	if err := validateDrilldowns([]byte(`[]`)); err != nil {
		t.Fatalf("empty links rejected: %v", err)
	}
}

func TestDashboardDrilldownBindingValidation(t *testing.T) {
	for name, bindings := range map[string]string{
		"missing label key":     `[{"variable":"service","source":"label"}]`,
		"empty label key":       `[{"variable":"service","source":"label","value":""}]`,
		"long label key":        `[{"variable":"service","source":"label","value":"` + strings.Repeat("a", 129) + `"}]`,
		"missing constant":      `[{"variable":"service","source":"constant"}]`,
		"numeric constant":      `[{"variable":"service","source":"constant","value":1}]`,
		"value takes no value":  `[{"variable":"service","source":"value","value":"bad"}]`,
		"series takes no value": `[{"variable":"service","source":"series","value":"bad"}]`,
		"invalid source":        `[{"variable":"service","source":"url","value":"http://example.com"}]`,
		"duplicate target":      `[{"variable":"service","source":"value"},{"variable":"service","source":"series"}]`,
		"reserved target":       `[{"variable":"__proto__","source":"value"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDrilldownBindings([]byte(bindings)); err == nil {
				t.Fatal("invalid binding accepted")
			}
		})
	}
	if err := validateDrilldownBindings([]byte(`[{"variable":"service","source":"constant","value":""}]`)); err != nil {
		t.Fatalf("empty constant rejected: %v", err)
	}
}
