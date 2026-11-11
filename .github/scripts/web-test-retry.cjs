#!/usr/bin/env node
// Runs the web tests; retries once when the only problem is that Chromium
// dropped its vitest connection (VITEST_BROWSER_CONNECTION_CLOSED). Any sign of
// a real test failure fails at once. Usage: web-test-retry.cjs <cmd> [args...]
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const INFRA_MESSAGE =
  "Infrastructure failure: browser connection closed twice; not a test failure.";

const CLOSED_CODE = /VITEST_BROWSER_CONNECTION_CLOSED/g;
const CLOSED_TEXT = /Browser connection was closed while running tests/;
// Each unhandled error or rejection gets its own header; the plural
// "Unhandled Errors" banner above them does not match.
const UNHANDLED_HEADER = /Unhandled (?:Error|Rejection) ⎯/g;
const ERRORS_SUMMARY = /^\s*Errors\s+(\d+) errors?\b/m;
const FAILURE_MARKERS = [
  /^\s*FAIL\s/m, // failed test file or test in the report
  /^\s*[×✗]\s/m, // failed test line
  /Failed Tests? \d+/, // "Failed Tests" banner
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
  const closedCount = (output.match(CLOSED_CODE) || []).length;
  if (closedCount === 0 && !CLOSED_TEXT.test(output)) return "fail";
  if (FAILURE_MARKERS.some((marker) => marker.test(output))) return "fail";
  // Every unhandled error must be a browser-closed one.
  const closed = Math.max(closedCount, 1);
  if ((output.match(UNHANDLED_HEADER) || []).length > closed) return "fail";
  const errors = output.match(ERRORS_SUMMARY);
  if (errors && Number(errors[1]) > closed) return "fail";
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

  log(`::error::${INFRA_MESSAGE}`);
  summary(`❌ ${INFRA_MESSAGE}`);
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
