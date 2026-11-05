import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { CliCommandFailure } from "../src/cli/source-commands.ts";
import { GuiOperation } from "../src/gui/contract.ts";
import { makeGuiOperations } from "../src/gui/operations.ts";
import { mutationRoute, failureBody } from "../src/gui/routing.ts";

it("decodes real JSON request bodies before invoking an explicit operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonfig-gui-route-"));
  const path = join(directory, "saved");
  const route = mutationRoute("PUT", "/api/test", Schema.Struct({ value: Schema.String }), ({ value }) => Effect.tryPromise({
    try: async () => { await writeFile(path, value); return { saved: true }; },
    catch: () => new CliCommandFailure({ category: "verification-or-apply-failure", message: "The file could not be saved." }),
  }));
  const server = createServer((request, response) => {
    void Effect.runPromise(route.handle(request, new URL("http://127.0.0.1/api/test")).pipe(Effect.match({
      onSuccess: (body) => { response.writeHead(200); response.end(JSON.stringify(body)); },
      onFailure: (failure) => { response.writeHead(400); response.end(JSON.stringify(failureBody(failure.category, failure.message))); },
    })));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || Schema.is(Schema.String)(address)) throw new Error("No TCP listener");
    const url = `http://127.0.0.1:${address.port}/api/test`;
    for (const body of ['{"value":42}', '{"value":"bad","extra":true}', "not-json"]) {
      const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"value":"written"}' });
    expect(await response.json()).toEqual({ saved: true });
    expect(await readFile(path, "utf8")).toBe("written");
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});

it("polls actual journal bytes and retains the CLI failure without invented progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonfig-gui-operation-"));
  const path = join(directory, "journal.json");
  await writeFile(path, '{"step":"planned"}');
  try {
    await Effect.runPromise(Effect.gen(function*() {
      const manager = yield* makeGuiOperations;
      const continueApply = yield* Deferred.make<void>();
      const ticket = yield* manager.start(
        Deferred.await(continueApply).pipe(Effect.andThen(Effect.fail(new CliCommandFailure({ category: "human-action-required", message: "Approve this setup plan first." })))),
        () => Effect.tryPromise({
          try: async () => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
          catch: () => new CliCommandFailure({ category: "internal", message: "Journal unavailable." }),
        }),
      );
      // Route reads do not use the request for this GET endpoint.
      const incoming = new IncomingMessage(new Socket());
      const url = new URL(`http://127.0.0.1/api/operations/${ticket.id}`);
      const poll = () => manager.route.handle(incoming, url).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GuiOperation)));
      const running = yield* poll();
      expect(running).toEqual({ id: ticket.id, state: "running", journal: { step: "planned" } });
      yield* Effect.promise(() => writeFile(path, '{"step":"approval-required"}'));
      yield* Deferred.succeed(continueApply, undefined);
      let completed = yield* poll();
      while (completed.state === "running") { yield* Effect.yieldNow; completed = yield* poll(); }
      expect(completed).toEqual({ id: ticket.id, state: "failed", journal: { step: "approval-required" }, failure: { category: "human-action-required", exitCode: 3, message: "Approve this setup plan first." } });
      incoming.destroy();
    }).pipe(Effect.scoped));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
