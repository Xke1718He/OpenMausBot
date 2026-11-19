// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadLocale, setLocale } from "@/lib/i18n";
import type { FeishuConnectionStatus } from "../../shared/feishu";

const fixture = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { api: vi.fn() };
});
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { bots: [{ id: "bot-1", name: "MausBot" }] } }) }));
import { FeishuCard } from "./FeishuCard";

let host: HTMLDivElement;
let root: Root;
let status: FeishuConnectionStatus;
let refuse = false;
const configuration = { appId: "cli_0123456789abcdef", botId: "bot-1", domain: "feishu" as const, allowedUsers: ["ou_owner"], allowedChats: [] };
const settled = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const button = (label: string) => [...host.querySelectorAll("button")].find(element => element.textContent?.trim() === label || element.getAttribute("aria-label") === label)!;
const input = (name: string) => [...host.querySelectorAll("label")].find(element => element.textContent?.includes(name))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};
async function mount(initial: FeishuConnectionStatus = { state: "not-connected", saved: false, configuration: null }) {
  status = initial;
  await act(async () => root.render(createElement(FeishuCard)));
  await settled();
}
beforeEach(() => {
  setLocale("en"); refuse = false;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fixture.api.mockReset().mockImplementation(async (_path: string, options?: RequestInit) => {
    if (options?.method === "PUT") {
      if (refuse) throw Object.assign(new Error("private vendor details"), { body: { code: "connection" } });
      status = { state: "connected", saved: true, configuration };
    }
    if (options?.method === "DELETE") status = { state: "not-connected", saved: false, configuration: null };
    return status;
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLocale("en"); });

it("offers a Feishu connection and opens labelled setup fields", async () => {
  await mount();
  expect(host.textContent).toContain("Feishu / Lark");
  expect(host.querySelector("input")).toBeNull();
  await act(async () => button("Connect Feishu").click());
  expect(input("App secret").type).toBe("password");
  expect(host.querySelector("select")?.value).toBe("feishu");
  expect(host.textContent).toContain("Approvals stay in OpenMausBot");
});

it("submits the selected bot and parsed allowlists, then clears the secret", async () => {
  await mount(); await act(async () => button("Connect Feishu").click());
  await act(async () => {
    type(input("App ID"), configuration.appId); type(input("App secret"), "private-test-secret");
    type(input("Allowed user"), "ou_owner, ou_owner\nou_other"); type(input("Allowed group"), "oc_group");
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settled();
  const request = fixture.api.mock.calls.find(([, options]) => options?.method === "PUT")![1];
  expect(JSON.parse(request.body)).toEqual({ ...configuration, appSecret: "private-test-secret", allowedUsers: ["ou_owner", "ou_other"], allowedChats: ["oc_group"] });
  expect(host.textContent).toContain("Messages go to MausBot");
  expect(host.querySelector("form")).toBeNull();
  expect(host.innerHTML).not.toContain("private-test-secret");
});

it("shows a plain retryable error and keeps the setup form after refused credentials", async () => {
  await mount(); await act(async () => button("Connect Feishu").click());
  await act(async () => { type(input("App ID"), configuration.appId); type(input("App secret"), "wrong-key"); type(input("Allowed user"), "ou_owner"); });
  refuse = true;
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t connect to Feishu");
  expect(host.textContent).not.toContain("private vendor details");
  expect(button("Save and connect").disabled).toBe(false);
});

it("disconnects a saved connection through its own menu", async () => {
  await mount({ state: "connected", saved: true, configuration });
  await act(async () => button("Feishu options").click());
  await act(async () => document.querySelector<HTMLElement>('[data-menu-key="disconnect"]')!.click());
  await settled();
  expect(fixture.api).toHaveBeenCalledWith("/api/feishu", { method: "DELETE" });
  expect(button("Connect Feishu")).toBeTruthy();
});

it("renders the Chinese entry and explains unsupported workspaces without a Connect action", async () => {
  await loadLocale("zh");
  await mount({ state: "blocked", saved: false, configuration: null });
  expect(host.textContent).toContain("飞书 / Lark");
  expect(host.textContent).toContain("个人桌面及自托管工作区");
  expect(host.querySelector("form")).toBeNull();
});
