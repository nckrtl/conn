// @effect-diagnostics nodeBuiltinImport:off -- The test runs a fake `ssh` and a TCP echo server with Node.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { openSshTunnel, sshTunnelArguments, type SshTunnelTarget } from "./sshTunnel.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-ssh-tunnel-"));

/** A stand-in for `ssh -N -L`: forwards the local port to the remote target, as a tunnel would. */
function fakeSsh(name: string, body: string): string {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, `#!${process.execPath}\nconst net = require("node:net");\n${body}\n`);
  NodeFS.chmodSync(path, 0o755);
  return path;
}

const forwarding = fakeSsh(
  "forward",
  `const spec = process.argv[process.argv.indexOf("-L") + 1].split(":");
const [, localPort, remoteHost, remotePort] = spec;
if (process.env.SSH_AUTH_SOCK !== "/tmp/vault-agent.sock") { process.stderr.write("wrong agent"); process.exit(1); }
net.createServer((client) => {
  const upstream = net.connect(Number(remotePort), remoteHost);
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(Number(localPort), "127.0.0.1");`,
);

const refused = fakeSsh(
  "refused",
  `process.stderr.write("forge@sfmain1: Permission denied (publickey).\\n"); process.exit(255);`,
);

const target: SshTunnelTarget = {
  host: "sfmain1",
  port: 2222,
  user: "forge",
  agent: "/tmp/vault-agent.sock",
  remoteHost: "127.0.0.1",
  remotePort: 3306,
};

describe("SSH tunnel", () => {
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("forwards a local port through Vault's agent, with the host after --", () => {
    expect(sshTunnelArguments(target, 50_000)).toEqual([
      "-N",
      "-T",
      "-L",
      "127.0.0.1:50000:127.0.0.1:3306",
      "-o",
      "IdentityAgent=SSH_AUTH_SOCK",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=30",
      "-p",
      "2222",
      "-l",
      "forge",
      "--",
      "sfmain1",
    ]);
    expect(
      sshTunnelArguments({ ...target, remoteHost: "::1", port: null, user: null }, 1).slice(3, 4),
    ).toEqual(["127.0.0.1:1:[::1]:3306"]);
  });

  it("refuses option-like or spaced values", () => {
    expect(() => sshTunnelArguments({ ...target, host: "-oProxyCommand=evil" }, 1)).toThrow(
      /not valid/,
    );
    expect(() => sshTunnelArguments({ ...target, user: "-l" }, 1)).toThrow(/not valid/);
    expect(() => sshTunnelArguments({ ...target, remoteHost: "a b" }, 1)).toThrow(/not valid/);
  });

  it("resolves once the local port carries traffic to the database", async () => {
    const echo = NodeNet.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as NodeNet.AddressInfo).port;

    const tunnel = await openSshTunnel({ ...target, remotePort: echoPort }, forwarding);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = NodeNet.connect(tunnel.localPort, "127.0.0.1", () => socket.write("ping"));
      socket.once("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.once("error", reject);
    });
    tunnel.close();
    echo.close();

    expect(reply).toBe("ping");
  });

  it("reports why SSH failed", async () => {
    await expect(openSshTunnel(target, refused)).rejects.toThrow(
      "SSH to sfmain1 failed: forge@sfmain1: Permission denied (publickey).",
    );
  });
});
