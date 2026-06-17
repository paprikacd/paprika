package routing

// HeaderRoute defines a header or cookie match rule for A/B testing.
type HeaderRoute struct {
	Type    string
	Name    string
	Value   string
	Service string
}
