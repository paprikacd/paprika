package insights

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// checksContractGolden is the wire contract the UI reads. The Go side writes it
// from the real handlers; ui/src/features/insights/checks-contract.test.ts reads
// it. Regenerate with UPDATE_CHECKS_GOLDEN=1 go test ./internal/insights -run CheckWireGolden.
var checksContractGolden = filepath.Join("..", "..", "ui", "src", "features", "insights", "testdata", "checks-contract.golden.json")

func TestCheckWireGolden(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := documentWithWidgets("demo",
		widgetJSON("requests", `{"x":0,"y":0,"w":0,"h":4}`, ""),
		widgetJSON("latency", "", `"options":{"thresholds":[{"value":10,"color":"#111111"},{"value":20,"color":"red"}]}`),
	)
	save := request(t, h, "PUT", "/api/dashboards/demo", document, map[string]string{"If-None-Match": "*"})
	if save.Code != 400 {
		t.Fatalf("save status = %d, body %s", save.Code, save.Body)
	}
	dryRun := request(t, h, "POST", "/api/dashboards/validate", checkBody(document), nil)
	if dryRun.Code != 200 {
		t.Fatalf("dry run status = %d, body %s", dryRun.Code, dryRun.Body)
	}
	// A lint finding: the layout overlaps, so the dry run reports the error the save rejects on.
	overlap := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
	)
	lintDryRun := request(t, h, "POST", "/api/dashboards/validate", checkBody(overlap), nil)
	if lintDryRun.Code != http.StatusOK {
		t.Fatalf("lint dry run status = %d, body %s", lintDryRun.Code, lintDryRun.Body)
	}
	// A successful save that asks for its checks: the document plus the warnings.
	warning := documentWithWidgets("warn", widgetJSON("a", `{"x":0,"y":0,"w":4,"h":2}`, `"type":"stat","options":{"showStatBar":true,"min":0,"max":100,"showSparkline":true}`))
	checkedSave := request(t, h, "PUT", "/api/dashboards/warn?checks=true", warning, map[string]string{"If-None-Match": "*"})
	if checkedSave.Code != http.StatusOK {
		t.Fatalf("checked save status = %d, body %s", checkedSave.Code, checkedSave.Body)
	}
	var contract bytes.Buffer
	contract.WriteString(`{"save":`)
	contract.Write(bytes.TrimSpace(save.Body.Bytes()))
	contract.WriteString(`,"dryRun":`)
	contract.Write(bytes.TrimSpace(dryRun.Body.Bytes()))
	contract.WriteString(`,"lintDryRun":`)
	contract.Write(bytes.TrimSpace(lintDryRun.Body.Bytes()))
	contract.WriteString(`,"checkedSave":`)
	contract.Write(bytes.TrimSpace(checkedSave.Body.Bytes()))
	contract.WriteString("}")
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, contract.Bytes(), "", "  "); err != nil {
		t.Fatal(err)
	}
	pretty.WriteByte('\n')

	if os.Getenv("UPDATE_CHECKS_GOLDEN") == "1" {
		if err := os.WriteFile(checksContractGolden, pretty.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	golden, err := os.ReadFile(checksContractGolden) //nolint:gosec // The fixed test fixture path, never request input.
	if err != nil {
		t.Fatalf("read golden (set UPDATE_CHECKS_GOLDEN=1 to write it): %v", err)
	}
	if !bytes.Equal(golden, pretty.Bytes()) {
		t.Fatalf("wire contract changed; regenerate %s with UPDATE_CHECKS_GOLDEN=1\n%s", checksContractGolden, pretty.String())
	}
}
