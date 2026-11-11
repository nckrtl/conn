#!/usr/bin/env node
// Runs the web tests; retries once when the only problem is that Chromium
// dropped its vitest connection (VITEST_BROWSER_CONNECTION_CLOSED). Any sign of
// a real test failure fails at once. Usage: web-test-retry.cjs <cmd> [args...]
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const INFRA_MESSAGE =
  "Infrastructure failure: browser connection closed twice; not a test failure.";

const CLOSED = /VITEST_BROWSER_CONNECTION_CLOSED|Browser connection was closed while running tests/;
// One header per error; the plural "Unhandled Errors" banner does not match.
const ERROR_HEADER =
  /(?:Unhandled (?:Error|Rejection)|Uncaught Exception|Browser Error|Test Run Error|Teardown Error) ⎯/g;
const ERRORS_SUMMARY = /^\s*Errors\s+(\d+) errors?\b/m;
const FAILURE_MARKERS = [
  /^\s*FAIL\s/m, // failed test file or test in the report
  /^\s*[×✗]\s/m, // failed test line
  /^\s*❯ .*\(\d+ tests?\b[^)]*\)/m, // file with a failure, also one that failed to import
  /Failed (?:Tests?|Suites?) \d+/, // report banners
  /^\s*(?:Test Files|Tests)\s.*\b\d+ failed\b/m, // summary counts
  /AssertionError/,
  /Snapshots?\s.*\b\d+ failed\b/,
];

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// Returns "pass", "fail" or "browser-closed". Anything unclear is "fail".
function classify(rawOutput, exitCode) {
  if (exitCode === 0) return "pass";
  const output = stripAnsi(rawOutput);
  if (!CLOSED.test(output)) return "fail";
  if (FAILURE_MARKERS.some((marker) => marker.test(output))) return "fail";
  // Every error block must be a browser-closed one.
  const starts = [...output.matchAll(ERROR_HEADER)].map((match) => match.index);
  const blocks = starts.map((start, i) => output.slice(start, starts[i + 1]));
  if (blocks.some((block) => !CLOSED.test(block))) return "fail";
  const errors = output.match(ERRORS_SUMMARY);
  if (errors && Number(errors[1]) > Math.max(blocks.length, 1)) return "fail";
  return "browser-closed";
}

function runOnce(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output += chunk;
    });
    child.on("error", (error) => {
      output += String(error);
      resolve({ code: 1, output });
    });
    child.on("close", (code) => resolve({ code: code === null ? 1 : code, output }));
  });
}

function summary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // The summary is a convenience; the log line above already says it.
  }
}

// Runs `attempt` up to twice and returns the exit code for the step.
async function runWithRetry(attempt, log = console.log) {
  const first = await attempt(1);
  const firstVerdict = classify(first.output, first.code);
  if (firstVerdict !== "browser-closed") return first.code;

  log("::warning::Browser connection closed with no failed test; running the web tests once more.");
  summary("⚠️ Web tests: browser connection closed with no failed test; retried once.");

  const second = await attempt(2);
  const secondVerdict = classify(second.output, second.code);
  if (secondVerdict === "pass") {
    summary("✅ Web tests passed on the retry.");
    return 0;
  }
  if (secondVerdict === "fail") return second.code;

  const file = stripAnsi(second.output).match(/Failed to run the test (\S+?)\.?$/m)?.[1];
  const where = file ? ` If it repeats, check ${file}.` : "";
  log(`::error::${INFRA_MESSAGE}${where}`);
  summary(`❌ ${INFRA_MESSAGE}${where}`);
  return second.code;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: web-test-retry.cjs <command> [args...]");
    process.exit(2);
  }
  const code = await runWithRetry((n) => {
    if (n > 1) console.log(`\n=== Retry ${n}: ${[command, ...args].join(" ")} ===\n`);
    return runOnce(command, args);
  });
  process.exit(code);
}

module.exports = { classify, runWithRetry, INFRA_MESSAGE };

if (require.main === module) main();
