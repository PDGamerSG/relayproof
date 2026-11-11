// Package dataset is the deterministic workload shared by the shadow demo's
// mock upstream and load generator. Every prompt has a known correct answer, so
// the mock "models" can be right or wrong in a controlled, reproducible way.
package dataset

import (
	"fmt"
	"hash/fnv"
	"strings"
)

// Kind is the task category of an item.
type Kind string

const (
	KindQA    Kind = "qa"    // short factual answer
	KindMath  Kind = "math"  // arithmetic, exact answer
	KindJSON  Kind = "json"  // structured extraction with response_format json_object
	KindTool  Kind = "tool"  // must call a tool with specific arguments
	KindWrite Kind = "write" // open-ended writing, judged on key points
)

// Item is one prompt with its gold answer.
type Item struct {
	ID     string
	Kind   Kind
	Prompt string
	// Gold is the key fact a correct answer contains (QA, math, write) or the
	// expected value of the main field (JSON) or argument (tool).
	Gold string
	// Wrong is a plausible incorrect answer used when a model "fails" the item.
	Wrong string
	// Reference is a correct full answer for open-ended items (KindWrite).
	Reference string
	// Tool fields (KindTool).
	ToolName string
	ToolArg  string
	// JSON fields (KindJSON): extracted object keys and values.
	JSONName  string
	JSONEmail string
}

var capitals = [][3]string{
	{"France", "Paris", "Lyon"}, {"Japan", "Tokyo", "Osaka"}, {"Australia", "Canberra", "Sydney"},
	{"Canada", "Ottawa", "Toronto"}, {"Brazil", "Brasília", "Rio de Janeiro"}, {"Turkey", "Ankara", "Istanbul"},
	{"Switzerland", "Bern", "Zurich"}, {"India", "New Delhi", "Mumbai"}, {"South Africa", "Pretoria", "Johannesburg"},
	{"New Zealand", "Wellington", "Auckland"}, {"Nigeria", "Abuja", "Lagos"}, {"Morocco", "Rabat", "Casablanca"},
	{"Vietnam", "Hanoi", "Ho Chi Minh City"}, {"Pakistan", "Islamabad", "Karachi"}, {"Kazakhstan", "Astana", "Almaty"},
	{"Germany", "Berlin", "Munich"}, {"Italy", "Rome", "Milan"}, {"Spain", "Madrid", "Barcelona"},
	{"Egypt", "Cairo", "Alexandria"}, {"Kenya", "Nairobi", "Mombasa"},
}

var facts = [][3]string{
	{"Which planet is known as the Red Planet?", "Mars", "Jupiter"},
	{"What gas do plants absorb from the air for photosynthesis?", "carbon dioxide", "oxygen"},
	{"Who wrote the play Romeo and Juliet?", "Shakespeare", "Marlowe"},
	{"What is the chemical symbol for gold?", "Au", "Ag"},
	{"How many continents are there on Earth?", "seven", "six"},
	{"What is the largest ocean on Earth?", "Pacific", "Atlantic"},
	{"What is the boiling point of water at sea level in Celsius?", "100", "90"},
	{"Which language is primarily used to style web pages?", "CSS", "SQL"},
	{"What does HTTP status code 404 mean?", "Not Found", "Forbidden"},
	{"Which data structure uses first-in, first-out ordering?", "queue", "stack"},
	{"What is the time complexity of binary search?", "O(log n)", "O(n)"},
	{"Which company created the Go programming language?", "Google", "Microsoft"},
}

var cities = []string{"Paris", "Tokyo", "Bengaluru", "Toronto", "Sydney", "Berlin", "Nairobi", "Lima"}

var people = [][2]string{
	{"Priya Raman", "priya.raman@example.com"}, {"Jonas Weber", "jonas.weber@example.org"},
	{"Amara Okafor", "amara@okafor.dev"}, {"Lucas Martin", "lucas.martin@example.net"},
	{"Mei Lin", "mei.lin@example.com"}, {"Diego Alvarez", "d.alvarez@example.io"},
	{"Sara Haddad", "sara.haddad@example.com"}, {"Tom Becker", "tom@becker.example"},
}

var essays = [][4]string{
	{"In two sentences, explain why database indexes speed up reads.", "lookup",
		"Indexes make the database slower because every read must scan the index first.",
		"An index keeps a sorted lookup structure, so the database can jump to matching rows instead of scanning the whole table."},
	{"In two sentences, explain what a load balancer does.", "distributes",
		"A load balancer encrypts traffic so that servers do not have to.",
		"A load balancer distributes incoming requests across several servers, so no single machine is overwhelmed."},
	{"In two sentences, explain why HTTPS matters.", "encrypt",
		"HTTPS mainly makes websites load faster by caching pages.",
		"HTTPS uses TLS to encrypt traffic between client and server, so data cannot be read or altered in transit."},
	{"In two sentences, explain what a cache hit is.", "served from the cache",
		"A cache hit is when the cache is cleared after an error.",
		"A cache hit is a request that is served from the cache because the data is already stored there."},
	{"In two sentences, explain idempotency in APIs.", "same result",
		"Idempotency means an API can only be called once.",
		"An idempotent API call gives the same result no matter how many times it is repeated, which makes retries safe."},
	{"In two sentences, explain what rate limiting protects against.", "overload",
		"Rate limiting is used to compress responses.",
		"Rate limiting caps how many requests a client can make, protecting the service from overload and abuse."},
}

// Items returns the full workload in a stable order.
func Items() []Item {
	var out []Item
	for i, c := range capitals {
		out = append(out, Item{ID: fmt.Sprintf("qa-capital-%02d", i), Kind: KindQA,
			Prompt: fmt.Sprintf("What is the capital of %s? Answer briefly.", c[0]), Gold: c[1], Wrong: c[2]})
	}
	for i, f := range facts {
		out = append(out, Item{ID: fmt.Sprintf("qa-fact-%02d", i), Kind: KindQA, Prompt: f[0], Gold: f[1], Wrong: f[2]})
	}
	for i := 0; i < 24; i++ {
		a, b := 12+i*7%31, 9+i*5%17
		out = append(out, Item{ID: fmt.Sprintf("math-%02d", i), Kind: KindMath,
			Prompt: fmt.Sprintf("What is %d multiplied by %d? Reply with the number.", a, b),
			Gold:   fmt.Sprint(a * b), Wrong: fmt.Sprint(a*b + 10)})
	}
	for i, p := range people {
		out = append(out, Item{ID: fmt.Sprintf("json-%02d", i), Kind: KindJSON,
			Prompt: fmt.Sprintf("Extract the contact as JSON with keys name and email: \"Hi, this is %s, reach me at %s about the renewal.\"", p[0], p[1]),
			Gold:   p[1], Wrong: strings.Replace(p[1], "@", "_at_", 1),
			JSONName: p[0], JSONEmail: p[1]})
	}
	for i, c := range cities {
		out = append(out, Item{ID: fmt.Sprintf("tool-%02d", i), Kind: KindTool,
			Prompt: fmt.Sprintf("What's the weather like in %s right now?", c),
			Gold:   c, Wrong: cities[(i+1)%len(cities)], ToolName: "get_weather", ToolArg: c})
	}
	for i, e := range essays {
		out = append(out, Item{ID: fmt.Sprintf("write-%02d", i), Kind: KindWrite, Prompt: e[0], Gold: e[1], Wrong: e[2], Reference: e[3]})
	}
	return out
}

var byPrompt = func() map[string]Item {
	m := map[string]Item{}
	for _, it := range Items() {
		m[it.Prompt] = it
	}
	return m
}()

// Lookup finds an item by its exact prompt.
func Lookup(prompt string) (Item, bool) {
	it, ok := byPrompt[strings.TrimSpace(prompt)]
	return it, ok
}

// FindInText returns the item whose prompt appears in text (used by the mock judge).
func FindInText(text string) (Item, bool) {
	for p, it := range byPrompt {
		if strings.Contains(text, p) {
			return it, true
		}
	}
	return Item{}, false
}

// Bucket deterministically maps (salt, id) to [0, 100).
func Bucket(salt, id string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(salt + "|" + id))
	return int(h.Sum32() % 100)
}
