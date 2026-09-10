import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";

export async function acquireLifeLock(stateDir) {
  const identity = normalizedIdentity(stateDir);
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = lifeLockPort(stateDir, attempt);
    const server = createServer((socket) => socket.end(`${identity}\n`));
    server.unref();
    try {
      await listen(server, port);
    } catch (error) {
      server.close();
      if (error.code !== "EADDRINUSE") throw error;
      if (await readOccupant(port) === identity) {
        throw new Error(`Revo identity is already awake for state directory: ${stateDir}`);
      }
      continue;
    }
    let released = false;
    return {
      port,
      release: () => new Promise((resolveClose) => {
        if (released) return resolveClose();
        released = true;
        server.close(resolveClose);
      }),
    };
  }
  throw new Error(`Cannot reserve a local life lock for state directory: ${stateDir}`);
}

export function lifeLockPort(stateDir, attempt = 0) {
  const identity = normalizedIdentity(stateDir);
  const digest = createHash("sha256").update(`${identity}:${attempt}`).digest();
  return 20_000 + digest.readUInt16BE(0) % 30_000;
}

function normalizedIdentity(stateDir) {
  const path = resolve(stateDir);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function readOccupant(port) {
  return new Promise((resolveRead) => {
    const socket = connect(port, "127.0.0.1");
    let value = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveRead(value.trim());
    };
    socket.setEncoding("utf8");
    socket.setTimeout(500, finish);
    socket.on("data", (chunk) => { value += chunk; });
    socket.on("end", finish);
    socket.on("error", finish);
  });
}
