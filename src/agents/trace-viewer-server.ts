import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_HTML = join(dirname(fileURLToPath(import.meta.url)), "../../public/agent-trace.html");

/** Local debug UI for the LLM agent's reasoning trace. Started alongside the
 * agent harness — not part of the arena or fairness contract. */
export class TraceViewerServer {
  private server = createServer((req, res) => this.handle(req, res));

  constructor(
    private readonly getSession: () => unknown,
    private readonly port = Number(process.env.LLM_TRACE_PORT) || 8082,
  ) {}

  start(): void {
    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(`Reasoning viewer → http://127.0.0.1:${this.port}/`);
    });
    this.server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`Reasoning viewer: port ${this.port} in use — viewer disabled`);
      } else {
        console.error("Reasoning viewer error:", err.message);
      }
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url?.split("?")[0] ?? "/";
    if (url === "/api/session") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(this.getSession()));
      return;
    }
    if (url === "/" || url === "/index.html") {
      try {
        const html = readFileSync(VIEWER_HTML, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("agent-trace.html not found");
      }
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  }
}
