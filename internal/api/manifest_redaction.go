package apiserver

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
	k8syaml "sigs.k8s.io/yaml"

	"github.com/benebsworth/paprika/internal/engine"
)

// redactedSecretValue replaces each Secret value in a manifest or diff that a
// client receives. The keys stay, so a reader can see what the Secret holds.
const redactedSecretValue = "<redacted>"

// A data or stringData key whose value differs between the desired and the live
// Secret gets one of these markers, on the side that holds it. The two sides
// differ, so the changed line appears in a diff as a removed and an added line.
// Neither marker shows a value.
const (
	desiredDiffersValue = "<redacted: desired value differs>"
	liveDiffersValue    = "<redacted: live value differs>"
)

// lastAppliedConfigAnnotation holds the object as kubectl last applied it, values
// included, so the Secret's values are redacted there as well.
const lastAppliedConfigAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

// kappOriginalAnnotation holds the object as kapp applied it, values included. Like
// the last-applied annotation, it is replaced whole on a Secret.
const kappOriginalAnnotation = "kapp.k14s.io/original"

// secretCopyAnnotations are the annotations that hold a whole copy of a Secret.
var secretCopyAnnotations = []string{lastAppliedConfigAnnotation, kappOriginalAnnotation}

// isSecretMarker reports whether s is one of the markers that replace a value.
func isSecretMarker(s string) bool {
	return s == redactedSecretValue || s == desiredDiffersValue || s == liveDiffersValue
}

// isListKind reports whether a kind is a List: the generic List, or a typed list
// such as SecretList.
func isListKind(kind string) bool {
	return kind == "List" || strings.HasSuffix(kind, "List")
}

// isSecretOrList reports whether a kind is one whose values are redacted: a Secret,
// or a List that may hold Secrets.
func isSecretOrList(kind string) bool {
	return kind == "Secret" || isListKind(kind)
}

// isIdentityRootKey reports whether a top-level field names what an object is. The
// tree already shows these, so their text is kept even when it matches a value.
func isIdentityRootKey(key string) bool {
	return key == "apiVersion" || key == "kind"
}

// isIdentityMetaKey reports whether a metadata field names an object. Like the
// root identity fields, it is kept as written.
func isIdentityMetaKey(key string) bool {
	switch key {
	case "name", "namespace", "uid", "ownerReferences":
		return true
	}
	return false
}

// kindOf returns the kind of a decoded object, or "" when it has none.
func kindOf(obj map[string]any) string {
	kind, _ := obj["kind"].(string) //nolint:errcheck // map value type check
	return kind
}

// isListObject reports whether a decoded object is a List: an object of a kind
// ending in List, or any object whose items field is a list, as kubectl reads it.
func isListObject(obj map[string]any) bool {
	if isListKind(kindOf(obj)) {
		return true
	}
	_, ok := obj["items"].([]any)
	return ok
}

// isListNode is isListObject for a mapping node.
func isListNode(n *yaml.Node) bool {
	if isListKind(nodeKind(n)) {
		return true
	}
	items := mappingValue(n, "items")
	return items != nil && items.Kind == yaml.SequenceNode
}

// isSecretItem reports whether a List item is treated as a Secret: an item of a
// SecretList, an item with no kind, an item of kind Secret, or an item with a data or
// stringData key whatever its kind. The last rule makes Render stricter than the
// controller. The controller applies no built-in List kind and no top-level sequence, so
// for those the rule hides nothing it applies. For a custom resource whose kind ends in
// List, as for another kind with an items list, it can hide values the controller
// applies.
func isSecretItem(item map[string]any, allSecret bool) bool {
	kind := kindOf(item)
	return allSecret || kind == "" || kind == "Secret" || objectHasSecretData(item)
}

// isSecretNodeItem reports whether a List item node is treated as a Secret, by the rules
// of isSecretItem. An item whose kind is not a string is read as having no kind, as
// isSecretItem reads it.
func isSecretNodeItem(item *yaml.Node, allSecret bool) bool {
	return allSecret || !nodeHasStringKind(item) || nodeKind(item) == "Secret" || nodeHasSecretData(item)
}

// secretSetMaxForms is the most distinct forms a search set holds. A document with
// more distinct forms gets a set that matches every text, and no search is built. A
// search over that many forms can allocate far more memory than the document holds.
const secretSetMaxForms = 4096

// secretSet holds the forms of the Secret values that a document must not show.
// has reports whether a text holds one of them. The check is a single pass over
// the text, however many forms the set holds, so a long List costs no more per
// item than its own length. A set with all true matches every text.
type secretSet struct {
	repl *strings.Replacer
	all  bool
}

// secretSetMark is what each form is replaced with in a search. It is one byte,
// and no form is equal to it, so a text that holds a form always changes.
const secretSetMark = "\x00"

// formCollector gathers the distinct forms of a document's Secret values for a search
// set. A repeated form counts once. Once it holds more than secretSetMaxForms forms it
// stops collecting, and the set it builds matches every text. The forms beyond the cap
// are never stored, so a large Secret costs no more than the cap to collect.
type formCollector struct {
	seen  map[string]bool
	forms []string
	over  bool
}

// add collects a form unless it is blank, a marker, repeated, or the collector is over
// its cap.
func (c *formCollector) add(form string) {
	if c.over || form == "" || form == secretSetMark || c.seen[form] {
		return
	}
	if c.seen == nil {
		c.seen = make(map[string]bool)
	}
	c.seen[form] = true
	if len(c.seen) > secretSetMaxForms {
		c.over = true
		c.seen, c.forms = nil, nil
		return
	}
	c.forms = append(c.forms, form)
}

// set returns the search set of the collected forms.
func (c *formCollector) set() secretSet {
	if c.over {
		return secretSet{all: true}
	}
	if len(c.forms) == 0 {
		return secretSet{}
	}
	pairs := make([]string, 0, 2*len(c.forms))
	for _, form := range c.forms {
		pairs = append(pairs, form, secretSetMark)
	}
	return secretSet{repl: strings.NewReplacer(pairs...)}
}

// secretScanCap is the longest text the check scans. A longer text is taken to hold a
// value and is replaced without a scan, so the scan's cost is bounded by the size of
// the document. The cap applies only when the set holds a form to search for. Every
// form is at most secretFormMaxLen (32) bytes, so a scan costs at most 32 steps per
// byte of text.
const secretScanCap = 16 << 10

// empty reports whether the set holds no form and matches no text.
func (s secretSet) empty() bool {
	return s.repl == nil && !s.all
}

// has reports whether text holds one of the forms. A set with all set matches every
// text, empty ones included. Otherwise a text over secretScanCap is reported as
// holding one, without a scan, when the set holds a form. A form is matched by its
// first secretFormMaxLen bytes, so a text that holds a copy of a value always matches.
func (s secretSet) has(text string) bool {
	if s.all {
		return true
	}
	if s.repl == nil || text == "" {
		return false
	}
	if len(text) > secretScanCap {
		return true
	}
	return s.repl.Replace(text) != text
}

// redactSecretValues redacts obj in place, as a manifest on its own. A Secret's
// values are replaced by redactedSecretValue, and any other string that holds
// one is replaced too. A List has each item redacted the same way.
//
// obj is expected to be decoded with sigs.k8s.io/yaml, as the controller decodes
// manifests, so its map keys are strings. The checks are still fail-closed: a
// value of unexpected type is replaced whole, and a map keyed by any is walked.
func redactSecretValues(obj map[string]any) {
	redactObject(obj, secretSetOf(obj), nil)
}

// redactManifestPair redacts a desired and a live object in place, so they can be
// shown and diffed. Either may be nil. The Secret values of both are collected
// before either object changes. A data or stringData key whose value differs
// between two Secrets gets a marker on each side, so the diff of the two is not
// empty. Every other Secret value gets redactedSecretValue, and any other string
// that holds one is replaced too.
func redactManifestPair(desired, live map[string]any) {
	set := secretSetOf(desired, live)
	desiredMarks, liveMarks := changedSecretMarkers(desired, live)
	if desired != nil {
		redactObject(desired, set, desiredMarks)
	}
	if live != nil {
		redactObject(live, set, liveMarks)
	}
}

// redactObject redacts one decoded object in place. set holds every Secret value
// the object must keep out of itself. marks names the data keys whose values differ
// from the other side of a pair, with the marker each one gets.
func redactObject(obj map[string]any, set secretSet, marks map[string]string) {
	redactObjectHeld(obj, set, marks, false)
}

// redactObjectHeld is redactObject. held means a Secret above obj walks its items
// list for stray values once it is redacted.
func redactObjectHeld(obj map[string]any, set secretSet, marks map[string]string, held bool) {
	switch {
	case kindOf(obj) == "Secret":
		redactSecretObject(obj, set, marks)
		if isListObject(obj) {
			redactListItems(obj, false, set, true)
			if !held {
				redactHeldItems(obj, set)
			}
		}
	case isListObject(obj):
		redactListItems(obj, kindOf(obj) == "SecretList", set, held)
	default:
		redactStrayFields(obj, set)
	}
}

// redactHeldItems runs one stray pass over the items list of a List that a Secret holds,
// after each item is redacted: every string in it that holds one of the values is
// replaced, identity fields included. An object that is not a List is left alone.
func redactHeldItems(obj map[string]any, set secretSet) {
	if items, ok := obj["items"]; ok && isListObject(obj) {
		obj["items"] = redactStray(items, set)
	}
}

// redactSecretObject redacts one Secret, or one Secret item of a List. Every string
// outside data and stringData that holds one of the values is replaced first, so the
// values sit only in data and stringData before those are redacted. When the object
// also holds an items list, that list is left to redactListItems, which the caller
// runs. A walk over the list here could rewrite the kind of a Secret item in it, which
// would stop that item being read as a Secret before its values are redacted.
func redactSecretObject(obj map[string]any, set secretSet, marks map[string]string) {
	skip := []string{"data", "stringData"}
	if isListObject(obj) {
		skip = append(skip, "items")
	}
	redactStrayFields(obj, set, skip...)
	for _, field := range []string{"data", "stringData"} {
		value, ok := obj[field]
		if !ok || value == nil {
			continue
		}
		if !redactMapValues(value, marks) {
			obj[field] = redactedSecretValue
		}
	}
	redactCopiedAnnotations(obj)
}

// redactCopiedAnnotations replaces the annotations of a Secret that hold a whole
// copy of it, the last-applied and kapp originals. Annotations that are not a map
// are replaced whole, and so is a metadata that is not a map, since either could
// hold a value.
func redactCopiedAnnotations(obj map[string]any) {
	if obj["metadata"] == nil {
		return
	}
	meta, ok := obj["metadata"].(map[string]any)
	if !ok {
		obj["metadata"] = redactedSecretValue
		return
	}
	switch annotations := meta["annotations"].(type) {
	case nil:
	case map[string]any:
		replaceCopiedKeys(annotations)
	case map[any]any:
		replaceCopiedAnyKeys(annotations)
	default:
		meta["annotations"] = redactedSecretValue
	}
}

// replaceCopiedKeys replaces each copied-Secret annotation that annotations holds.
func replaceCopiedKeys(annotations map[string]any) {
	for _, key := range secretCopyAnnotations {
		if _, ok := annotations[key]; ok {
			annotations[key] = redactedSecretValue
		}
	}
}

// replaceCopiedAnyKeys is replaceCopiedKeys for a map keyed by any.
func replaceCopiedAnyKeys(annotations map[any]any) {
	for _, key := range secretCopyAnnotations {
		if _, ok := annotations[key]; ok {
			annotations[key] = redactedSecretValue
		}
	}
}

// redactListObject redacts the items of a List, and the List's own fields. Every
// item of a SecretList is a Secret, and so is an item with no kind or with data or
// stringData. The values of every Secret item are kept out of every item and out of
// the List's own fields, so a value copied elsewhere in the List is redacted too. An
// item that is not a map, or an items field that is not a list, is replaced.
func redactListObject(obj map[string]any, allSecret bool, set secretSet) {
	redactListItems(obj, allSecret, set, false)
}

// redactListItems is redactListObject. held means a Secret above obj walks its items
// list for stray values once it is redacted, so a nested List does not walk it again.
func redactListItems(obj map[string]any, allSecret bool, set secretSet, held bool) {
	redactStrayFields(obj, set, "items")
	items, ok := obj["items"]
	if !ok || items == nil {
		return
	}
	list, isList := items.([]any)
	if !isList {
		obj["items"] = redactedSecretValue
		return
	}
	for i, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			list[i] = redactedSecretValue
			continue
		}
		if isSecretItem(m, allSecret) {
			redactSecretObject(m, set, nil)
			if isListObject(m) {
				redactListItems(m, kindOf(m) == "SecretList", set, true)
				if !held {
					redactHeldItems(m, set)
				}
			}
		} else {
			redactObjectHeld(m, set, nil, held)
		}
	}
}

// redactStrayFields replaces every string under obj that holds one of the values
// in set. The fields named in skip are left alone, and so are the identity fields:
// the kind and API version, and the name, namespace, uid and owner references in
// metadata. Map keys are never replaced.
func redactStrayFields(obj map[string]any, set secretSet, skip ...string) {
	if set.empty() {
		return
	}
	for k, v := range obj {
		if isIdentityRootKey(k) || slices.Contains(skip, k) {
			continue
		}
		if meta, ok := v.(map[string]any); ok && k == "metadata" {
			for mk, mv := range meta {
				if isIdentityMetaKey(mk) {
					continue
				}
				meta[mk] = redactStray(mv, set)
			}
			continue
		}
		obj[k] = redactStray(v, set)
	}
}

// redactStray returns v with every string that holds one of the values replaced.
// Maps and lists are walked in place.
func redactStray(v any, set secretSet) any {
	if s, ok := v.(string); ok {
		if !isSecretMarker(s) && set.has(s) {
			return redactedSecretValue
		}
		return s
	}
	if set.all && isScalar(v) {
		return redactedSecretValue
	}
	redactStrayChildren(v, set)
	return v
}

// isScalar reports whether a decoded value is a scalar, which is neither a map nor a
// list.
func isScalar(v any) bool {
	switch v.(type) {
	case map[string]any, map[any]any, []any:
		return false
	}
	return true
}

// redactStrayChildren replaces the strings that hold a value inside a map or list,
// in place. Any other value has no children.
func redactStrayChildren(v any, set secretSet) {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			t[k] = redactStray(x, set)
		}
	case map[any]any:
		for k, x := range t {
			t[k] = redactStray(x, set)
		}
	case []any:
		for i, x := range t {
			t[i] = redactStray(x, set)
		}
	}
}

// redactMapValues replaces every value of a data or stringData map, and reports
// whether v was a map. A key with a mark gets that mark. Any other value gets the
// plain marker, unless it already holds a marker, so a second redaction changes
// nothing. The map is edited in place.
func redactMapValues(v any, marks map[string]string) bool {
	switch m := v.(type) {
	case map[string]any:
		for k, cur := range m {
			m[k] = secretMarkerFor(cur, k, marks)
		}
	case map[any]any:
		for k, cur := range m {
			m[k] = secretMarkerFor(cur, fmt.Sprint(k), marks)
		}
	default:
		return false
	}
	return true
}

// secretMarkerFor chooses the marker for one Secret value.
func secretMarkerFor(cur any, key string, marks map[string]string) string {
	if mark, ok := marks[key]; ok {
		return mark
	}
	if s, ok := cur.(string); ok && isSecretMarker(s) {
		return s
	}
	return redactedSecretValue
}

// changedSecretMarkers returns the markers for the data keys whose values differ
// between a desired and a live Secret, one map for each side. A key present on
// one side only counts as changed. Both maps are nil unless both objects are
// Secrets.
func changedSecretMarkers(desired, live map[string]any) (desiredMarks, liveMarks map[string]string) {
	if kindOf(desired) != "Secret" || kindOf(live) != "Secret" {
		return nil, nil
	}
	want, have := secretPlainValues(desired), secretPlainValues(live)
	desiredMarks = make(map[string]string)
	liveMarks = make(map[string]string)
	mark := func(key string) {
		desiredMarks[key] = desiredDiffersValue
		liveMarks[key] = liveDiffersValue
	}
	for k, v := range want {
		if w, ok := have[k]; !ok || w != v {
			mark(k)
		}
	}
	for k := range have {
		if _, ok := want[k]; !ok {
			mark(k)
		}
	}
	return desiredMarks, liveMarks
}

// secretPlainValues returns the value each key of a Secret holds, decoded. A
// stringData value overrides a data value of the same key, as the API server
// does when it writes the object.
func secretPlainValues(obj map[string]any) map[string]string {
	out := make(map[string]string)
	eachMapEntry(obj["data"], func(key string, v any) {
		out[key] = decodedSecretText(v)
	})
	eachMapEntry(obj["stringData"], func(key string, v any) {
		out[key] = fmt.Sprint(v)
	})
	return out
}

// decodedSecretText returns the text a data value holds: the base64 decoding when
// it decodes, and the value as written otherwise.
func decodedSecretText(v any) string {
	s, ok := v.(string)
	if !ok {
		return fmt.Sprint(v)
	}
	if raw, err := base64.StdEncoding.DecodeString(s); err == nil {
		return string(raw)
	}
	return s
}

// eachMapEntry calls fn for each entry of a map, with its key as text. It reports
// false, and calls nothing, when v is not a map.
func eachMapEntry(v any, fn func(key string, value any)) bool {
	switch m := v.(type) {
	case map[string]any:
		for k, x := range m {
			fn(k, x)
		}
	case map[any]any:
		for k, x := range m {
			fn(fmt.Sprint(k), x)
		}
	default:
		return false
	}
	return true
}

// secretSetOf returns the search set of the Secret values that the objects hold. A
// nil object holds none.
func secretSetOf(objs ...map[string]any) secretSet {
	var c formCollector
	for _, obj := range objs {
		collectObjectForms(&c, obj)
	}
	return c.set()
}

// collectObjectForms collects the forms of the Secret values an object holds: those of
// a Secret, and those of each Secret item of a List, at any depth.
func collectObjectForms(c *formCollector, obj map[string]any) {
	if kindOf(obj) == "Secret" {
		collectObjectSecretForms(c, obj)
	}
	items, ok := obj["items"].([]any)
	if !ok {
		return
	}
	allSecret := kindOf(obj) == "SecretList"
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if isSecretItem(m, allSecret) {
			collectObjectSecretForms(c, m)
		}
		if isListObject(m) {
			collectObjectForms(c, m)
		}
	}
}

// collectObjectSecretForms collects the forms of the values under data and stringData.
func collectObjectSecretForms(c *formCollector, obj map[string]any) {
	eachLeaf(obj["data"], func(s string) {
		collectSecretForms(c, s, true)
	})
	eachLeaf(obj["stringData"], func(s string) {
		collectSecretForms(c, s, false)
	})
}

// eachLeaf calls fn for each string leaf of a value, including the values of maps
// and lists. Map keys are not leaves.
func eachLeaf(v any, fn func(string)) {
	switch t := v.(type) {
	case nil:
	case string:
		fn(t)
	case map[string]any:
		for _, x := range t {
			eachLeaf(x, fn)
		}
	case map[any]any:
		for _, x := range t {
			eachLeaf(x, fn)
		}
	case []any:
		for _, x := range t {
			eachLeaf(x, fn)
		}
	default:
		fn(fmt.Sprint(t))
	}
}

// collectSecretForms collects the forms of one Secret value. encoded means s is a data
// value, whose stored text is base64, so its decoding is a form too.
//
// The forms are the raw value and its trimmed text, each with its padded and
// unpadded standard and URL-safe base64, and its JSON-escaped text. Forms shorter than
// secretFormMinLen, blank forms and markers are skipped, and a longer form is cut to
// its first secretFormMaxLen bytes.
func collectSecretForms(c *formCollector, s string, encoded bool) {
	if c.over {
		return
	}
	raw := s
	if encoded {
		addForm(c, s)
		if decoded, err := base64.StdEncoding.DecodeString(s); err == nil {
			raw = string(decoded)
		}
	}
	bases := []string{raw}
	if trimmed := strings.TrimSpace(raw); trimmed != raw {
		bases = append(bases, trimmed)
	}
	for _, b := range bases {
		addForm(c, b)
		addForm(c, base64.StdEncoding.EncodeToString([]byte(b)))
		addForm(c, base64.RawStdEncoding.EncodeToString([]byte(b)))
		addForm(c, base64.URLEncoding.EncodeToString([]byte(b)))
		addForm(c, base64.RawURLEncoding.EncodeToString([]byte(b)))
		if quoted, err := json.Marshal(b); err == nil {
			addForm(c, string(quoted[1:len(quoted)-1]))
		}
	}
}

// secretFormMinLen is the shortest form searched for. A shorter value, such as a
// single digit, would match ordinary text in labels and annotations. Each data and
// stringData value is still replaced in place, whatever its length.
const secretFormMinLen = 6

// secretFormMaxLen is the longest part of a form that is searched for. A longer form
// is cut to this prefix. A copy of the value contains the prefix, so a copy is still
// found. The cut also bounds the search: forms that share a long prefix made a scan
// cost grow with the length of the shared text. The cost is that a text which shares
// only the prefix, such as a PEM header common to several certificates, is replaced.
const secretFormMaxLen = 32

// addForm collects form unless it is too short, blank, or a marker. A longer form is
// cut to its first secretFormMaxLen bytes.
func addForm(c *formCollector, form string) {
	if len(form) < secretFormMinLen || strings.TrimSpace(form) == "" || isSecretMarker(form) {
		return
	}
	if len(form) > secretFormMaxLen {
		form = form[:secretFormMaxLen]
	}
	c.add(form)
}

// redactSecretManifests returns a multi-document manifest in which every Secret's
// values are redacted. The Secret items of a top-level sequence are redacted too.
//
// The stream is split as the controller splits it, and the first document of each chunk is
// checked against the object the controller decodes from that chunk. The controller
// applies that object, so a value that is hidden from the node of a document, by a BOM, a
// tag, or a key read differently, is still found. A document of kind Secret, or a kind
// ending in List, or any document with an items list, or a document with no kind that has
// data or stringData, is redacted on its YAML node, and re-encoded from that node, when
// the node is plain (it has no duplicate key, alias, anchor, merge key or explicit tag)
// and the node declares the kind the controller reads: its comments and fields such as
// finalizers and ownerReferences survive. Any other such document is redacted as the
// decoded object and re-encoded from it, so the kind of a document whose kind is ~ is
// printed as `kind: null`. A document has no kind when the controller reads no string kind
// from it: its kind is missing, empty or not a string, such as ~, yes or 5. That is judged
// from the decoded object, or from the text when the controller cannot decode the
// document. A document with no kind that has data or stringData is redacted as a Secret.
// Every comment that holds a value is dropped. Any other document is kept as written,
// apart from indentation, and a duplicate key in it does not fail the render.
//
// Render refuses what it cannot check. A document that yaml.v3 cannot read fails the
// render, even when the controller would apply it. Among the documents the controller
// cannot decode, Render also refuses a Secret, a List, a document with an items list, a
// document with no kind that has data or stringData, any document with an alias, anchor,
// merge key, explicit tag or duplicate key, and a top-level sequence that holds a
// sequence. Any other document the controller cannot decode is kept as written, since the
// controller never applies it. The error names the document's position only, and not its
// text, since the text may hold a value.
func redactSecretManifests(manifests []byte) ([]byte, error) {
	var out []string
	docs := 0
	for _, chunk := range engine.SplitYAMLDocuments(manifests) {
		texts, err := redactChunk(chunk, &docs)
		if err != nil {
			return nil, err
		}
		out = append(out, texts...)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return []byte(strings.Join(out, "\n---\n") + "\n"), nil
}

// redactChunk redacts one chunk of the stream, which is one document as the
// controller splits it. docs counts the documents read so far, across the stream, so
// an error can name the position of the document it is about. The first document in
// the chunk is the one the controller applies, so it is checked against the
// controller's decoding. Any later document in the chunk is checked against its own
// re-encoding.
func redactChunk(chunk []byte, docs *int) ([]string, error) {
	view, viewErr := decodeManifest(chunk)
	dec := yaml.NewDecoder(bytes.NewReader(chunk))
	var out []string
	for first := true; ; first = false {
		var doc yaml.Node
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		*docs++
		if err != nil {
			return nil, documentCheckError(*docs)
		}
		text, keep, err := readDocument(&doc, *docs, first, view, viewErr)
		if err != nil {
			return nil, err
		}
		if keep {
			out = append(out, text)
		}
	}
}

// readDocument redacts a document that yaml.v3 reads. The first document of a chunk
// is checked against the controller's decoding, and any other against its own
// re-encoding. A document that cannot be checked fails with an error that names only
// its position.
func readDocument(doc *yaml.Node, index int, first bool, view map[string]any, viewErr error) (text string, keep bool, err error) {
	docView, docViewErr := view, viewErr
	if !first {
		docView, docViewErr = nodeView(doc)
	}
	text, keep, err = redactDocument(doc, docView, docViewErr)
	if err != nil {
		return "", false, documentCheckError(index)
	}
	return text, keep, nil
}

// documentCheckError is the error for a rendered document that cannot be checked
// for Secret values. It names the document's position only. Neither its text nor
// its kind is named, since either may come from a value.
func documentCheckError(index int) error {
	return fmt.Errorf("rendered document %d could not be checked for Secret values", index)
}

// decodeManifest decodes one manifest with sigs.k8s.io/yaml, as the controller does.
func decodeManifest(manifest []byte) (map[string]any, error) {
	var obj map[string]any
	if err := k8syaml.Unmarshal(manifest, &obj); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	return obj, nil
}

// nodeView decodes a document node the way a later document of a chunk is read:
// from its own re-encoding.
func nodeView(doc *yaml.Node) (map[string]any, error) {
	text, err := encodeYAML(doc)
	if err != nil {
		return nil, errors.New("rendered document could not be re-encoded")
	}
	return decodeManifest([]byte(text))
}

// redactDocument returns one rendered document as it is written to the output. view
// is the decoded object the controller reads from the document, and viewErr is its
// decoding error. keep is false for a document with no content.
func redactDocument(doc *yaml.Node, view map[string]any, viewErr error) (text string, keep bool, err error) {
	root := docRoot(doc)
	if root.Kind == yaml.SequenceNode {
		return redactSequenceDocument(doc, root)
	}
	if viewErr != nil {
		if refusesUndecodedDocument(doc, root) {
			return "", false, errors.New("rendered Secret could not be decoded")
		}
		return encodeDocument(doc)
	}
	if view == nil {
		return "", false, nil
	}
	if !holdsRedactedValues(root, view) {
		return encodeDocument(doc)
	}
	return redactManifestDocument(doc, root, view)
}

// refusesUndecodedDocument reports whether Render refuses a document the controller
// cannot decode. The controller never applies such a document, so Render refuses one that
// could hold a value it cannot check: a Secret, a List or a document with an items
// list, a kind-less Secret, or a document that is not plain.
func refusesUndecodedDocument(doc, root *yaml.Node) bool {
	return isSecretOrList(nodeKind(root)) || isListNode(root) || isKindlessSecret(root, nil) || !nodePlain(doc)
}

// holdsRedactedValues reports whether a readable document is redacted as a Secret or a
// List: one that holds a Secret or a List, or a kind-less Secret.
func holdsRedactedValues(root *yaml.Node, view map[string]any) bool {
	return isSecretOrList(kindOf(view)) || isSecretOrList(nodeKind(root)) || isListObject(view) || isListNode(root) || isKindlessSecret(root, view)
}

// redactManifestDocument redacts a document that holds a Secret or a List, or a
// kind-less Secret. The node is redacted in place when the node and the controller's
// object agree on the kind and the node is plain. Otherwise the decoded object is
// redacted and re-encoded. The values of a Secret that the node declares, and of a
// kind-less Secret, are in the search set, read from the decoded object as well as the
// node, so a copy of one elsewhere in the document is replaced. A kind-less Secret is
// also redacted as a Secret.
func redactManifestDocument(doc, root *yaml.Node, view map[string]any) (text string, keep bool, err error) {
	declared := nodeKind(root)
	decoded := kindOf(view)
	kindless := isKindlessSecret(root, view)
	set := manifestDocumentSet(root, view, declared, kindless)
	if decoded == declared && nodePlain(doc) {
		redactNodeDoc(root, decoded, set)
		if kindless {
			redactSecretNode(root, set)
			walkHeldNodeItems(root, set)
		}
		dropCommentsEverywhere(doc, set)
		return encodeDocument(doc)
	}
	// The node cannot be trusted to say what the controller applies, so the decoded
	// object is redacted for each kind either side declares, and re-encoded.
	redactDecodedDoc(view, set, declared)
	if kindless {
		redactSecretObject(view, set, nil)
	}
	if kindless || declared == "Secret" {
		redactHeldItems(view, set)
	}
	return encodeDocument(view)
}

// manifestDocumentSet returns the search set of a document redacted by
// redactManifestDocument. It holds the forms of the Secret values in the decoded object
// and in the node, and, for a Secret or a kind-less Secret, the forms of its data and
// stringData.
func manifestDocumentSet(root *yaml.Node, view map[string]any, declared string, kindless bool) secretSet {
	var collected formCollector
	collectObjectForms(&collected, view)
	collectNodeForms(&collected, root)
	if declared == "Secret" {
		collectObjectSecretForms(&collected, view)
	}
	if kindless {
		collectObjectSecretForms(&collected, view)
		collectNodeObjectForms(&collected, root)
	}
	return collected.set()
}

// walkHeldNodeItems walks the items list of a List node for stray values, identity
// fields included. redactNodeList keeps the identity fields of a held List's items, so a
// Secret node that is a List calls this after it is redacted.
func walkHeldNodeItems(root *yaml.Node, set secretSet) {
	if isListNode(root) {
		walkStrayNode(mappingValue(root, "items"), set)
	}
}

// isKindlessSecret reports whether a top-level mapping has no kind and holds data or
// stringData, on the node or in the decoded view. A readable document has no kind when
// the controller reads no string kind from its decoded object, and the node's kind is
// not consulted. An undecodable document, which has a nil view, has no kind when its
// node declares no string kind. The controller never applies such a document's values,
// but Render would return them as written.
func isKindlessSecret(root *yaml.Node, view map[string]any) bool {
	noKind := kindOf(view) == ""
	if view == nil {
		noKind = !nodeHasStringKind(root)
	}
	return noKind && (nodeHasSecretData(root) || objectHasSecretData(view))
}

// nodeHasSecretData reports whether a mapping node has a data or stringData key.
func nodeHasSecretData(root *yaml.Node) bool {
	return mappingValue(root, "data") != nil || mappingValue(root, "stringData") != nil
}

// objectHasSecretData reports whether a decoded object has a data or stringData key.
func objectHasSecretData(obj map[string]any) bool {
	_, hasData := obj["data"]
	_, hasStringData := obj["stringData"]
	return hasData || hasStringData
}

// redactSequenceDocument redacts a top-level sequence. The controller does not apply
// such a document, so its mapping items are read as Secret items where they have no
// kind, a Secret kind, or data or stringData. A List item is redacted as a List, and any
// other mapping item as its own kind. A scalar item only has its stray values replaced.
// A sequence that holds a sequence is refused, as Render cannot check it.
func redactSequenceDocument(doc, root *yaml.Node) (text string, keep bool, err error) {
	if !nodePlain(doc) {
		return "", false, errors.New("rendered document could not be checked")
	}
	for _, item := range root.Content {
		if item.Kind == yaml.SequenceNode {
			return "", false, errors.New("rendered document holds a sequence item")
		}
	}
	set := sequenceSecretSet(root.Content)
	for _, item := range root.Content {
		switch {
		case item.Kind != yaml.MappingNode:
			walkStrayNode(item, set)
		case isSecretNodeItem(item, false):
			redactSecretNode(item, set)
			if isListNode(item) {
				redactNodeList(item, nodeKind(item) == "SecretList", set, true)
				walkHeldNodeItems(item, set)
			}
		default:
			redactNodeDoc(item, nodeKind(item), set)
		}
	}
	dropCommentsEverywhere(doc, set)
	return encodeDocument(doc)
}

// redactDecodedDoc redacts a decoded document in place for the kind it declares
// and for the kind the controller reads from it.
func redactDecodedDoc(obj map[string]any, set secretSet, declared string) {
	redactObject(obj, set, nil)
	switch {
	case declared == "Secret" && kindOf(obj) != "Secret":
		redactSecretObject(obj, set, nil)
	case isListKind(declared) && !isListObject(obj):
		redactListObject(obj, declared == "SecretList", set)
	}
}

// sequenceSecretSet returns the search set of the Secret items of a top-level sequence.
func sequenceSecretSet(items []*yaml.Node) secretSet {
	var c formCollector
	for _, item := range items {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if isSecretNodeItem(item, false) {
			collectNodeObjectForms(&c, item)
		}
		collectNodeForms(&c, item)
	}
	return c.set()
}

// collectNodeForms collects the forms of the Secret values a mapping node holds: those
// of a Secret, and those of each Secret item of a List, at any depth.
func collectNodeForms(c *formCollector, n *yaml.Node) {
	if n == nil || n.Kind != yaml.MappingNode {
		return
	}
	kind := nodeKind(n)
	if kind == "Secret" {
		collectNodeObjectForms(c, n)
	}
	items := mappingValue(n, "items")
	if items == nil || items.Kind != yaml.SequenceNode {
		return
	}
	for _, item := range items.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if isSecretNodeItem(item, kind == "SecretList") {
			collectNodeObjectForms(c, item)
		}
		if isListNode(item) {
			collectNodeForms(c, item)
		}
	}
}

// collectNodeObjectForms collects the forms of the scalars under data and stringData.
func collectNodeObjectForms(c *formCollector, n *yaml.Node) {
	nodeLeaves(mappingValue(n, "data"), func(s string) {
		collectSecretForms(c, s, true)
	})
	nodeLeaves(mappingValue(n, "stringData"), func(s string) {
		collectSecretForms(c, s, false)
	})
}

// redactNodeDoc redacts one document node of the given kind in place.
func redactNodeDoc(root *yaml.Node, kind string, set secretSet) {
	redactNodeDocHeld(root, kind, set, false)
}

// redactNodeDocHeld is redactNodeDoc. held means a Secret above root walks its items
// list for stray values once it is redacted.
func redactNodeDocHeld(root *yaml.Node, kind string, set secretSet, held bool) {
	switch {
	case kind == "Secret":
		redactSecretNode(root, set)
		if isListNode(root) {
			redactNodeList(root, false, set, true)
			if !held {
				walkHeldNodeItems(root, set)
			}
		}
	case isListNode(root):
		redactNodeList(root, kind == "SecretList", set, held)
	default:
		walkStrayFieldNodes(root, set)
	}
}

// redactNodeList redacts the items of a List node, and the List's own fields. The
// rules are those of redactListObject. held means a Secret above root walks its items
// list for stray values once it is redacted.
func redactNodeList(root *yaml.Node, allSecret bool, set secretSet, held bool) {
	walkStrayFieldNodes(root, set, "items")
	items := mappingValue(root, "items")
	if items == nil || isNullNode(items) {
		return
	}
	if items.Kind != yaml.SequenceNode {
		markerize(items)
		return
	}
	for _, item := range items.Content {
		if item.Kind != yaml.MappingNode {
			markerize(item)
			continue
		}
		if isSecretNodeItem(item, allSecret) {
			redactSecretNode(item, set)
			if isListNode(item) {
				redactNodeList(item, nodeKind(item) == "SecretList", set, true)
				if !held {
					walkHeldNodeItems(item, set)
				}
			}
			continue
		}
		redactNodeDocHeld(item, nodeKind(item), set, held)
	}
}

// redactSecretNode redacts one Secret node in place. Each value of data and
// stringData becomes the marker, and the keys stay. Every other scalar that holds a
// value is replaced, and so is each copied-Secret annotation. An items list is left
// to redactNodeList, as in redactSecretObject.
func redactSecretNode(root *yaml.Node, set secretSet) {
	skip := []string{"data", "stringData"}
	if isListNode(root) {
		skip = append(skip, "items")
	}
	walkStrayFieldNodes(root, set, skip...)
	for _, field := range []string{"data", "stringData"} {
		value := mappingValue(root, field)
		clearCommentsWithin(value)
		markerizeValues(value)
	}
	markerizeCopiedAnnotations(mappingValue(mappingValue(root, "metadata"), "annotations"))
}

// markerizeValues replaces the value of each entry of a data or stringData node
// with the marker. The keys stay. A value that is not a mapping is replaced whole.
func markerizeValues(value *yaml.Node) {
	switch {
	case value == nil || isNullNode(value):
	case value.Kind == yaml.MappingNode:
		for j := 1; j < len(value.Content); j += 2 {
			markerize(value.Content[j])
		}
	default:
		markerize(value)
	}
}

// markerizeCopiedAnnotations replaces the annotations that hold a whole copy of a
// Secret, and an annotations node that is not a mapping, with the marker.
func markerizeCopiedAnnotations(annotations *yaml.Node) {
	switch {
	case annotations == nil || isNullNode(annotations):
	case annotations.Kind == yaml.MappingNode:
		for _, key := range secretCopyAnnotations {
			if copied := mappingValue(annotations, key); copied != nil {
				markerize(copied)
			}
		}
	default:
		markerize(annotations)
	}
}

// nodeLeaves calls fn for each scalar value under n. Mapping keys are skipped, and
// so are explicit nulls, which hold no value.
func nodeLeaves(n *yaml.Node, fn func(string)) {
	if n == nil {
		return
	}
	switch n.Kind {
	case yaml.ScalarNode:
		if !isNullNode(n) {
			fn(n.Value)
		}
	case yaml.MappingNode:
		for i := 1; i < len(n.Content); i += 2 {
			nodeLeaves(n.Content[i], fn)
		}
	case yaml.SequenceNode, yaml.DocumentNode:
		for _, c := range n.Content {
			nodeLeaves(c, fn)
		}
	case yaml.AliasNode:
		// Documents that hold an alias are redacted as decoded objects, not here.
	}
}

// walkStrayFieldNodes replaces every scalar value under the root mapping that holds
// one of the values in set. The fields named in skip are left alone, and so are the
// identity fields: the kind and API version, and the name, namespace, uid and owner
// references in metadata. Keys are never replaced.
func walkStrayFieldNodes(root *yaml.Node, set secretSet, skip ...string) {
	if root == nil || set.empty() {
		return
	}
	if root.Kind != yaml.MappingNode {
		walkStrayNode(root, set)
		return
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		key, value := root.Content[i], root.Content[i+1]
		if isIdentityRootKey(key.Value) || slices.Contains(skip, key.Value) {
			continue
		}
		if key.Value == "metadata" && value.Kind == yaml.MappingNode {
			walkStrayMetadataNodes(value, set)
			continue
		}
		walkStrayNode(value, set)
	}
}

// walkStrayMetadataNodes is walkStrayFieldNodes for a metadata mapping, whose
// identity fields are left alone.
func walkStrayMetadataNodes(meta *yaml.Node, set secretSet) {
	for j := 0; j+1 < len(meta.Content); j += 2 {
		if isIdentityMetaKey(meta.Content[j].Value) {
			continue
		}
		walkStrayNode(meta.Content[j+1], set)
	}
}

// walkStrayNode replaces every scalar under n that holds one of the values. Mapping
// keys are not replaced.
func walkStrayNode(n *yaml.Node, set secretSet) {
	if n == nil || set.empty() {
		return
	}
	if n.Kind == yaml.ScalarNode {
		if !isSecretMarker(n.Value) && set.has(n.Value) {
			markerize(n)
		}
		return
	}
	if n.Kind == yaml.MappingNode {
		for i := 1; i < len(n.Content); i += 2 {
			walkStrayNode(n.Content[i], set)
		}
		return
	}
	for _, c := range n.Content {
		walkStrayNode(c, set)
	}
}

// dropCommentsEverywhere clears each comment of every node under n that holds one
// of the values in set. Every node is checked, including the document, the root
// mapping, keys and identity fields, so a comment cannot carry a value past the
// redaction. A comment that holds no value is kept.
func dropCommentsEverywhere(n *yaml.Node, set secretSet) {
	if n == nil || set.empty() {
		return
	}
	for _, comment := range []*string{&n.HeadComment, &n.LineComment, &n.FootComment} {
		if *comment != "" && set.has(*comment) {
			*comment = ""
		}
	}
	for _, child := range n.Content {
		dropCommentsEverywhere(child, set)
	}
}

// clearCommentsWithin clears every comment on a node and on the nodes under it.
func clearCommentsWithin(n *yaml.Node) {
	if n == nil {
		return
	}
	n.HeadComment, n.LineComment, n.FootComment = "", "", ""
	for _, c := range n.Content {
		clearCommentsWithin(c)
	}
}

// markerize turns a node into the redacted marker, dropping what it held.
func markerize(n *yaml.Node) {
	*n = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: redactedSecretValue}
}

// isNullNode reports whether a node is an explicit or empty null.
func isNullNode(n *yaml.Node) bool {
	return n.Kind == yaml.ScalarNode && n.ShortTag() == "!!null"
}

// docRoot returns the mapping a document node holds.
func docRoot(doc *yaml.Node) *yaml.Node {
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		return doc.Content[0]
	}
	return doc
}

// mappingValue returns the value node stored under key in a mapping node, or nil.
func mappingValue(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// nodeKind returns the kind a mapping node declares, or "".
func nodeKind(root *yaml.Node) string {
	if k := mappingValue(root, "kind"); k != nil && k.Kind == yaml.ScalarNode {
		return k.Value
	}
	return ""
}

// yaml11Bools are the plain words YAML 1.1 reads as a bool. The controller decodes
// manifests with a YAML 1.1 reader, so a plain kind with one of these words is not a
// string to it, although yaml.v3 reads it as one.
var yaml11Bools = []string{
	"y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO",
	"true", "True", "TRUE", "false", "False", "FALSE",
	"on", "On", "ON", "off", "Off", "OFF",
}

// nodeHasStringKind reports whether a mapping node declares a kind that the controller
// reads as a non-empty string. A kind that is missing, empty, or not a scalar is not
// one, and neither is a plain kind that is a YAML 1.1 bool word or a non-string scalar,
// such as a null or a number. A kind that yaml.v3 does not tag !!str, such as a
// timestamp, << or a scalar with another tag, counts as no kind even where the controller
// reads a string. This only makes Render stricter.
func nodeHasStringKind(root *yaml.Node) bool {
	k := mappingValue(root, "kind")
	if k == nil || k.Kind != yaml.ScalarNode || k.Value == "" || k.ShortTag() != "!!str" {
		return false
	}
	return k.Style != 0 || !slices.Contains(yaml11Bools, k.Value)
}

// nodePlain reports whether a node has no alias, anchor, merge key, explicit tag
// or duplicate mapping key. Only such a node is redacted in place: in any other
// node, a value can sit where the node-level walk does not reach, or a key can be
// read differently from its text, or be overridden.
func nodePlain(n *yaml.Node) bool {
	if n.Anchor != "" || n.Kind == yaml.AliasNode || n.Style&yaml.TaggedStyle != 0 {
		return false
	}
	if n.Kind == yaml.MappingNode {
		seen := make(map[string]bool, len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			key := n.Content[i]
			if key.Value == "<<" || seen[key.Value] {
				return false
			}
			seen[key.Value] = true
		}
	}
	return slices.IndexFunc(n.Content, func(c *yaml.Node) bool { return !nodePlain(c) }) < 0
}

// encodeYAML encodes a value with the indentation manifests use, without the
// trailing newline.
func encodeYAML(v any) (string, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(v); err != nil {
		return "", fmt.Errorf("encode yaml: %w", err)
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("close yaml encoder: %w", err)
	}
	return strings.TrimSpace(buf.String()), nil
}

// encodeDocument encodes a document for the output. keep is true for a document
// that is written. The error does not quote the document.
func encodeDocument(v any) (text string, keep bool, err error) {
	out, encodeErr := encodeYAML(v)
	if encodeErr != nil {
		return "", false, errors.New("rendered document could not be re-encoded")
	}
	return out, true, nil
}
