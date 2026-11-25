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
const input = (name: string) => [...host.querySelectorAll<HTMLInputElement>("input")].find(element => element.getAttribute("aria-label")?.includes(name))
  ?? [...host.querySelectorAll("label")].find(element => element.textContent?.includes(name))!.querySelector<HTMLInputElement>("input")!;
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
      const saved = JSON.parse(String(options.body));
      delete saved.appSecret;
      status = { state: "connected", saved: true, configuration: saved };
    }
    if (options?.method === "DELETE") status = { state: "not-connected", saved: false, configuration: null };
    return status;
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLocale("en"); });

it("saves, restores and clears a custom file download folder", async () => {
  await mount({ state: "connected", saved: true, configuration });
  const edit = async () => {
    await act(async () => button("Feishu options").click());
    await act(async () => document.querySelector<HTMLElement>('[data-menu-key="edit"]')!.click());
  };
  await edit();
  await act(async () => type(input("File download folder"), " ~/download "));
  await act(async () => button("Save and connect").click());
  expect(status.configuration?.downloadDirectory).toBe("~/download");
  await edit();
  expect(input("File download folder").value).toBe("~/download");
  await act(async () => type(input("File download folder"), " "));
  await act(async () => button("Save and connect").click());
  expect(status.configuration?.downloadDirectory).toBeUndefined();
});

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
    type(input("Allowed user"), "ou_owner，ou_owner;ou_other；ou_third、ou_fourth"); type(input("Allowed group"), "oc_group");
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settled();
  const request = fixture.api.mock.calls.find(([, options]) => options?.method === "PUT")![1];
  expect(JSON.parse(request.body)).toEqual({ ...configuration, appSecret: "private-test-secret", allowedUsers: ["ou_owner", "ou_other", "ou_third", "ou_fourth"], allowedChats: ["oc_group"], groupAccessByChat: { oc_group: "allowlist" } });
  expect(host.textContent).toContain("Messages go to MausBot");
  expect(host.querySelector("form")).toBeNull();
  expect(host.innerHTML).not.toContain("private-test-secret");
  await act(async () => button("Feishu options").click());
  await act(async () => document.querySelector<HTMLElement>('[data-menu-key="edit"]')!.click());
  expect([...host.querySelectorAll('[data-feishu-id-list="user"] [data-feishu-id]')].map(element => element.getAttribute("data-feishu-id")))
    .toEqual(["ou_owner", "ou_other", "ou_third", "ou_fourth"]);
  expect(input("Allowed user").value).toBe("");
});

it("saves and restores independent access switches for two groups without private users", async () => {
  await mount(); await act(async () => button("Connect Feishu").click());
  await act(async () => {
    type(input("App ID"), configuration.appId); type(input("App secret"), "private-test-secret");
    type(input("Allowed group"), "oc_group，oc_second");
  });
  await act(async () => button("Add group").click());
  expect(button("Save and connect").disabled).toBe(true);
  expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(button("Save and connect").disabled).toBe(false);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settled();
  const request = fixture.api.mock.calls.find(([, options]) => options?.method === "PUT")![1];
  expect(JSON.parse(request.body)).toMatchObject({ groupAccessByChat: { oc_group: "everyone", oc_second: "allowlist" }, allowedUsers: [], allowedChats: ["oc_group", "oc_second"] });
  expect(JSON.parse(request.body).groupAccess).toBeUndefined();
  await act(async () => button("Feishu options").click());
  await act(async () => document.querySelector<HTMLElement>('[data-menu-key="edit"]')!.click());
  expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector('[data-feishu-id="oc_second"] [role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(button("Save and connect").disabled).toBe(true);
});

it("adds IDs with Enter, deduplicates them, rejects invalid IDs and removes tags", async () => {
  await mount(); await act(async () => button("Connect Feishu").click());
  await act(async () => type(input("Allowed user"), "ou_owner，ou_owner;ou_other"));
  await act(async () => input("Allowed user").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(host.querySelectorAll('[data-feishu-id-list="user"] [data-feishu-id]')).toHaveLength(2);
  expect(input("Allowed user").value).toBe("");
  await act(async () => type(input("Allowed user"), "invalid-id"));
  await act(async () => button("Add user").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("beginning with ou_");
  expect(host.querySelectorAll('[data-feishu-id-list="user"] [data-feishu-id]')).toHaveLength(2);
  await act(async () => button("Remove ou_other").click());
  expect(host.querySelectorAll('[data-feishu-id-list="user"] [data-feishu-id]')).toHaveLength(1);
});

it("preserves configured group modes on edit and gives newly added groups allowlist access", async () => {
  await mount({ state: "connected", saved: true, configuration: { ...configuration, groupAccess: "everyone", allowedChats: ["oc_first", "oc_second"] } });
  await act(async () => button("Feishu options").click());
  await act(async () => document.querySelector<HTMLElement>('[data-menu-key="edit"]')!.click());
  expect([...host.querySelectorAll('[role="switch"]')].map(element => element.getAttribute("aria-checked"))).toEqual(["true", "true"]);
  await act(async () => type(input("Allowed group"), "oc_new"));
  await act(async () => button("Add group").click());
  expect(host.querySelector('[data-feishu-id="oc_new"] [role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => button("Remove oc_second").click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settled();
  const request = fixture.api.mock.calls.find(([, options]) => options?.method === "PUT")![1];
  expect(JSON.parse(request.body)).toMatchObject({ allowedChats: ["oc_first", "oc_new"], groupAccessByChat: { oc_first: "everyone", oc_new: "allowlist" } });
  expect(JSON.parse(request.body).groupAccess).toBeUndefined();
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

it("shows a saved-secret placeholder without sending it, and requires a new secret for another app", async () => {
  await mount({ state: "connected", saved: true, configuration });
  await act(async () => button("Feishu options").click());
  await act(async () => document.querySelector<HTMLElement>('[data-menu-key="edit"]')!.click());
  const secret = input("App secret");
  expect(secret.value).toBe("");
  expect(secret.placeholder).toBe("****************");
  expect(secret.required).toBe(false);
  expect(host.textContent).toContain("Saved. Leave empty to keep it");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settled();
  const request = fixture.api.mock.calls.find(([, options]) => options?.method === "PUT")![1];
  expect(JSON.parse(request.body).appSecret).toBeUndefined();
  expect(request.body).not.toContain("****************");
  await act(async () => button("Feishu options").click());
  await act(async () => document.querySelector<HTMLElement>('[data-menu-key="edit"]')!.click());
  await act(async () => type(input("App ID"), "cli_fedcba9876543210"));
  expect(input("App secret").placeholder).toBe("");
  expect(input("App secret").required).toBe(true);
  expect(button("Save and connect").disabled).toBe(true);
  await act(async () => type(input("App secret"), "replacement-secret"));
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
