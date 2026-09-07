import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input } from "../../src/contracts.ts";

const MAX_BUFFERED_BYTES = 1024 * 1024;

interface WireRequest {
  id: string;
  method?: string;
  params?: unknown;
}

function respond(request: WireRequest): object {
  if (request.method === "ping") {
    return { id: request.id, result: { type: "pong", version: "0.8.2", protocol: 20 } };
  }
  return { id: request.id, error: { code: "probe_only", message: "No real operation performed" } };
}

function handleConnection(socket: Socket, requests: Input[]): void {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    if (Buffer.byteLength(buffered, "utf8") > MAX_BUFFERED_BYTES) {
      socket.destroy();
      return;
    }
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        const request = JSON.parse(line) as WireRequest;
        requests.push(request as unknown as Input);
        socket.write(`${JSON.stringify(respond(request))}\n`);
      }
      newlineIndex = buffered.indexOf("\n");
    }
  });
}

export async function withFakeServer<T>(run: (socketPath: string, requests: Input[]) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ph-fake-server-"));
  const socketPath = join(dir, `${randomBytes(4).toString("hex")}.sock`);
  const requests: Input[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    handleConnection(socket, requests);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return await run(socketPath, requests);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
