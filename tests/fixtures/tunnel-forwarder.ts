import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fakeSshPidName = "ssh.pid";
const fakeSshShutdownName = "ssh.shutdown";

export const freePort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/**
 * A stand-in for OpenSSH that does what the tunnel relies on: it parses the
 * approved `-L bind:port:host:port`, listens on the local end, and forwards
 * each connection to the remote end, exactly like an authenticated `ssh -N`.
 */
export const fakeSsh = async (root: string): Promise<string> => {
  const path = join(root, "fake-ssh");
  await writeFile(
    path,
    `#!${process.execPath}
const net = require("node:net");
const fs = require("node:fs");
const args = process.argv.slice(2);
const [bind, localPort, remoteHost, remotePort] = args[args.indexOf("-L") + 1].split(":");
const server = net.createServer((client) => {
  const upstream = net.connect(Number(remotePort), remoteHost);
  client.pipe(upstream).pipe(client);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
const shutdownToken = require("node:crypto").randomUUID();
const shutdown = require("node:http").createServer((request, response) => {
  if (request.method === "POST" && request.url === "/" + shutdownToken) {
    response.writeHead(204).end(() => process.exit(0));
  } else {
    response.writeHead(404).end();
  }
});
shutdown.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(join(root, fakeSshShutdownName))}, shutdown.address().port + "/" + shutdownToken, { mode: 0o600 });
  fs.writeFileSync(${JSON.stringify(join(root, fakeSshPidName))}, String(process.pid));
  server.listen(Number(localPort), bind);
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await chmod(path, 0o700);
  return path;
};

const linuxStartTime = async (pid: number): Promise<string | undefined> => {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  // The command name can contain spaces and parentheses. Start time is field 22.
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};

/** Ask the fixture itself to exit. A stale PID can never receive a termination signal. */
export const stopFakeSsh = async (root: string): Promise<void> => {
  try {
    const pid = Number(await readFile(join(root, fakeSshPidName), "utf8"));
    const startTime = process.platform === "linux" ? await linuxStartTime(pid) : undefined;
    const endpoint = await readFile(join(root, fakeSshShutdownName), "utf8");
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (response.status !== 204) throw new Error(`The disposable SSH shutdown returned HTTP ${response.status}`);
    } catch (error) {
      // A previous launch can leave its endpoint on disk after it exits.
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED") return;
      throw error;
    }
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      if (startTime === undefined) process.kill(pid, 0);
      else if (await linuxStartTime(pid) !== startTime) return;
      await delay(10);
    }
    throw new Error(`The disposable SSH process ${pid} did not exit`);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return;
    throw error;
  }
};
