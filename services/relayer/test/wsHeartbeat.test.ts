import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachWs } from "../src/indexer/http.js";

test("a client that never answers pings is terminated; a live one stays", async () => {
  const server = createServer();
  const hub = attachWs(server, { heartbeatMs: 100 });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const live = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const silent = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
  await Promise.all([live, silent].map((ws) => new Promise((r) => ws.once("open", r))));
  const silentClosed = new Promise((r) => silent.once("close", r));
  await silentClosed; // terminated after ~2 heartbeats
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(live.readyState, WebSocket.OPEN);
  assert.equal(hub.clientCount(), 1);
  live.close();
  hub.close();
  server.close();
});
