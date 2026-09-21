// Diagnostic prelude: what Node's test common helper reads that the engine lacks. Each line is a fork gap.
process.config ??= { variables: {} };
process.umask ??= () => 0o022;
process.features ??= { debug: false, inspector: false, tls: false };
process.execArgv ??= [];
const net = require("net");
net.getDefaultAutoSelectFamilyAttemptTimeout ??= () => 250;
net.setDefaultAutoSelectFamilyAttemptTimeout ??= () => {};
// The engine's own globals, and Node's that the engine defines as enumerable: known to the leak check.
process.env.NODE_TEST_KNOWN_GLOBALS = "0"; // the leak check compares values, so it is off for the diagnostic; the engine-visible globals are a fork gap of their own
process.env.NODE_SKIP_FLAG_CHECK = "1"; // the helper re-executes node with a test file's `// Flags:`; under the engine there is no node to execute
