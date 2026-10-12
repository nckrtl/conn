// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The tunnel is a plain `ssh` child process with a readiness deadline, outside any Effect fiber.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

// An SSH tunnel for the Database panel. It runs this Mac's own `ssh`, so `~/.ssh/config` aliases
// and `known_hosts` apply, and authenticates with Vault's SSH agent, which holds the keys and asks
// for Touch ID while Vault is locked. Conn stores no SSH key. The tunnel lives as long as the
// database connection that uses it.

export interface SshTunnelTarget {
  /** An `~/.ssh/config` alias or address. */
  readonly host: string;
  readonly port: number | null;
  readonly user: string | null;
  /** Vault's SSH agent socket. */
  readonly agent: string;
  /** The database as the SSH server reaches it. */
  readonly remoteHost: string;
  readonly remotePort: number;
}

export interface SshTunnel {
  readonly localPort: number;
  readonly close: () => void;
}

const READY_TIMEOUT_MS = 20_000;

/** Values that reach `ssh` as arguments: never option-like, never with whitespace. */
function assertWord(value: string, label: string): void {
  if (value === "" || value.startsWith("-") || /[\s\0]/.test(value)) {
    throw new Error(`The SSH ${label} of this connection is not valid.`);
  }
}

/** The `ssh` arguments for one forward. Exported for tests. */
export function sshTunnelArguments(target: SshTunnelTarget, localPort: number): string[] {
  assertWord(target.host, "host");
  if (target.user !== null) assertWord(target.user, "user");
  assertWord(target.remoteHost, "database host");
  const remoteHost = target.remoteHost.includes(":") ? `[${target.remoteHost}]` : target.remoteHost;
  return [
    "-N",
    "-T",
    "-L",
    `127.0.0.1:${localPort}:${remoteHost}:${target.remotePort}`,
    "-o",
    // The socket path has spaces (`Group Containers`), which `-o` would split; the path goes
    // through the environment instead.
    "IdentityAgent=SSH_AUTH_SOCK",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    // A server seen for the first time is remembered, as TablePlus does; a changed key still fails.
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
    ...(target.user !== null ? ["-l", target.user] : []),
    "--",
    target.host,
  ];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free local port for the SSH tunnel.")),
      );
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Opens the tunnel and resolves once its local port accepts connections. */
export async function openSshTunnel(
  target: SshTunnelTarget,
  sshBinary = "/usr/bin/ssh",
): Promise<SshTunnel> {
  const localPort = await freePort();
  const child = NodeChildProcess.spawn(sshBinary, sshTunnelArguments(target, localPort), {
    env: { ...process.env, SSH_AUTH_SOCK: target.agent },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
  });
  let exited: string | null = null;
  child.once("exit", (code, signal) => {
    exited = signal ? `signal ${signal}` : `exit code ${code}`;
  });
  child.once("error", (error) => {
    exited = error.message;
  });
  const close = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };

  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (exited !== null) {
      const reason = stderr.trim().split("\n").findLast(Boolean);
      // Point at Vault only when the key login itself failed.
      const keyProblem = /permission denied|publickey|agent/i.test(stderr);
      throw new Error(
        `SSH to ${target.host} failed${reason ? `: ${reason}` : ` (${exited})`}${keyProblem ? ". Check that Vault is unlocked and holds the server's key." : ""}`,
      );
    }
    if (await accepts(localPort)) return { localPort, close };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  close();
  throw new Error(`SSH to ${target.host} did not open the tunnel within 20 seconds.`);
}
