/**
 * What the package promises on its declared Node floor, checked against a real install of the packed
 * tarball rather than against the source tree.
 *
 * `npm run check` cannot be the test here: the build toolchain needs a newer Node than the package
 * does. tsdown loads `tsdown.config.ts` through Node's own type stripping, unflagged only from
 * 22.18.0, and falls back to an `unrun` import that is not installed; vitest declares ^22.12.0. So
 * the floor job installs what a consumer installs and exercises the two entry points that have to
 * work: the `maccabi` bin, and an MCP stdio session far enough to list tools.
 *
 * Usage: node scripts/smoke.mjs <path to the maccabi bin>
 */
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";

const bin = process.argv[2];
assert.ok(bin, "usage: node scripts/smoke.mjs <path to the maccabi bin>");

const version = await new Promise((resolve, reject) => {
  const child = spawn(bin, ["version"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.on("error", reject);
  child.on("close", code => { code === 0 ? resolve(out.trim()) : reject(new Error(`maccabi version exited ${code}`)); });
});
assert.match(version, /^maccabi \d+\.\d+\.\d+/, `unexpected version output: ${version}`);

const server = spawn(bin, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buffer = "";
server.stdout.on("data", chunk => {
  buffer += chunk;
  for (let newline; (newline = buffer.indexOf("\n")) !== -1; ) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  }
});
const send = message => { server.stdin.write(`${JSON.stringify(message)}\n`); };
const call = (id, method, params) => new Promise(resolve => { pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });

// A server that never answers would otherwise hang the job until the runner's own timeout.
const deadline = setTimeout(() => { server.kill(); throw new Error("the MCP handshake did not complete in 60s"); }, 60_000);
try {
  const initialized = await call(1, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "maccabi-floor-smoke", version: "0" },
  });
  assert.equal(initialized.error, undefined, `initialize failed: ${JSON.stringify(initialized.error)}`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await call(2, "tools/list", {});
  assert.equal(listed.error, undefined, `tools/list failed: ${JSON.stringify(listed.error)}`);
  const tools = listed.result?.tools ?? [];
  assert.ok(tools.length > 0, "tools/list returned no tools");
  process.stdout.write(`${version} on ${process.version}: ${initialized.result.serverInfo.name} served ${tools.length} tools\n`);
} finally {
  clearTimeout(deadline);
  server.kill();
}
