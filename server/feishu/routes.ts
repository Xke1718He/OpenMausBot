import { PASS, type RouteHandler } from "../routes/table.ts";
import { connectionInputSchema } from "./connection-store.ts";
import { FeishuServiceError, type FeishuService } from "./service.ts";

export function createFeishuRoutes(service: FeishuService): RouteHandler {
  return async ({ path, method, auth, req, res, json, readBody }) => {
    if (path !== "/api/feishu") return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "An owner or admin must connect Feishu", code: "admin" });
    if (method === "GET") return json(res, 200, service.status());
    try {
      if (method === "DELETE") return json(res, 200, await service.disconnect());
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "Send connection details as JSON", code: "configuration" });
      const parsed = connectionInputSchema.safeParse(await readBody(req, 16_384));
      if (!parsed.success) return json(res, 400, { error: "Check the Feishu connection details", code: "configuration" });
      const owner = auth.kind === "session" ? { email: auth.session.email, userId: auth.session.userId } : {};
      return json(res, 200, await service.connect(parsed.data, owner));
    } catch (error) {
      const code = error instanceof FeishuServiceError ? error.code : "connection";
      return json(res, code === "busy" ? 409 : code === "blocked" ? 403 : code === "configuration" ? 400 : 502, { error: "Feishu could not connect. Check the app credentials, bot and allowed users, then try again.", code });
    }
  };
}
