// Injection-check for sdk-go. See ../run.sh for context.
//
// Boots a DEFAULT-config datadir client (NO WithQuonfigUserContext, NO
// QUONFIG_DEV_CONTEXT) and asserts the dev-override flag resolves purely
// from token-file injection.
package main

import (
	"fmt"
	"os"

	quonfig "github.com/quonfig/sdk-go"
)

func die(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "FAIL sdk-go: "+format+"\n", args...)
	os.Exit(1)
}

func main() {
	fixture := os.Getenv("QFG_INJECT_FIXTURE_HOME")
	if fixture == "" {
		die("QFG_INJECT_FIXTURE_HOME unset")
	}
	// os.UserHomeDir reads $HOME first on Unix. Point it at the fixture so
	// the loader finds the synthetic tokens.json (or, in the no-token
	// phase, nothing).
	if err := os.Setenv("HOME", fixture); err != nil {
		die("setenv HOME: %v", err)
	}
	// The default must hold without the env opt-in.
	_ = os.Unsetenv("QUONFIG_DEV_CONTEXT")

	datadir := os.Getenv("QFG_INJECT_DATADIR")
	key := os.Getenv("QFG_INJECT_KEY")
	expected := os.Getenv("QFG_INJECT_EXPECTED") == "true"
	if datadir == "" || key == "" {
		die("missing QFG_INJECT_* env vars")
	}

	// DEFAULT config — deliberately NO WithQuonfigUserContext.
	client, err := quonfig.NewClient(
		quonfig.WithDataDir(datadir),
		quonfig.WithEnvironment("Production"),
		quonfig.WithAllTelemetryDisabled(),
	)
	if err != nil {
		die("NewClient: %v", err)
	}
	defer client.Close()

	value, ok, err := client.GetBoolValue(key, nil)
	if err != nil {
		die("GetBoolValue(%q): %v", key, err)
	}
	if !ok {
		die("GetBoolValue(%q) returned ok=false", key)
	}
	phase := "no-token"
	if expected {
		phase = "token-present"
	}
	if value != expected {
		die("GetBoolValue(%q) = %v, expected %v (phase: %s, HOME=%s)", key, value, expected, phase, fixture)
	}

	fmt.Printf("OK sdk-go: %s -> GetBoolValue(%q)=%v\n", phase, key, value)
}
