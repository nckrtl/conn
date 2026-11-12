const assert = require("node:assert/strict");
const test = require("node:test");
const { classify, verdictCode, INFRA_MESSAGE } = require("./web-test.cjs");

const esc = "\u001b";
const rule = "⎯⎯⎯⎯⎯⎯";

// Trimmed from main run 43108257661, Test Web 2, attempt 1.
const closedAfterRun = `
 ${esc}[32m✓${esc}[39m browser (chromium) src/components/CommandPaletteContent.browser.test.tsx (1 test) 191ms
${esc}[31m${rule}${esc}[39m${esc}[1m${esc}[41m Unhandled Errors ${esc}[49m${esc}[22m${esc}[31m${rule}${esc}[39m

Vitest caught 1 unhandled error during the test run.
${esc}[31m${rule}${esc}[39m${esc}[1m${esc}[41m Unhandled Error ${esc}[49m${esc}[22m${esc}[31m${rule}⎯${esc}[39m
Error: Failed to run the test /home/runner/work/conn/conn/apps/web/src/components/files/FileExplorerPane.browser.test.tsx.
Caused by: Error: [vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?
Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }
Caused by: Error: [birpc] rpc is closed, cannot call "createTesters"

 Test Files  294 passed (302)
      Tests  2330 passed (2330)
     Errors  1 error
`;

// Trimmed from conn#33's Test Web 2: vitest died before its summary.
const closedMidRun = `
 ✓  browser (chromium)  src/components/device/DeviceToolsPanel.browser.test.tsx (1 test) 344ms
${rule} Unhandled Rejection ${rule}
Error: [vitest] There was an error when mocking a module.
Caused by: Error: [vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?
Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }
Caused by: Error: [birpc] rpc is closed, cannot call "resolveManualMock"
`;

const failedAssertion = `
 ${esc}[31m❯${esc}[39m browser (chromium) src/components/Foo.browser.test.tsx (2 tests | 1 failed)
   ${esc}[31m×${esc}[39m renders the title 120ms
${rule} Failed Tests 1 ${rule}
 FAIL  browser (chromium) src/components/Foo.browser.test.tsx > renders the title
AssertionError: expected 'a' to be 'b'
`;

const plainFailure = `
 FAIL  unit src/lib/bar.test.ts > adds
AssertionError: expected 3 to be 4
 Test Files  1 failed | 300 passed (301)
      Tests  1 failed | 2329 passed (2330)
`;

test("a clean run passes", () => {
  assert.equal(classify("Test Files  302 passed (302)", 0), "pass");
});

test("browser closed with no failed test is a browser-closed run", () => {
  assert.equal(classify(closedAfterRun, 1), "browser-closed");
  assert.equal(classify(closedMidRun, 1), "browser-closed");
});

test("browser closed plus a failed assertion is a real failure", () => {
  assert.equal(classify(closedAfterRun + failedAssertion, 1), "fail");
  assert.equal(classify(closedMidRun + plainFailure, 1), "fail");
});

test("summary counts with a failed file or test are a real failure", () => {
  const failedFile = closedAfterRun.replace("294 passed (302)", "1 failed | 293 passed (302)");
  assert.equal(classify(failedFile, 1), "fail");
  const failedTest = closedAfterRun.replace("2330 passed (2330)", "1 failed | 2329 passed (2330)");
  assert.equal(classify(failedTest, 1), "fail");
});

test("a file that failed before its tests ran is a real failure", () => {
  const importFailed = " ❯ browser (chromium) src/components/Foo.browser.test.tsx (0 test)\n";
  assert.equal(classify(importFailed + closedMidRun, 1), "fail");
  const skipped =
    " ❯ browser (chromium) src/components/Foo.browser.test.tsx (2 tests | 2 skipped) 40ms\n";
  assert.equal(classify(skipped + closedMidRun, 1), "fail");
  assert.equal(classify(`${closedAfterRun}${rule} Failed Suites 1 ${rule}\n`, 1), "fail");
});

test("an error block without the signature is a real failure", () => {
  const uncaught = `${closedMidRun}${rule} Uncaught Exception ${rule}\nTypeError: x is not a function\n`;
  assert.equal(classify(uncaught, 1), "fail");
  const twiceCoded = closedMidRun.replace(
    "Caused by: Error: [birpc]",
    "{ code: 'VITEST_BROWSER_CONNECTION_CLOSED' }\n$&",
  );
  assert.equal(classify(`${twiceCoded}${rule} Unhandled Error ${rule}\nTypeError: y\n`, 1), "fail");
});

test("an extra unhandled error that is not browser-closed is a real failure", () => {
  const extraError = closedAfterRun
    .replace("Errors  1 error", "Errors  2 errors")
    .concat(`${rule} Unhandled Error ${rule}\nTypeError: x is not a function\n`);
  assert.equal(classify(extraError, 1), "fail");
});

test("a plain failure without the signature is a real failure", () => {
  assert.equal(classify(plainFailure, 1), "fail");
  assert.equal(classify("", 1), "fail");
});

test("a pass or a real failure keeps its exit code", () => {
  assert.equal(
    verdictCode({ code: 0, output: "" }, () => {}),
    0,
  );
  assert.equal(
    verdictCode({ code: 1, output: closedAfterRun + failedAssertion }, () => {}),
    1,
  );
  assert.equal(
    verdictCode({ code: 1, output: plainFailure }, () => {}),
    1,
  );
});

test("a closed browser with no failed test passes with a warning", () => {
  const lines = [];
  assert.equal(
    verdictCode({ code: 1, output: closedAfterRun }, (line) => lines.push(line)),
    0,
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`::warning title=Web tests::${INFRA_MESSAGE}`));
  assert.ok(lines[0].includes("src/components/files/FileExplorerPane.browser.test.tsx."));
  assert.ok(lines[0].includes(" 8 of 302 test files did not run."));

  const midRun = [];
  assert.equal(
    verdictCode({ code: 1, output: closedMidRun }, (line) => midRun.push(line)),
    0,
  );
  assert.ok(midRun[0].includes("Vitest stopped before its summary"));
});
