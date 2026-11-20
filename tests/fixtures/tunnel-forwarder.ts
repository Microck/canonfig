import { chmod, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

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
require("node:fs").writeFileSync(${JSON.stringify(join(root, "ssh.pid"))}, String(process.pid));
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
