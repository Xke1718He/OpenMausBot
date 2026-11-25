import type { ChatMessage, ChatTaskControl } from "../messaging/contracts.ts";
import { ChatBridge } from "../messaging/bridge.ts";
import { OpenMausBotChatRuntime } from "../messaging/openmausbot.ts";
import { chatHash, chatRoute, ChatState } from "../messaging/state.ts";
import { BOT_PAGE_SIZE, feishuBotCard, type FeishuBotAction, type FeishuBotActionResult } from "./bot-card.ts";
import { FeishuBotRoutingState, type FeishuBotMenu } from "./bot-routing-state.ts";
import type { FeishuTransport } from "./transport.ts";

const selectionRoute = (message: ChatMessage) => chatHash([chatRoute(message), message.senderId]);
interface FeishuBotRouterOptions {
  runtime: OpenMausBotChatRuntime; defaultBotId: string; transport: FeishuTransport;
  statePath: string; scope: string; allowed: (message: ChatMessage) => boolean; log?: (message: string) => void;
}
export class FeishuBotRouter {
  private readonly routing: FeishuBotRoutingState;
  private readonly bridges = new Map<string, { bridge: ChatBridge; state: ChatState }>();
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly options: FeishuBotRouterOptions;

  constructor(options: FeishuBotRouterOptions) {
    this.options = options;
    this.routing = new FeishuBotRoutingState(`${options.statePath}.bots.json`, options.scope);
    this.forBot(options.defaultBotId);
    for (const botId of this.routing.data.botIds) this.forBot(botId);
  }

  hasRoute(message: ChatMessage): boolean {
    return [...this.bridges.values()].some(item => item.state.hasRoute(message)) ||
      Object.hasOwn(this.routing.data.selections, selectionRoute(message)) ||
      this.routing.data.menus.some(menu => menu.route === selectionRoute(message) && menu.expiresAt > Date.now());
  }

  accept(message: ChatMessage): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new Error("Feishu router is closing");
      if (!this.options.allowed(message)) return;
      if (message.text === "/bot" && !message.attachments?.length) { await this.showBots(message); return; }
      if ([...this.bridges.values()].some(({ state }) => state.jobs.some(job => job.message.id === message.id || job.relatedMessageIds?.includes(message.id)))) return;
      const botId = this.routing.data.selections[selectionRoute(message)] ?? this.options.defaultBotId;
      const result = this.forBot(botId).bridge.accept(message);
      if (result === "full" || result === "closed") throw new Error("Feishu queue is unavailable");
    });
  }

  control(input: ChatTaskControl): "accepted" | "refused" {
    if (this.closed) return "refused";
    for (const { bridge } of this.bridges.values()) if (bridge.control(input) === "accepted") return "accepted";
    return "refused";
  }

  select(input: FeishuBotAction): Promise<FeishuBotActionResult | null> {
    return this.serialize(async () => {
      const menu = this.routing.data.menus.find(item => item.id === input.menuId);
      if (!menu || !this.menuAllowed(menu, input)) return null;
      const current = this.routing.data.selections[menu.route] ?? this.options.defaultBotId;
      if (input.action === "bot_page") {
        if (input.page >= Math.ceil(menu.bots.length / BOT_PAGE_SIZE)) return null;
        return { text: "已更新 bot 列表。", card: feishuBotCard(menu.id, menu.bots, current, input.page) };
      }
      if (!menu.bots.some(bot => bot.id === input.botId)) return null;
      const bots = await this.options.runtime.listBots();
      const bot = bots.find(item => item.id === input.botId);
      if (!bot || !this.menuAllowed(menu, input)) return null;
      this.forBot(bot.id);
      this.routing.update(() => { this.routing.data.selections[menu.route] = bot.id; menu.selected = true; });
      return { text: `已切换到 ${bot.name}。`, card: feishuBotCard(menu.id, bots, bot.id, 0, true) };
    });
  }

  async tick(): Promise<void> {
    for (const { bridge } of this.bridges.values()) await bridge.tick();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending.catch(() => {});
    await Promise.all([...this.bridges.values()].map(({ bridge }) => bridge.close()));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private menuAllowed(menu: FeishuBotMenu, input: FeishuBotAction): boolean {
    return !this.closed && !menu.selected && menu.expiresAt > Date.now() && menu.senderId === input.senderId &&
      menu.chatId === input.chatId && menu.messageId === input.messageId &&
      this.routing.data.menus.findLast(item => item.route === menu.route)?.id === menu.id &&
      this.options.allowed({ platform: "feishu", account: "", id: "", text: "", kind: menu.kind, chatId: menu.chatId, senderId: menu.senderId });
  }

  private forBot(botId: string) {
    const existing = this.bridges.get(botId);
    if (existing) return existing;
    const { statePath, scope, defaultBotId, runtime, transport, allowed, log } = this.options;
    const botScope = botId === defaultBotId ? scope : chatHash([scope, botId]);
    const path = botId === defaultBotId ? statePath : `${statePath}.${chatHash([botId]).slice(0, 16)}`;
    const state = new ChatState(path, botScope);
    const bridge = new ChatBridge({ runtime: runtime.forBot(botId), delivery: transport, state, allowed, log });
    if (!this.routing.data.botIds.includes(botId)) this.routing.update(() => { this.routing.data.botIds.push(botId); });
    const item = { bridge, state };
    this.bridges.set(botId, item);
    return item;
  }

  private async showBots(message: ChatMessage): Promise<void> {
    const id = chatHash([this.options.scope, "bot-menu", message.id]);
    let menu = this.routing.data.menus.find(item => item.id === id);
    if (menu?.messageId) return;
    if (!menu) {
      const bots = await this.options.runtime.listBots();
      if (this.closed || !this.options.allowed(message)) return;
      menu = { id, route: selectionRoute(message), senderId: message.senderId, chatId: message.chatId, kind: message.kind, bots, selected: false, expiresAt: Date.now() + 24 * 3_600_000 };
      const created = menu;
      this.routing.update(() => {
        this.routing.data.menus = this.routing.data.menus.filter(item => item.expiresAt > Date.now() - 6 * 24 * 3_600_000);
        this.routing.data.menus.push(created);
      });
    }
    const current = this.routing.data.selections[menu.route] ?? this.options.defaultBotId;
    const messageId = await this.options.transport.sendCard(message, feishuBotCard(menu.id, menu.bots, current), `${id}:menu`);
    this.routing.update(() => { menu.messageId = messageId; });
  }
}
