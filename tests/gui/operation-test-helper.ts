import { Schema } from "effect";
import { expect } from "vitest";
import { GuiOperation } from "../../src/gui/contract/operations.ts";

export async function waitForOperation(
  { id }: { readonly id: string },
  request: (path: string) => Promise<{ status: number | undefined; payload: unknown }>,
  timeout: number,
): Promise<typeof GuiOperation.Type> {
  let completed: typeof GuiOperation.Type | undefined;
  await expect.poll(async () => {
    const response = await request(`/api/operations/${id}`);
    expect(response.status, JSON.stringify(response.payload)).toBe(200);
    completed = Schema.decodeUnknownSync(GuiOperation)(response.payload);
    return completed.state;
  }, { timeout }).not.toBe("running");
  if (completed === undefined) throw new Error("Missing completed operation");
  return completed;
}
