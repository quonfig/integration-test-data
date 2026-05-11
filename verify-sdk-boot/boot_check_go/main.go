// Boot-check for sdk-go. See ../run.sh for context.
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
	fixture := os.Getenv("QFG_BOOT_CHECK_FIXTURE_HOME")
	if fixture == "" {
		die("QFG_BOOT_CHECK_FIXTURE_HOME unset")
	}
	// os.UserHomeDir reads $HOME first on Unix. Override in-process so the
	// SDK's dev-context loader finds the synthetic tokens.json without
	// disturbing the outer shell's HOME.
	if err := os.Setenv("HOME", fixture); err != nil {
		die("setenv HOME: %v", err)
	}

	if os.Getenv("QUONFIG_BACKEND_SDK_KEY") != "" {
		die("QUONFIG_BACKEND_SDK_KEY must be unset — boot-check exists to prove the SDK boots without it")
	}

	datadir := os.Getenv("QFG_BOOT_CHECK_DATADIR")
	expectedKey := os.Getenv("QFG_BOOT_CHECK_EXPECTED_KEY")
	expectedValue := os.Getenv("QFG_BOOT_CHECK_EXPECTED_VALUE")
	expectedEmail := os.Getenv("QFG_BOOT_CHECK_EXPECTED_EMAIL")
	if datadir == "" || expectedKey == "" || expectedValue == "" || expectedEmail == "" {
		die("missing QFG_BOOT_CHECK_* env vars")
	}

	client, err := quonfig.NewClient(
		quonfig.WithDataDir(datadir),
		quonfig.WithEnvironment("Production"),
		quonfig.WithQuonfigUserContext(true),
		quonfig.WithAllTelemetryDisabled(),
	)
	if err != nil {
		die("NewClient without API key: %v", err)
	}
	defer client.Close()

	value, ok, err := client.GetStringValue(expectedKey, nil)
	if err != nil {
		die("GetStringValue(%q): %v", expectedKey, err)
	}
	if !ok || value != expectedValue {
		die("GetStringValue(%q) returned %q ok=%v, expected %q", expectedKey, value, ok, expectedValue)
	}

	// sdk-go's loadQuonfigUserContext is unexported, and Client.opts is
	// unexported, so we can't introspect the merged global context from
	// outside the package. sdk-go's own unit tests
	// (dev_context_test.go::TestNewClientWithQuonfigUserContext_InjectsIntoGlobalContext)
	// cover that path; this boot-check covers the orthogonal "constructs
	// without QUONFIG_BACKEND_SDK_KEY" regression vector.
	_ = expectedEmail

	fmt.Printf(
		"OK sdk-go: constructed without API key, GetStringValue(%q)=%q\n",
		expectedKey, value,
	)
}
