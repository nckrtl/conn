// @effect-diagnostics nodeBuiltinImport:off - runs the generated shell scripts with real sh, git and curl.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { OrbitApiError } from "./orbitApi";
import {
  checkOrbitAvailability,
  createOrbitWorktree,
  type HiddenShellRunner,
  normalizeRepositoryUrl,
  orbitInstanceNameForBranch,
  readOrbitLocalFacts,
  orbitRouteSlug,
  orbitRouteSlugForBranch,
  registerOrbitThreadWorktree,
} from "./orbitInstances";
import { isOrbitCheckout } from "./orbitThreadStore";
import {
  buildHiddenShellLine,
  buildOrbitCurlScript,
  buildOrbitRequestUrl,
  type OrbitHttpRequest,
  type OrbitTransport,
  OrbitTransportError,
  parseHiddenShellOutput,
  parseOrbitCurlOutput,
} from "./orbitTransport";

const SOURCE_INSTANCE = {
  id: 4,
  project_id: 33,
  node_id: 9,
  project: { id: 33, name: "Orbit Website", slug: "orbit-website", type: "laravel-app" },
  node: { id: 9, name: "beast" },
  name: "default",
  checkout_path: "/fast/apps/orbit-website/default",
  selected_branch: "main",
  branch_override: null,
  status: "active",
  route: { id: 14, domain: "orbit-website.test" },
  domain: "orbit-website.test",
  url: "https://orbit-website.test",
};

const BEAST = {
  id: 9,
  name: "beast",
  roles: ["router", "app-dev"],
  tld: "test",
  settings: { apps: { path: "/fast/apps" } },
};

function fakeTransport(
  handle: (request: OrbitHttpRequest) => { status: number; body: unknown },
): OrbitTransport & { readonly requests: OrbitHttpRequest[] } {
  const requests: OrbitHttpRequest[] = [];
  const transport = async (request: OrbitHttpRequest) => {
    requests.push(request);
    return handle(request);
  };
  return Object.assign(transport, { requests });
}

const ok = (data: unknown) => ({ status: 200, body: { data } });
const fail = (status: number, code: string, message = code) => ({
  status,
  body: { error: { code, message, details: {} } },
});

// Keep the developer's git config (signing, hooks) out of the temporary repositories.
// Auto-maintenance runs detached and would hold the captured output open for seconds.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
};

/** Runs a hidden-shell line the way the terminal does, through a real `sh`. */
function runLine(line: string): Promise<string> {
  const command = line.replace(/; exit\r$/, "").trim();
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile("sh", ["-c", command], { env: GIT_ENV }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/** A HiddenShellRunner backed by a real `sh`, through the same line and parser. */
const realShell: HiddenShellRunner = async (script) => {
  const output = await runLine(buildHiddenShellLine({ requestId: "t1", script }));
  const parsed = parseHiddenShellOutput(output, "t1");
  if (parsed._tag !== "done") throw new Error(`shell output: ${parsed._tag}`);
  return parsed;
};

function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

describe("Orbit names", () => {
  it("names the worktree folder and Instance after the temporary branch", () => {
    expect(orbitInstanceNameForBranch("t3code/1a2b3c4d")).toBe("t3code-1a2b3c4d");
  });

  it("derives the route slug from T3's generated branch", () => {
    expect(orbitRouteSlugForBranch("t3/login-redirect")).toBe("login-redirect");
    expect(orbitRouteSlugForBranch("t3code/login-redirect")).toBe("login-redirect");
    expect(orbitRouteSlugForBranch("t3code/Fix_Login Redirect!")).toBe("fix-login-redirect");
    expect(orbitRouteSlugForBranch(`t3code/${"a".repeat(80)}`)).toHaveLength(63);
  });

  it("has no route slug while the branch is still temporary", () => {
    expect(orbitRouteSlugForBranch("t3code/1a2b3c4d")).toBeNull();
    expect(orbitRouteSlugForBranch("t3code/---")).toBeNull();
  });
});

describe("orbitRouteSlug", () => {
  const instanceName = "t3code-1a2b3c4d";

  it("prefers T3's generated branch name", () => {
    expect(orbitRouteSlug({ branch: "t3code/login-redirect", title: "Fix it", instanceName })).toBe(
      "login-redirect",
    );
  });

  it("falls back to the thread title for a placeholder branch name", () => {
    expect(
      orbitRouteSlug({
        branch: "t3code/unknown",
        title: "Print Working Directory and Branch",
        instanceName,
      }),
    ).toBe("print-working-directory-and-branch");
    expect(
      orbitRouteSlug({
        branch: "t3code/1a2b3c4d",
        title: "Fix the login redirect after a session times out",
        instanceName,
      }),
    ).toBe("fix-the-login-redirect-after-a-session");
  });

  it("keeps the branch or Instance name when the title does not help", () => {
    expect(orbitRouteSlug({ branch: "t3code/unknown", title: "New thread", instanceName })).toBe(
      "unknown",
    );
    expect(orbitRouteSlug({ branch: "t3code/1a2b3c4d", title: null, instanceName })).toBe(
      instanceName,
    );
  });
});

describe("isOrbitCheckout", () => {
  it("recognizes worktrees made for Orbit, even unregistered", () => {
    expect(isOrbitCheckout("env", "/fast/apps/dlf/t3code-1a2b3c4d")).toBe(true);
    expect(isOrbitCheckout("env", "/fast/apps/dlf/t3code-1a2b3c4d/")).toBe(true);
  });

  it("leaves T3's own worktrees and other folders alone", () => {
    expect(isOrbitCheckout("env", "/home/nick/.t3/worktrees/orbit/t3code-1a2b3c4d")).toBe(false);
    expect(isOrbitCheckout("env", "/fast/apps/dlf/main")).toBe(false);
    expect(isOrbitCheckout("env", null)).toBe(false);
  });
});

describe("normalizeRepositoryUrl", () => {
  it("matches the HTTPS, SSH and scp forms of one repository", () => {
    for (const url of [
      "https://github.com/nckrtl/orbit-website.git",
      "https://github.com/nckrtl/orbit-website",
      "git@github.com:nckrtl/orbit-website.git",
      "ssh://git@github.com/NCKRTL/orbit-website.git/",
    ]) {
      expect(normalizeRepositoryUrl(url)).toBe("github.com/nckrtl/orbit-website");
    }
    expect(normalizeRepositoryUrl("")).toBeNull();
  });
});

describe("checkOrbitAvailability", () => {
  const PROJECTS = [
    {
      id: 33,
      slug: "orbit-website",
      repository_url: "https://github.com/nckrtl/orbit-website.git",
    },
    { id: 46, slug: "orbit", repository_url: "https://github.com/nckrtl/orbit.git" },
  ];
  const DEFAULT_INSTANCE = {
    id: 4,
    name: "default",
    project_id: 33,
    node_id: 9,
    status: "active",
    checkout_path: "/fast/apps/orbit-website/default",
  };
  const BEAST_NODE = { ...BEAST, wireguard_ip: "10.44.0.7" };
  const shell =
    (remote: string, addresses = "127.0.0.1\n10.44.0.7"): HiddenShellRunner =>
    async () => ({ exitCode: 0, output: `${remote}\n---\n${addresses}` });
  const orbit = (overrides: { nodes?: unknown[]; instances?: unknown[] } = {}) =>
    fakeTransport((request) => {
      if (request.path === "/api/v1/projects") return ok(PROJECTS);
      if (request.path === "/api/v1/nodes") return ok(overrides.nodes ?? [BEAST_NODE]);
      if (request.path === "/api/v1/instances")
        return ok(overrides.instances ?? [DEFAULT_INSTANCE]);
      throw new Error(`unexpected ${request.path}`);
    });

  it("offers worktrees of the Project's default Instance on this machine", async () => {
    await expect(
      checkOrbitAvailability(
        orbit(),
        shell("git@github.com:nckrtl/orbit-website.git"),
        "/home/nick/projects/orbit-website",
      ),
    ).resolves.toEqual({
      available: true,
      source: {
        instanceId: 4,
        instanceName: "default",
        checkoutPath: "/fast/apps/orbit-website/default",
        projectId: 33,
        projectSlug: "orbit-website",
        nodeId: 9,
        nodeName: "beast",
        tld: "test",
        projectAppsPath: "/fast/apps/orbit-website",
      },
    });
  });

  it("hides the option for repositories Orbit does not manage", async () => {
    await expect(
      checkOrbitAvailability(orbit(), shell("https://github.com/someone/else.git"), "/x"),
    ).resolves.toEqual({ available: false, hidden: true });
    await expect(checkOrbitAvailability(orbit(), shell(""), "/x")).resolves.toEqual({
      available: false,
      hidden: true,
    });
    const offline = fakeTransport(() => fail(403, "peer.identity_unknown"));
    await expect(
      checkOrbitAvailability(offline, shell("https://github.com/nckrtl/orbit.git"), "/x"),
    ).resolves.toEqual({ available: false, hidden: true });
  });

  it("explains a failed check instead of hiding the option", async () => {
    const remote = shell("https://github.com/nckrtl/orbit.git");
    const unreachable = fakeTransport(() => {
      throw new OrbitTransportError("Orbit is not reachable from this machine: timeout");
    });
    await expect(checkOrbitAvailability(unreachable, remote, "/x")).resolves.toEqual({
      available: false,
      reason: "Orbit is not reachable from this machine: timeout",
    });
    const broken = fakeTransport(() => ok({ not: "a list" }));
    await expect(checkOrbitAvailability(broken, remote, "/x")).resolves.toEqual({
      available: false,
      reason: "Orbit sent an invalid list. (orbit.response_invalid)",
    });
    const noShell: HiddenShellRunner = async () => {
      throw new OrbitTransportError("Could not open a shell on this machine.");
    };
    await expect(checkOrbitAvailability(orbit(), noShell, "/x")).resolves.toEqual({
      available: false,
      reason: "Could not check Orbit on this machine: Could not open a shell on this machine.",
    });
  });

  it("explains a Project without a default Instance on this machine", async () => {
    await expect(
      checkOrbitAvailability(
        orbit(),
        shell("https://github.com/nckrtl/orbit.git"),
        "/home/nick/orbit",
      ),
    ).resolves.toEqual({
      available: false,
      reason: "Orbit project orbit has no default instance on beast",
    });
  });

  it("explains a machine that is not an app-dev Node", async () => {
    await expect(
      checkOrbitAvailability(
        orbit({ nodes: [{ ...BEAST_NODE, roles: ["router"] }] }),
        shell("https://github.com/nckrtl/orbit-website"),
        "/x",
      ),
    ).resolves.toEqual({ available: false, reason: "This machine has no app-dev role" });
    await expect(
      checkOrbitAvailability(
        orbit(),
        shell("https://github.com/nckrtl/orbit-website", "127.0.0.1\n10.44.0.6"),
        "/x",
      ),
    ).resolves.toEqual({ available: false, reason: "This machine is not an Orbit Node" });
  });
});

describe("registerOrbitThreadWorktree", () => {
  const input = {
    worktreePath: "/fast/apps/orbit-website/t3code-1a2b3c4d",
    instanceName: "t3code-1a2b3c4d",
    projectId: 33,
    projectSlug: "orbit-website",
    tld: "test",
  };
  const registered = (domain: string) =>
    ok({
      status: "active",
      instance: {
        ...SOURCE_INSTANCE,
        id: 300,
        name: "t3code-1a2b3c4d",
        checkout_path: input.worktreePath,
        selected_branch: "t3code/login-redirect",
        domain,
        url: `https://${domain}`,
      },
    });

  it("registers the worktree with setup and the readable route", async () => {
    const transport = fakeTransport((request) =>
      registered((request.body as { domain: string }).domain),
    );
    const instance = await registerOrbitThreadWorktree(transport, {
      ...input,
      branch: "t3code/login-redirect",
      title: null,
    });
    expect(transport.requests[0]).toEqual({
      method: "POST",
      path: "/api/v1/instances/register",
      body: {
        source_path: "/fast/apps/orbit-website/t3code-1a2b3c4d",
        project_id: 33,
        instance_name: "t3code-1a2b3c4d",
        domain: "login-redirect.orbit-website.test",
        setup: true,
      },
      timeoutSeconds: 1800,
    });
    expect(instance).toMatchObject({ id: 300, url: "https://login-redirect.orbit-website.test" });
  });

  it("routes under the Instance name while the branch is still temporary", async () => {
    const transport = fakeTransport((request) =>
      registered((request.body as { domain: string }).domain),
    );
    await registerOrbitThreadWorktree(transport, {
      ...input,
      branch: "t3code/1a2b3c4d",
      title: null,
    });
    expect(transport.requests[0]?.body).toMatchObject({
      domain: "t3code-1a2b3c4d.orbit-website.test",
    });
  });

  it("adds a suffix when the route domain is taken", async () => {
    const transport = fakeTransport((request) => {
      const domain = (request.body as { domain: string }).domain;
      return domain === "login-redirect.orbit-website.test"
        ? fail(422, "route.domain_conflict")
        : registered(domain);
    });
    const instance = await registerOrbitThreadWorktree(transport, {
      ...input,
      branch: "t3code/login-redirect",
      title: null,
    });
    expect(instance.url).toBe("https://login-redirect-2.orbit-website.test");
  });

  it("does not retry other refusals", async () => {
    const transport = fakeTransport(() => fail(422, "instance.project_missing"));
    await expect(
      registerOrbitThreadWorktree(transport, {
        ...input,
        branch: "t3code/login-redirect",
        title: null,
      }),
    ).rejects.toBeInstanceOf(OrbitApiError);
    expect(transport.requests).toHaveLength(1);
  });
});

// Creating a branch takes about 5 s on some macOS machines; the worktree tests need room.
describe("createOrbitWorktree", { timeout: 60_000 }, () => {
  let root: string;
  let origin: string;
  let source: string;

  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "orbit-worktree-"));
    origin = NodePath.join(root, "origin");
    source = NodePath.join(root, "apps", "site", "default");
    const commit = (cwd: string, message: string) =>
      git(
        cwd,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
      );
    git(root, "init", "--quiet", "--initial-branch=main", origin);
    commit(origin, "one");
    NodeFS.mkdirSync(NodePath.dirname(source), { recursive: true });
    git(root, "clone", "--quiet", origin, source);
    // A newer commit on origin that the source's local `main` does not have yet.
    commit(origin, "two");
  });

  afterAll(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("creates the worktree in the apps folder from the fetched base branch", async () => {
    const worktreePath = NodePath.join(NodePath.dirname(source), "t3code-1a2b3c4d");
    await createOrbitWorktree(realShell, {
      projectRoot: source,
      baseBranch: "main",
      temporaryBranch: "t3code/1a2b3c4d",
      worktreePath,
    });
    expect(git(worktreePath, "branch", "--show-current")).toBe("t3code/1a2b3c4d");
    expect(git(worktreePath, "log", "-1", "--format=%s")).toBe("two");
    expect(git(source, "config", "branch.t3code/1a2b3c4d.gh-merge-base")).toBe("main");
    expect(NodeFS.readFileSync(NodePath.join(worktreePath, ".git"), "utf8")).toContain("gitdir:");
  });

  it("reads the project's origin and this machine's addresses", async () => {
    const facts = await readOrbitLocalFacts(realShell, source);
    expect(facts.remote).toBe(origin);
    expect(facts.addresses).toContain("127.0.0.1");
  });

  it("reports why git refused", async () => {
    await expect(
      createOrbitWorktree(realShell, {
        projectRoot: source,
        baseBranch: "main",
        temporaryBranch: "t3code/1a2b3c4d",
        worktreePath: NodePath.join(NodePath.dirname(source), "t3code-again"),
      }),
    ).rejects.toThrow(/Could not create the worktree: .*already exists/);
  });
});

describe("hidden shell transport", () => {
  let server: NodeHttp.Server;
  let gatewayUrl: string;
  const received: Array<{ method: string; url: string; body: string; type: string | null }> = [];

  beforeAll(async () => {
    server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body,
          type: request.headers["content-type"] ?? null,
        });
        if (request.url?.startsWith("/api/v1/missing")) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "http.404", message: "Not found" } }));
          return;
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { echoed: body ? JSON.parse(body) : null } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function call(gateway: string, request: OrbitHttpRequest) {
    const result = await realShell(
      buildOrbitCurlScript(buildOrbitRequestUrl(gateway, request), request),
      60,
    );
    return parseOrbitCurlOutput(result.exitCode, result.output);
  }

  it("never echoes a complete marker and prefers the system curl", () => {
    const line = buildHiddenShellLine({ requestId: "abc123", script: "echo hi" });
    expect(line).not.toContain("__T3ORBIT_abc123_BEGIN__");
    expect(
      buildOrbitCurlScript("https://gateway.orbit/x", { method: "GET", path: "/x" }),
    ).toContain("k=/usr/bin/curl");
  });

  it("round-trips a JSON request through curl and the markers", async () => {
    const body = { name: "t3code-1a2b3c4d", note: "quotes ' \" and $HOME stay literal ✓" };
    await expect(
      call(gatewayUrl, { method: "POST", path: "/api/v1/instances", body }),
    ).resolves.toEqual({
      status: 201,
      body: { data: { echoed: body } },
    });
    expect(received.at(-1)).toMatchObject({ method: "POST", type: "application/json" });
  });

  it("passes query strings and reports HTTP errors", async () => {
    await expect(
      call(gatewayUrl, {
        method: "GET",
        path: "/api/v1/missing",
        query: { directory: "/fast/apps/dlf/main" },
      }),
    ).resolves.toEqual({
      status: 404,
      body: { error: { code: "http.404", message: "Not found" } },
    });
    expect(received.at(-1)?.url).toBe("/api/v1/missing?directory=%2Ffast%2Fapps%2Fdlf%2Fmain");
  });

  it("reports an unreachable Gateway", async () => {
    await expect(
      call("http://127.0.0.1:9", { method: "GET", path: "/api/v1/nodes/9" }),
    ).rejects.toThrow(/not reachable from this machine/);
  });

  it("returns a failing script's exit code and output", async () => {
    await expect(realShell("echo nope; exit 3", 10)).resolves.toEqual({
      _tag: "done",
      exitCode: 3,
      output: "nope",
    });
  });

  it("waits until both markers arrived", () => {
    expect(parseHiddenShellOutput("noise __T3ORBIT_x_BEGIN__\r\nMA==", "x")).toEqual({
      _tag: "pending",
    });
  });
});
