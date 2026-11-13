// Records the shard's test files and each finished file, one JSON line at a time,
// so web-test.cjs still knows what ran after Chromium drops its connection.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const recordPath = process.env.WEB_TEST_RECORD;

function write(entry) {
  if (recordPath) NodeFS.appendFileSync(recordPath, `${JSON.stringify(entry)}\n`);
}

function fileOf(moduleId) {
  return NodePath.relative(process.cwd(), moduleId).split(NodePath.sep).join("/");
}

export default class WebTestRecorder {
  onInit(vitest) {
    this.vitest = vitest;
  }

  // onTestRunStart sees every file; shard them the way Vitest's pool does.
  async onTestRunStart(specifications) {
    const { config } = this.vitest;
    const specs = config.shard
      ? await new config.sequence.sequencer(this.vitest).shard([...specifications])
      : specifications;
    write({
      planned: specs.map((spec) => ({ file: fileOf(spec.moduleId), project: spec.project.name })),
    });
  }

  onTestModuleEnd(testModule) {
    write({
      finished: {
        file: fileOf(testModule.moduleId),
        project: testModule.project.name,
        state: testModule.state(),
      },
    });
  }
}
