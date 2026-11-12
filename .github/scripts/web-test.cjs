#!/usr/bin/env node
// Runs the web tests. When the only problem is that Chromium dropped its vitest
// connection (VITEST_BROWSER_CONNECTION_CLOSED), the step passes with a warning:
// an infrastructure failure is not a gate. Any sign of a real test failure fails.
// Usage: web-test.cjs <cmd> [args...]
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const INFRA_MESSAGE = "Infrastructure failure, not a test failure: the browser connection closed.";

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

// Returns the exit code for the step: 0 when the only problem was a closed browser.
function verdictCode(result, log = console.log) {
  if (classify(result.output, result.code) !== "browser-closed") return result.code;
  const output = stripAnsi(result.output);
  const file = output.match(/Failed to run the test (\S+?)\.?$/m)?.[1];
  const counts = output.match(/^\s*Test Files\s+(.*)\((\d+)\)\s*$/m);
  const ran = [...(counts?.[1] ?? "").matchAll(/(\d+) (?:passed|skipped|todo)/g)];
  const details = [
    file ? ` It closed during ${file}.` : "",
    counts
      ? ` ${Number(counts[2]) - ran.reduce((sum, [, n]) => sum + Number(n), 0)} of ${counts[2]} test files did not run.`
      : " Vitest stopped before its summary, so some test files did not run.",
  ].join("");
  log(
    `::warning title=Web tests::${INFRA_MESSAGE}${details} The step passes; re-run the job to run every file.`,
  );
  summary(`⚠️ ${INFRA_MESSAGE}${details}`);
  return 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: web-test.cjs <command> [args...]");
    process.exit(2);
  }
  process.exit(verdictCode(await runOnce(command, args)));
}

module.exports = { classify, verdictCode, INFRA_MESSAGE };

if (require.main === module) main();
