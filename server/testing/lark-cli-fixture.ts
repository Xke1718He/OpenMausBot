import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { findCliCandidates } from "../env-path.ts";
import { removeTempDir } from "./cleanup.ts";
import type { FeishuCliDownloadOptions } from "../feishu/cli-download.ts";

export class LarkCliFixture {
  private root = "";
  private readonly sockets = new Set<Socket>();
  private tls?: ReturnType<typeof httpsServer>;
  private proxy?: ReturnType<typeof httpServer>;
  options?: FeishuCliDownloadOptions;
  readonly requests: { method: string; path: string }[] = [];

  async listen(origin: string): Promise<void> {
    const cli = findCliCandidates("lark-cli")[0];
    if (!cli) throw new Error("Install lark-cli to run the isolated Feishu CLI fixture");
    this.root = mkdtempSync(join(tmpdir(), "omb-lark-cli-fixture-"));
    const key = join(this.root, "key.pem"), cert = join(this.root, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=open.feishu.cn", "-addext", "subjectAltName=DNS:open.feishu.cn,DNS:open.larksuite.com"], { stdio: "ignore" });
    chmodSync(key, 0o600); chmodSync(cert, 0o600);
    this.tls = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      this.requests.push({ method: req.method ?? "GET", path: req.url ?? "/" });
      const forwarded = request(new URL(req.url ?? "/", origin), { method: req.method, headers: req.headers }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.on("error", () => res.destroy()); upstream.pipe(res);
      });
      forwarded.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on("close", () => forwarded.destroy()); req.pipe(forwarded);
    });
    this.tls.on("connection", socket => this.track(socket));
    await new Promise<void>(resolve => this.tls!.listen(0, "127.0.0.1", resolve));
    const tlsPort = (this.tls.address() as AddressInfo).port;
    this.proxy = httpServer((_req, res) => res.writeHead(403).end());
    this.proxy.on("connect", (req, socket, head) => {
      if (!["open.feishu.cn:443", "open.larksuite.com:443"].includes(req.url ?? "")) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      const target = connect(tlsPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head);
        socket.pipe(target); target.pipe(socket);
      });
      this.track(target); target.on("error", () => socket.destroy()); socket.on("close", () => target.destroy());
    });
    this.proxy.on("connection", socket => this.track(socket));
    await new Promise<void>(resolve => this.proxy!.listen(0, "127.0.0.1", resolve));
    this.options = { cli, tempRoot: this.root, env: { PATH: process.env.PATH,
      LARKSUITE_CLI_PROXY_ENABLE: "true", LARKSUITE_CLI_PROXY_ADDRESS: `http://127.0.0.1:${(this.proxy.address() as AddressInfo).port}`, LARKSUITE_CLI_CA_PATH: cert } };
  }

  private track(socket: Socket): void { this.sockets.add(socket); socket.on("error", () => socket.destroy()); socket.on("close", () => this.sockets.delete(socket)); }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    for (const server of [this.proxy, this.tls]) if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (this.root) await removeTempDir(this.root);
  }
}
