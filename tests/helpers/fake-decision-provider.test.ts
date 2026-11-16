/**
 * The fake SystemOne server's own contract: a client that gives up on a
 * request (an aborted fetch resets the connection) must never crash the
 * test process, because the fake writes its reply into a connection the
 * client already reset. A real request after that still gets its answer.
 */

import { afterEach, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";

import { startFakeSystemOne, type FakeSystemOne } from "./fake-decision-provider.ts";

let server: FakeSystemOne | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const BODY = JSON.stringify({ model: "m", questions: { q0: { type: "choice" } } });

function rawRequest(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = connect(port, "127.0.0.1", () => resolve(client));
    client.on("error", reject);
  });
}

test("a client that resets before the reply never leaks an error from the fake", async () => {
  server = await startFakeSystemOne();
  const port = Number(new URL(server.url).port);
  const client = await rawRequest(port);
  client.on("error", () => {});
  const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
  server.setReply(() => {
    // The client gives up while the fake is building its reply.
    client.resetAndDestroy();
    return { json: { model: "m", answers: {} } };
  });
  client.write(
    `POST /v1/systemone HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`,
  );
  await closed;
  server.setReply(() => ({ json: { model: "m", answers: {} } }));
  const response = await fetch(`${server.url}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: BODY,
  });
  expect(response.status).toBe(200);
  expect(server.requests.length).toBe(2);
});
