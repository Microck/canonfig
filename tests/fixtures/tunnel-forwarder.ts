import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fakeSshName = "fake-ssh";
const fakeSshPidName = "ssh.pid";

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
  const path = join(root, fakeSshName);
  await writeFile(
    path,
    `#!${process.execPath}
const net = require("node:net");
require("node:fs").writeFileSync(${JSON.stringify(join(root, fakeSshPidName))}, String(process.pid));
const args = process.argv.slice(2);
const [bind, localPort, remoteHost, remotePort] = args[args.indexOf("-L") + 1].split(":");
const server = net.createServer((client) => {
  const upstream = net.connect(Number(remotePort), remoteHost);
  client.pipe(upstream).pipe(client);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
server.listen(Number(localPort), bind);
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await chmod(path, 0o700);
  return path;
};

/** The Linux kernel adds the script path to Node's argv, so TunnelLive cannot stop this fixture as SSH. */
export const stopLinuxFakeSsh = async (root: string): Promise<void> => {
  try {
    const pid = Number(await readFile(join(root, fakeSshPidName), "utf8"));
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    // A fixture killed earlier in the test can leave a stale PID file.
    if (commandLine.split("\0")[1] !== join(root, fakeSshName)) return;
    process.kill(pid, "SIGTERM");
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      process.kill(pid, 0);
      await delay(10);
    }
    throw new Error(`The disposable SSH process ${pid} did not exit`);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return;
    throw error;
  }
};
