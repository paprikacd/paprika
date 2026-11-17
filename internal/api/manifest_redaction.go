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

// isSecretItem reports whether a List item is treated as a Secret.
func isSecretItem(item map[string]any, allSecret bool) bool {
	kind := kindOf(item)
	return allSecret || kind == "" || kind == "Secret"
}

// isSecretNodeItem reports whether a List item node is treated as a Secret.
func isSecretNodeItem(item *yaml.Node, allSecret bool) bool {
	kind := nodeKind(item)
	return allSecret || kind == "" || kind == "Secret"
}

// secretSet holds the forms of the Secret values that a document must not show.
// has reports whether a text holds one of them. The check is a single pass over
// the text, however many forms the set holds, so a long List costs no more per
// item than its own length.
type secretSet struct {
	repl *strings.Replacer
}

// secretSetMark is what each form is replaced with in a search. It is one byte,
// and no form is equal to it, so a text that holds a form always changes.
const secretSetMark = "\x00"

func newSecretSet(forms []string) secretSet {
	pairs := make([]string, 0, 2*len(forms))
	for _, form := range forms {
		if form == "" || form == secretSetMark {
			continue
		}
		pairs = append(pairs, form, secretSetMark)
	}
	if len(pairs) == 0 {
		return secretSet{}
	}
	return secretSet{repl: strings.NewReplacer(pairs...)}
}

// empty reports whether the set holds no form.
func (s secretSet) empty() bool {
	return s.repl == nil
}

// has reports whether text holds one of the forms.
func (s secretSet) has(text string) bool {
	return s.repl != nil && text != "" && s.repl.Replace(text) != text
}

// redactSecretValues redacts obj in place, as a manifest on its own. A Secret's
// values are replaced by redactedSecretValue, and any other string that holds
// one is replaced too. A List has each item redacted the same way.
//
// obj is expected to be decoded with sigs.k8s.io/yaml, as the controller decodes
// manifests, so its map keys are strings. The checks are still fail-closed: a
// value of unexpected type is replaced whole, and a map keyed by any is walked.
func redactSecretValues(obj map[string]any) {
	redactObject(obj, newSecretSet(secretFormsOf(obj)), nil)
}

// redactManifestPair redacts a desired and a live object in place, so they can be
// shown and diffed. Either may be nil. The Secret values of both are collected
// before either object changes. A data or stringData key whose value differs
// between two Secrets gets a marker on each side, so the diff of the two is not
// empty. Every other Secret value gets redactedSecretValue, and any other string
// that holds one is replaced too.
func redactManifestPair(desired, live map[string]any) {
	set := newSecretSet(append(secretFormsOf(desired), secretFormsOf(live)...))
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
	switch {
	case kindOf(obj) == "Secret":
		redactSecretObject(obj, set, marks)
	case isListObject(obj):
		redactListObject(obj, kindOf(obj) == "SecretList", set)
	default:
		redactStrayFields(obj, set)
	}
}

// redactSecretObject redacts one object of kind Secret. Every string outside data
// and stringData that holds one of the values is replaced first, so the values sit
// only in data and stringData before those are redacted.
func redactSecretObject(obj map[string]any, set secretSet, marks map[string]string) {
	redactStrayFields(obj, set, "data", "stringData")
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
// item of a SecretList is a Secret, and so is an item with no kind. The values of
// every Secret item are kept out of every item and out of the List's own fields,
// so a value copied elsewhere in the List is redacted too. An item that is not a
// map, or an items field that is not a list, is replaced.
func redactListObject(obj map[string]any, allSecret bool, set secretSet) {
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
		} else {
			redactObject(m, set, nil)
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
	redactStrayChildren(v, set)
	return v
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

// secretFormsOf returns the forms of the Secret values an object holds: those of a
// Secret, and those of each Secret item of a List, at any depth.
func secretFormsOf(obj map[string]any) []string {
	return appendSecretFormsOf(nil, obj)
}

func appendSecretFormsOf(out []string, obj map[string]any) []string {
	if kindOf(obj) == "Secret" {
		out = appendObjectSecretForms(out, obj)
	}
	items, ok := obj["items"].([]any)
	if !ok {
		return out
	}
	allSecret := kindOf(obj) == "SecretList"
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if isSecretItem(m, allSecret) {
			out = appendObjectSecretForms(out, m)
		}
		if isListObject(m) {
			out = appendSecretFormsOf(out, m)
		}
	}
	return out
}

// appendObjectSecretForms adds the forms of the values under data and stringData.
func appendObjectSecretForms(out []string, obj map[string]any) []string {
	eachLeaf(obj["data"], func(s string) {
		out = appendSecretForms(out, s, true)
	})
	eachLeaf(obj["stringData"], func(s string) {
		out = appendSecretForms(out, s, false)
	})
	return out
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

// appendSecretForms adds the forms of one Secret value to out. encoded means s is
// a data value, whose stored text is base64, so its decoding is a form too.
//
// The forms are the raw value and its trimmed text, each with its padded and
// unpadded standard and URL-safe base64, and its JSON-escaped text. Blank forms and
// markers are skipped.
func appendSecretForms(out []string, s string, encoded bool) []string {
	raw := s
	if encoded {
		out = appendForm(out, s)
		if decoded, err := base64.StdEncoding.DecodeString(s); err == nil {
			raw = string(decoded)
		}
	}
	bases := []string{raw}
	if trimmed := strings.TrimSpace(raw); trimmed != raw {
		bases = append(bases, trimmed)
	}
	for _, b := range bases {
		out = appendForm(out, b)
		out = appendForm(out, base64.StdEncoding.EncodeToString([]byte(b)))
		out = appendForm(out, base64.RawStdEncoding.EncodeToString([]byte(b)))
		out = appendForm(out, base64.URLEncoding.EncodeToString([]byte(b)))
		out = appendForm(out, base64.RawURLEncoding.EncodeToString([]byte(b)))
		if quoted, err := json.Marshal(b); err == nil {
			out = appendForm(out, string(quoted[1:len(quoted)-1]))
		}
	}
	return out
}

// appendForm adds form to out unless it is blank or a marker.
func appendForm(out []string, form string) []string {
	if strings.TrimSpace(form) == "" || isSecretMarker(form) {
		return out
	}
	return append(out, form)
}

// redactSecretManifests returns a multi-document manifest in which every Secret's
// values are redacted.
//
// The stream is split as the controller splits it, and the first document of each
// piece is checked against the object the controller decodes from that piece. The
// controller applies that object, so a value that is hidden from the node of a
// document, by a BOM, a tag, or a key read differently, is still found. A
// document of kind Secret, or a kind ending in List, or any document with an items
// list, is redacted on its YAML node, and re-encoded from that node, when the node
// has no duplicate key, alias, anchor, merge key or explicit tag: its comments and
// fields such as finalizers and ownerReferences survive. Any other such document
// is redacted as the decoded object and re-encoded from it. Every comment that
// holds a value is dropped. Any other document is kept as written, apart from
// indentation, and a duplicate key in it does not fail the render.
//
// A document that does not parse fails the whole stream, and so does a Secret or
// List that cannot be decoded, so a Secret is never returned unread. The error text
// does not quote the document, since it may hold a value.
func redactSecretManifests(manifests []byte) ([]byte, error) {
	var out []string
	for _, chunk := range engine.SplitYAMLDocuments(manifests) {
		texts, err := redactChunk(chunk)
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

// redactChunk redacts one piece of the stream. The first document in it is the
// one the controller applies, so it is checked against the controller's decoding.
// Any later document in the piece is checked against its own re-encoding.
func redactChunk(chunk []byte) ([]string, error) {
	view, viewErr := decodeManifest(chunk)
	dec := yaml.NewDecoder(bytes.NewReader(chunk))
	var out []string
	for first := true; ; first = false {
		var doc yaml.Node
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, errors.New("rendered document is not valid YAML")
		}
		docView, docViewErr := view, viewErr
		if !first {
			docView, docViewErr = nodeView(&doc)
		}
		text, keep, err := redactDocument(&doc, docView, docViewErr)
		if err != nil {
			return nil, err
		}
		if keep {
			out = append(out, text)
		}
	}
}

// decodeManifest decodes one manifest with sigs.k8s.io/yaml, as the controller does.
func decodeManifest(manifest []byte) (map[string]any, error) {
	var obj map[string]any
	if err := k8syaml.Unmarshal(manifest, &obj); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	return obj, nil
}

// nodeView decodes a document node the way a later document of a piece is read:
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
		if isSecretOrList(nodeKind(root)) {
			return "", false, errors.New("rendered Secret could not be decoded")
		}
		return encodeDocument(doc)
	}
	if view == nil {
		return "", false, nil
	}
	if !isSecretOrList(kindOf(view)) && !isSecretOrList(nodeKind(root)) && !isListObject(view) {
		return encodeDocument(doc)
	}
	return redactManifestDocument(doc, root, view)
}

// redactManifestDocument redacts a document that holds a Secret or a List. The node
// is redacted in place when the node and the controller's object agree on the kind
// and the node is plain. Otherwise the decoded object is redacted and re-encoded.
func redactManifestDocument(doc, root *yaml.Node, view map[string]any) (text string, keep bool, err error) {
	declared := nodeKind(root)
	decoded := kindOf(view)
	set := newSecretSet(append(secretFormsOf(view), nodeSecretFormsOf(nil, root)...))
	if decoded == declared && nodePlain(doc) {
		redactNodeDoc(root, decoded, set)
		dropCommentsEverywhere(doc, set)
		return encodeDocument(doc)
	}
	// The node cannot be trusted to say what the controller applies, so the decoded
	// object is redacted for each kind either side declares, and re-encoded.
	redactDecodedDoc(view, set, declared)
	return encodeDocument(view)
}

// redactSequenceDocument redacts a top-level sequence. The controller does not apply
// such a document, so its mapping items are read as Secret items where they have no
// kind or a Secret kind, and other items only have their stray values replaced.
func redactSequenceDocument(doc, root *yaml.Node) (text string, keep bool, err error) {
	if !nodePlain(doc) {
		return "", false, errors.New("rendered document could not be checked")
	}
	set := newSecretSet(sequenceSecretForms(root.Content))
	for _, item := range root.Content {
		switch {
		case item.Kind != yaml.MappingNode:
			walkStrayNode(item, set)
		case isSecretNodeItem(item, false):
			redactSecretNode(item, set)
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

// sequenceSecretForms returns the forms of the Secret items of a top-level sequence.
func sequenceSecretForms(items []*yaml.Node) []string {
	var out []string
	for _, item := range items {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if isSecretNodeItem(item, false) {
			out = appendNodeObjectForms(out, item)
		}
		out = nodeSecretFormsOf(out, item)
	}
	return out
}

// nodeSecretFormsOf appends the forms of the Secret values a mapping node holds:
// those of a Secret, and those of each Secret item of a List, at any depth.
func nodeSecretFormsOf(out []string, n *yaml.Node) []string {
	if n == nil || n.Kind != yaml.MappingNode {
		return out
	}
	kind := nodeKind(n)
	if kind == "Secret" {
		out = appendNodeObjectForms(out, n)
	}
	items := mappingValue(n, "items")
	if items == nil || items.Kind != yaml.SequenceNode {
		return out
	}
	for _, item := range items.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if isSecretNodeItem(item, kind == "SecretList") {
			out = appendNodeObjectForms(out, item)
		}
		if isListNode(item) {
			out = nodeSecretFormsOf(out, item)
		}
	}
	return out
}

// appendNodeObjectForms adds the forms of the scalars under data and stringData.
func appendNodeObjectForms(out []string, n *yaml.Node) []string {
	nodeLeaves(mappingValue(n, "data"), func(s string) {
		out = appendSecretForms(out, s, true)
	})
	nodeLeaves(mappingValue(n, "stringData"), func(s string) {
		out = appendSecretForms(out, s, false)
	})
	return out
}

// redactNodeDoc redacts one document node of the given kind in place.
func redactNodeDoc(root *yaml.Node, kind string, set secretSet) {
	switch {
	case kind == "Secret":
		redactSecretNode(root, set)
	case isListNode(root):
		redactNodeList(root, kind == "SecretList", set)
	default:
		walkStrayFieldNodes(root, set)
	}
}

// redactNodeList redacts the items of a List node, and the List's own fields. The
// rules are those of redactListObject.
func redactNodeList(root *yaml.Node, allSecret bool, set secretSet) {
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
			continue
		}
		redactNodeDoc(item, nodeKind(item), set)
	}
}

// redactSecretNode redacts one Secret node in place. Each value of data and
// stringData becomes the marker, and the keys stay. Every other scalar that holds a
// value is replaced, and so is each copied-Secret annotation.
func redactSecretNode(root *yaml.Node, set secretSet) {
	walkStrayFieldNodes(root, set, "data", "stringData")
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
