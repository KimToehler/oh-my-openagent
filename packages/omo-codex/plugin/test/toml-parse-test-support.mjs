import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Newest first, so a machine with several interpreters uses the most current one.
// The bare names come last: on macOS `python3` is often the 3.9 system build,
// which predates tomllib (added in 3.11).
const PYTHON_CANDIDATES = [
	"python3.14",
	"python3.13",
	"python3.12",
	"python3.11",
	"python3",
	"python",
];

let cachedPython;

export function resolvePythonWithTomllib() {
	if (cachedPython !== undefined) return cachedPython;
	const attempts = [];
	for (const command of PYTHON_CANDIDATES) {
		const result = spawnSync(command, ["-c", "import tomllib"], { encoding: "utf8" });
		if (result.status === 0) {
			cachedPython = command;
			return cachedPython;
		}
		attempts.push(`${command}: ${describeAttempt(result)}`);
	}
	assert.fail(
		`Python with tomllib is required for TOML parse assertions. tomllib needs Python 3.11 or newer. Tried:\n${attempts.join("\n")}`,
	);
}

function describeAttempt(result) {
	if (result.error?.code === "ENOENT") return "not installed";
	const stderr = result.stderr?.trim();
	return stderr === undefined || stderr === "" ? `exit ${result.status}` : stderr.split("\n").at(-1);
}

export function parseTomlWithPython(config) {
	const python = resolvePythonWithTomllib();
	const result = spawnSync(
		python,
		["-c", ["import json, sys, tomllib", "print(json.dumps(tomllib.loads(sys.stdin.read())))"].join("; ")],
		{ encoding: "utf8", input: config },
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}
