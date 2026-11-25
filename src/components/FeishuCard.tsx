import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Loader2, MessageSquare, MoreHorizontal } from "lucide-react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { feishuGroupAccess, type FeishuConnectionInput, type FeishuConnectionStatus } from "../../shared/feishu";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";
import { collectFeishuIds, FeishuAccessEditor } from "./FeishuAccessEditor";

const pill = "inline-flex h-7 shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover disabled:opacity-50";
const field = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-focus";
const empty = { appId: "", appSecret: "", botId: "", domain: "feishu" as const, allowedUsers: [], allowedChats: [] };

export function FeishuCard({ refreshKey = 0, onConnection }: { refreshKey?: number; onConnection?: (connected: boolean | null) => void }) {
  const { state } = useStore();
  const bots = (state.bots ?? []).filter(bot => !bot.hidden);
  const [status, setStatus] = useState<FeishuConnectionStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FeishuConnectionInput>(empty);
  const [users, setUsers] = useState("");
  const [chats, setChats] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const mounted = useRef(true);
  const version = useRef(0);
  const saving = useRef(false);
  const secretHintId = useId();
  const connected = status?.state === "connected";
  const pending = status?.state === "connecting" || status?.state === "reconnecting";
  const nextUsers = collectFeishuIds(draft.allowedUsers, users, "user");
  const nextChats = collectFeishuIds(draft.allowedChats, chats, "chat");
  const secretKept = Boolean(status?.saved && status.configuration?.appId === draft.appId && status.configuration.domain === draft.domain);
  const canSave = draft.appId.trim() && draft.botId && !nextUsers.error && !nextChats.error
    && (nextUsers.ids.length > 0 || nextChats.ids.some(id => feishuGroupAccess(draft, id) === "everyone")) && (draft.appSecret?.trim() || secretKept);

  const load = useCallback(async () => {
    if (saving.current) return;
    const requested = ++version.current;
    try {
      const next = await api("/api/feishu") as FeishuConnectionStatus;
      if (!mounted.current || requested !== version.current) return;
      if (typeof next?.state !== "string" || typeof next.saved !== "boolean") throw new Error("Invalid connection status");
      setStatus(next); setError(null);
    } catch (cause) {
      if (!mounted.current || requested !== version.current) return;
      if ((cause as { status?: number }).status === 403) setHidden(true);
      else setError(t("feishu.loadFailed"));
    }
  }, []);

  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; version.current++; };
  }, [load, refreshKey]);
  useEffect(() => { onConnection?.(status ? connected : null); }, [status, connected, onConnection]);
  useEffect(() => {
    if (!status?.saved || busy || editing) return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [status?.saved, busy, editing, load]);

  const configure = () => {
    const configuration = status?.configuration;
    setDraft(configuration ? { ...configuration, appSecret: "", groupAccess: undefined,
      groupAccessByChat: Object.fromEntries(configuration.allowedChats.map(id => [id, feishuGroupAccess(configuration, id)])),
    } : { ...empty, botId: bots[0]?.id ?? "" });
    setUsers(""); setChats("");
    setError(null); setEditing(true);
  };
  const save = async () => {
    if (saving.current || !canSave) return;
    saving.current = true; version.current++; setBusy(true); setError(null);
    try {
      const next = await api("/api/feishu", { method: "PUT", body: JSON.stringify({ ...draft,
        appSecret: draft.appSecret?.trim() || undefined, groupAccess: undefined, allowedUsers: nextUsers.ids, allowedChats: nextChats.ids,
        downloadDirectory: draft.downloadDirectory?.trim() || undefined,
        groupAccessByChat: Object.fromEntries(nextChats.ids.map(id => [id, feishuGroupAccess(draft, id)])),
      }) }) as FeishuConnectionStatus;
      if (!mounted.current) return;
      setStatus(next); setDraft(current => ({ ...current, appSecret: "" })); setEditing(false);
    } catch (cause) {
      if (mounted.current) {
        const code = (cause as { body?: { code?: string } }).body?.code;
        setError(code === "configuration" ? t("feishu.configurationError") : code === "busy" ? t("feishu.busy") : t("feishu.connectionError"));
      }
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const disconnect = async () => {
    if (saving.current) return;
    saving.current = true; version.current++; setBusy(true); setError(null);
    try {
      const next = await api("/api/feishu", { method: "DELETE" }) as FeishuConnectionStatus;
      if (mounted.current) { setStatus(next); setEditing(false); setDraft(empty); }
    } catch { if (mounted.current) setError(t("feishu.disconnectError")); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };

  if (hidden) return null;
  const blocked = status?.state === "blocked";
  const description = blocked ? t("feishu.blocked") : pending ? t("feishu.connecting") : status?.state === "error" ? t("feishu.connectionError")
    : connected ? t("feishu.connectedTo", { name: bots.find(bot => bot.id === status.configuration?.botId)?.name ?? t("feishu.bot") }) : t("feishu.description");
  const label = (key: "appId" | "appSecret" | "bot" | "users" | "chats" | "domain") => t(`feishu.${key}`);

  return <div data-app-tile="feishu" data-feishu-state={status?.state ?? "loading"} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg bg-control text-ink-secondary"><MessageSquare size={22} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5"><span className="truncate text-[14px] font-semibold text-ink">{t("feishu.name")}</span>{connected && <Check size={13} className="text-success" aria-label={t("apps.connected")} />}</div>
        <p className="text-[13px] leading-[18px] text-ink-secondary">{description}</p>
      </div>
      {busy ? <Loader2 size={16} className="shrink-0 animate-spin text-ink-secondary" aria-label={t("feishu.saving")} />
        : status === null ? <button type="button" className={pill} onClick={() => void load()} disabled={!error}>{t(error ? "connectors.action.retry" : "feishu.loading")}</button>
          : !editing && !blocked && !pending && !connected ? <button type="button" className={pill} onClick={configure}>{t(status.saved ? "feishu.reconnect" : "feishu.connect")}</button> : null}
      {status?.saved && !busy && <SidebarPopoverMenu ariaLabel={t("feishu.options")} placement="below"
        triggerClassName="shrink-0" items={[
          { key: "edit", label: t("feishu.edit"), disabled: blocked, onSelect: configure },
          { key: "disconnect", label: t("connectors.disconnect"), onSelect: () => void disconnect() },
        ]} renderTrigger={() => <span className="inline-flex size-7 items-center justify-center rounded-full bg-control/80 text-ink hover:bg-raised-hover"><MoreHorizontal size={15} /></span>} />}
    </div>
    {editing && <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(); }} data-feishu-form>
      <p className="text-[12px] leading-5 text-ink-secondary">{t("feishu.setupHint")}{" "}<a className="text-accent-text underline underline-offset-2" href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">{t("feishu.openConsole")}</a></p>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{label("domain")}<select aria-label={label("domain")} className={field} disabled={busy} value={draft.domain} onChange={event => setDraft(current => ({ ...current, domain: event.target.value as "feishu" | "lark" }))}><option value="feishu">Feishu</option><option value="lark">Lark</option></select></label>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{label("appId")}<input className={field} value={draft.appId} disabled={busy} autoComplete="off" spellCheck={false} dir="ltr" required onChange={event => setDraft(current => ({ ...current, appId: event.target.value }))} /></label>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{label("appSecret")}<input aria-label={label("appSecret")} aria-describedby={secretKept ? secretHintId : undefined} className={field} type="password" value={draft.appSecret ?? ""} placeholder={secretKept ? "****************" : undefined} disabled={busy} autoComplete="new-password" required={!secretKept} onChange={event => setDraft(current => ({ ...current, appSecret: event.target.value }))} />{secretKept && <span id={secretHintId}>{t("feishu.keepSecret")}</span>}</label>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{label("bot")}<select aria-label={label("bot")} className={field} value={draft.botId} disabled={busy} required onChange={event => setDraft(current => ({ ...current, botId: event.target.value }))}><option value="" disabled>{t("feishu.chooseBot")}</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{t("feishu.downloadDirectory")}<input aria-label={t("feishu.downloadDirectory")} className={field} value={draft.downloadDirectory ?? ""} placeholder="~/download" disabled={busy} autoComplete="off" spellCheck={false} dir="auto" onChange={event => setDraft(current => ({ ...current, downloadDirectory: event.target.value }))} /><span>{t("feishu.downloadDirectoryHint")}</span></label>
      <FeishuAccessEditor kind="user" label={label("users")} value={draft.allowedUsers} entry={users} disabled={busy} fieldClassName={field}
        onEntryChange={setUsers} onChange={allowedUsers => setDraft(current => ({ ...current, allowedUsers }))} />
      <FeishuAccessEditor kind="chat" label={label("chats")} value={draft.allowedChats} entry={chats} disabled={busy} fieldClassName={field} modes={draft}
        onEntryChange={setChats} onChange={allowedChats => setDraft(current => ({ ...current, allowedChats,
          groupAccessByChat: Object.fromEntries(allowedChats.map(id => [id, feishuGroupAccess(current, id)])),
        }))} onAccessChange={(id, mode) => setDraft(current => ({ ...current, groupAccessByChat: { ...current.groupAccessByChat, [id]: mode } }))} />
      <p className="text-[12px] leading-5 text-ink-secondary">{t("feishu.accountHint")}</p>
      <div className="flex gap-2"><button type="submit" className={pill} disabled={busy || !canSave}>{t(busy ? "feishu.saving" : "feishu.save")}</button><button type="button" className={pill} disabled={busy} onClick={() => { setEditing(false); setDraft(current => ({ ...current, appSecret: "" })); setError(null); }}>{t("feishu.cancel")}</button></div>
    </form>}
    {error && <p role="alert" className="mt-2 text-[12px] leading-5 text-danger">{error}</p>}
  </div>;
}
