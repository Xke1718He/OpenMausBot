import { useId, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { imeComposing } from "@/lib/send-key";
import { feishuGroupAccess, type FeishuConnectionInput, type FeishuGroupAccess } from "../../shared/feishu";
import { Switch } from "./SettingsPrimitives";

const separators = /[\s,;，；、]+/;

export function collectFeishuIds(value: string[], entry: string, kind: "user" | "chat") {
  const ids = [...new Set([...value, ...entry.split(separators).filter(Boolean)])];
  const pattern = kind === "user" ? /^ou_[\w-]+$/ : /^oc_[\w-]+$/;
  const error = ids.length > 100 ? "limit" : ids.some(id => !pattern.test(id)) ? "invalid" : null;
  return { ids, error };
}

type Props = {
  label: string;
  value: string[];
  entry: string;
  disabled: boolean;
  fieldClassName: string;
  onEntryChange(value: string): void;
  onChange(value: string[]): void;
} & ({ kind: "user" } | {
  kind: "chat";
  modes: Pick<FeishuConnectionInput, "groupAccess" | "groupAccessByChat">;
  onAccessChange(id: string, mode: FeishuGroupAccess): void;
});

export function FeishuAccessEditor(props: Props) {
  const id = useId();
  const [attempted, setAttempted] = useState(false);
  const result = collectFeishuIds(props.value, props.entry, props.kind);
  const add = () => {
    setAttempted(true);
    if (result.error) return;
    props.onChange(result.ids); props.onEntryChange(""); setAttempted(false);
  };
  return <div className="flex min-w-0 flex-col gap-2" data-feishu-id-list={props.kind}>
    <label htmlFor={id} className="text-[12px] text-ink-secondary">{props.label}</label>
    {props.value.length > 0 && <ul aria-label={props.label} className={props.kind === "user" ? "flex min-w-0 flex-wrap gap-2" : "flex min-w-0 flex-col gap-3"}>
      {props.value.map(value => <li key={value} data-feishu-id={value} className={props.kind === "user" ? "ui-chip min-w-0 max-w-full gap-1 bg-control" : "flex min-w-0 flex-col gap-1"}>
        <div className="flex min-w-0 items-center gap-1">
          <span dir="ltr" title={value} className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{value}</span>
          <button type="button" className="ui-icon-button size-6 shrink-0" disabled={props.disabled} aria-label={t("feishu.removeId", { id: value })} onClick={() => props.onChange(props.value.filter(item => item !== value))}><X size={12} aria-hidden="true" /></button>
        </div>
        {props.kind === "chat" && <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-secondary">{t(feishuGroupAccess(props.modes, value) === "everyone" ? "feishu.chatEveryone" : "feishu.chatAllowlist")}</span>
          <Switch compact aria-label={t("feishu.chatEveryoneFor", { id: value })} checked={feishuGroupAccess(props.modes, value) === "everyone"} disabled={props.disabled}
            onClick={() => props.onAccessChange(value, feishuGroupAccess(props.modes, value) === "everyone" ? "allowlist" : "everyone")} />
        </div>}
      </li>)}
    </ul>}
    <div className="flex min-w-0 items-center gap-2">
      <input id={id} aria-label={props.label} aria-describedby={`${id}-hint${attempted && result.error ? ` ${id}-error` : ""}`} aria-invalid={attempted && Boolean(result.error)}
        className={cn(props.fieldClassName, "flex-1")} value={props.entry} disabled={props.disabled} autoComplete="off" spellCheck={false} dir="ltr" placeholder={props.kind === "user" ? "ou_…" : "oc_…"}
        onChange={event => { props.onEntryChange(event.target.value); setAttempted(false); }} onBlur={() => setAttempted(true)}
        onKeyDown={event => { if (event.key === "Enter" && !imeComposing(event.nativeEvent)) { event.preventDefault(); add(); } }}
        onPaste={event => {
          const text = event.clipboardData.getData("text");
          if (text.trim().split(separators).length < 2) return;
          event.preventDefault(); props.onEntryChange([props.entry, text.trim().split(separators).join(", ")].filter(Boolean).join(", ")); setAttempted(false);
        }} />
      <button type="button" className="ui-button ui-button-sm shrink-0" disabled={props.disabled || !props.entry.trim()} onClick={add}>{t(props.kind === "user" ? "feishu.addUser" : "feishu.addChat")}</button>
    </div>
    <p id={`${id}-hint`} className="text-[12px] leading-5 text-ink-secondary">{t(props.kind === "user" ? "feishu.userTagsHint" : "feishu.chatTagsHint")}</p>
    {attempted && result.error && <p id={`${id}-error`} role="alert" className="text-[12px] leading-5 text-danger">{t(result.error === "limit" ? "feishu.idLimit" : props.kind === "user" ? "feishu.invalidUser" : "feishu.invalidChat")}</p>}
  </div>;
}
