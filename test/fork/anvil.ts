import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Eip1193Provider } from "../../src/index.js";

export interface Anvil {
  url: string;
  provider: Eip1193Provider;
  snapshot(): Promise<string>;
  revert(id: string): Promise<void>;
  stop(): void;
}

export async function startAnvil(forkUrl: string): Promise<Anvil> {
  const port = await freePort();
  const child: ChildProcess = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const provider = httpProvider(url);

  for (let i = 0; ; i++) {
    try {
      await provider.request({ method: "eth_chainId" });
      break;
    } catch (error) {
      if (i > 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return {
    url,
    provider,
    snapshot: async () => (await provider.request({ method: "evm_snapshot" })) as string,
    revert: async id => {
      await provider.request({ method: "evm_revert", params: [id] });
    },
    stop: () => child.kill(),
  };
}

function httpProvider(url: string): Eip1193Provider {
  let id = 0;
  return {
    async request({ method, params }) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const body = (await response.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
      if (body.error) throw Object.assign(new Error(body.error.message), body.error);
      return body.result;
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("No port"));
      });
    });
  });
}
