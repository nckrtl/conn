import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";

import {
  listOrbitInstances,
  listOrbitNodes,
  listOrbitProjects,
  OrbitApiError,
  type OrbitInstance,
  registerOrbitInstance,
} from "./orbitApi";
import { OrbitTransportError, type OrbitTransport, shellQuote } from "./orbitTransport";

/** Runs a short `sh` script on the environment's machine. */
export type HiddenShellRunner = (
  script: string,
  timeoutSeconds: number,
) => Promise<{ readonly exitCode: number; readonly output: string }>;

/** The Project's `default` Instance on this Node, whose repository new threads branch from. */
export interface OrbitCopySource {
  readonly instanceId: number;
  readonly instanceName: string;
  /** The `default` Instance's checkout: the repository new worktrees belong to. */
  readonly checkoutPath: string;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly nodeId: number;
  readonly nodeName: string;
  readonly tld: string;
  /** Orbit's folder for this Project's checkouts, e.g. `/fast/apps/orbit-website`. */
  readonly projectAppsPath: string;
}

/**
 * `hidden`: the repository has nothing to do with Orbit, so the option is not
 * shown. `available: false` with a reason: Orbit manages the repository but
 * cannot make an Instance for it on this machine.
 */
export type OrbitAvailability =
  | { readonly available: true; readonly hidden?: false; readonly source: OrbitCopySource }
  | { readonly available: false; readonly hidden?: false; readonly reason: string }
  | { readonly available: false; readonly hidden: true };

export const ORBIT_APP_DEV_ROLE = "app-dev";
const ORBIT_SOURCE_INSTANCE = "default";

const HIDDEN: OrbitAvailability = { available: false, hidden: true };

function unavailable(reason: string): OrbitAvailability {
  return { available: false, reason };
}

export function describeOrbitError(error: unknown): string {
  if (error instanceof OrbitApiError) {
    if (error.code === "peer.identity_unknown") return "This machine is not an Orbit Node";
    return `${error.message} (${error.code})`;
  }
  if (error instanceof OrbitTransportError) return error.message;
  return error instanceof Error ? error.message : "Orbit failed.";
}

/** `git@github.com:Owner/Repo.git` and `https://github.com/owner/repo` → `github.com/owner/repo`. */
export function normalizeRepositoryUrl(url: string): string | null {
  const trimmed = url.trim().toLowerCase();
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/*$/.exec(
    trimmed,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The project folder's `origin` URL and this machine's IPv4 addresses. */
export async function readOrbitLocalFacts(
  run: HiddenShellRunner,
  projectRoot: string,
): Promise<{ readonly remote: string | null; readonly addresses: ReadonlyArray<string> }> {
  const script = [
    `git -C ${shellQuote(projectRoot)} remote get-url origin 2>/dev/null || true`,
    "echo ---",
    "{ ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1; ifconfig 2>/dev/null | awk '$1 == \"inet\" {print $2}'; } | sort -u",
  ].join("\n");
  const { output } = await run(script, 20);
  const [remotePart = "", addressPart = ""] = output.split("---");
  return {
    remote: remotePart.trim() || null,
    addresses: addressPart.split(/\s+/).filter((address) => address !== ""),
  };
}

/**
 * The option is offered when the project's repository is an Orbit Project,
 * this machine is an app-dev Node, and the Project has an active `default`
 * Instance on it. Repositories Orbit does not manage hide the option.
 */
export async function checkOrbitAvailability(
  transport: OrbitTransport,
  run: HiddenShellRunner,
  projectRoot: string,
): Promise<OrbitAvailability> {
  let facts;
  let project;
  try {
    facts = await readOrbitLocalFacts(run, projectRoot);
  } catch (error) {
    // The hidden shell itself failed, so nothing is known about the
    // repository yet; say so instead of hiding the option as "not Orbit".
    return unavailable(`Could not check Orbit on this machine: ${describeOrbitError(error)}`);
  }
  const repository = facts.remote ? normalizeRepositoryUrl(facts.remote) : null;
  if (repository === null) return HIDDEN;
  try {
    const projects = await listOrbitProjects(transport);
    project = projects.find(
      (candidate) =>
        candidate.repositoryUrl !== null &&
        normalizeRepositoryUrl(candidate.repositoryUrl) === repository,
    );
  } catch (error) {
    // Orbit does not know this machine: there is no Orbit here.
    if (error instanceof OrbitApiError && error.code === "peer.identity_unknown") return HIDDEN;
    // Orbit unreachable, a broken response, or a failed shell: the repository
    // may well be an Orbit Project, so show the option with the reason.
    return unavailable(describeOrbitError(error));
  }
  if (!project) return HIDDEN;
  try {
    const [nodes, instances] = await Promise.all([
      listOrbitNodes(transport),
      listOrbitInstances(transport),
    ]);
    const node = nodes.find(
      (candidate) =>
        candidate.wireguardIp !== null && facts.addresses.includes(candidate.wireguardIp),
    );
    if (!node) return unavailable("This machine is not an Orbit Node");
    if (!node.roles.includes(ORBIT_APP_DEV_ROLE)) {
      return unavailable("This machine has no app-dev role");
    }
    const source = instances.find(
      (instance) =>
        instance.projectId === project.id &&
        instance.nodeId === node.id &&
        instance.name === ORBIT_SOURCE_INSTANCE,
    );
    if (!source || !source.checkoutPath) {
      return unavailable(`Orbit project ${project.slug} has no default instance on ${node.name}`);
    }
    if (source.status !== "active") {
      return unavailable(
        `The default instance of ${project.slug} on ${node.name} is ${source.status}`,
      );
    }
    if (!node.tld) return unavailable(`Orbit reports no domain suffix for ${node.name}`);
    // Registration moves a source into `<apps-root>/<project-slug>/<name>`;
    // a worktree created there stays put under the running agent.
    const projectAppsPath = node.appsPath
      ? `${node.appsPath.replace(/\/+$/, "")}/${project.slug}`
      : source.checkoutPath.replace(/\/[^/]+\/?$/, "");
    return {
      available: true,
      source: {
        instanceId: source.id,
        instanceName: source.name,
        checkoutPath: source.checkoutPath,
        projectId: project.id,
        projectSlug: project.slug,
        nodeId: node.id,
        nodeName: node.name,
        tld: node.tld,
        projectAppsPath,
      },
    };
  } catch (error) {
    return unavailable(describeOrbitError(error));
  }
}

/**
 * Create the thread's worktree of the project's repository directly in Orbit's
 * managed path, on a new branch from the freshly fetched base branch (the
 * local one when the fetch fails). Registration later adopts it where it is.
 */
export async function createOrbitWorktree(
  run: HiddenShellRunner,
  input: {
    readonly projectRoot: string;
    readonly baseBranch: string;
    readonly temporaryBranch: string;
    readonly worktreePath: string;
  },
): Promise<void> {
  const base = shellQuote(input.baseBranch);
  const script = [
    "set -e",
    `cd ${shellQuote(input.projectRoot)}`,
    // Git's detached auto-maintenance would hold the captured output open for seconds.
    `if git -c maintenance.auto=false fetch --quiet origin ${base}; then start=${shellQuote(`origin/${input.baseBranch}`)}; else start=${base}; fi`,
    `git -c maintenance.auto=false worktree add --quiet -b ${shellQuote(input.temporaryBranch)} ${shellQuote(input.worktreePath)} "$start"`,
    // T3 uses this as the pull request base; `git branch -m` carries it along.
    `git config ${shellQuote(`branch.${input.temporaryBranch}.gh-merge-base`)} ${base}`,
  ].join("\n");
  const result = await run(script, 120);
  if (result.exitCode !== 0) {
    const detail = result.output.trim().split("\n").at(-1) ?? "";
    throw new Error(`Could not create the worktree${detail ? `: ${detail}` : "."}`);
  }
}

/** `t3code/1a2b3c4d` → `t3code-1a2b3c4d`: the worktree folder and Orbit Instance name. */
export function orbitInstanceNameForBranch(temporaryBranch: string): string {
  return temporaryBranch.replace("/", "-");
}

/** `t3/login-redirect` (or legacy `t3code/…`) → `login-redirect`, as a DNS label; null while temporary. */
export function orbitRouteSlugForBranch(branch: string): string | null {
  if (isTemporaryWorktreeBranch(branch)) return null;
  const prefix = [`${WORKTREE_BRANCH_PREFIX}/`, "t3code/"].find((p) => branch.startsWith(p));
  const name = prefix ? branch.slice(prefix.length) : branch;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug === "" ? null : slug;
}

// Names a model sometimes returns instead of describing the work.
const PLACEHOLDER_ROUTE_SLUGS = new Set([
  "unknown",
  "update",
  "branch",
  "feature",
  "change",
  "task",
  "work",
  "new",
]);

function slugify(text: string, maxLength: number): string | null {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return null;
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > maxLength / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, "");
}

/**
 * The route's first label: T3's generated branch name, or the thread title
 * when the branch is still temporary or got a placeholder name such as
 * `t3code/unknown`, or else the Instance name.
 */
export function orbitRouteSlug(input: {
  readonly branch: string;
  readonly title: string | null;
  readonly instanceName: string;
}): string {
  const fromBranch = orbitRouteSlugForBranch(input.branch);
  if (fromBranch !== null && !PLACEHOLDER_ROUTE_SLUGS.has(fromBranch)) return fromBranch;
  const fromTitle = input.title ? slugify(input.title, 40) : null;
  if (fromTitle !== null && !PLACEHOLDER_ROUTE_SLUGS.has(fromTitle) && fromTitle !== "new-thread") {
    return fromTitle;
  }
  return fromBranch ?? input.instanceName;
}

export function orbitRouteDomain(input: {
  readonly slug: string;
  readonly projectSlug: string;
  readonly tld: string;
}): string {
  return `${input.slug}.${input.projectSlug}.${input.tld}`;
}

const ROUTE_SUFFIX_ATTEMPTS = 5;

/**
 * Hand the thread's worktree to Orbit. The route takes the slug of T3's
 * generated branch name, or the Instance name while the branch is still
 * temporary; a taken domain gets `-2`, `-3`, …
 */
export async function registerOrbitThreadWorktree(
  transport: OrbitTransport,
  input: {
    readonly worktreePath: string;
    readonly instanceName: string;
    readonly branch: string;
    readonly title: string | null;
    readonly projectId: number;
    readonly projectSlug: string;
    readonly tld: string;
  },
): Promise<OrbitInstance> {
  const slug = orbitRouteSlug(input);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? slug : `${slug.slice(0, 60)}-${attempt}`;
    try {
      return await registerOrbitInstance(transport, {
        sourcePath: input.worktreePath,
        projectId: input.projectId,
        instanceName: input.instanceName,
        domain: orbitRouteDomain({
          slug: candidate,
          projectSlug: input.projectSlug,
          tld: input.tld,
        }),
      });
    } catch (error) {
      const taken = error instanceof OrbitApiError && error.code === "route.domain_conflict";
      if (!taken || attempt === ROUTE_SUFFIX_ATTEMPTS) throw error;
    }
  }
}
