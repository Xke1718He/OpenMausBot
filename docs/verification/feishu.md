# Feishu messaging connector

## User path

Connect an application bot with the receive-message event subscription, then
configure the allowed users and groups in OpenMausBot. A private message needs
no mention and always requires its sender in the user list. Each listed group
has its own access switch: only listed users (the default for a newly added
group), or every human member of that group. An empty user list disables
private chats; individual groups can still work in everyone mode. In a group, mention the bot to start a conversation; replies within
that topic can omit the mention. New top-level mentions start separate
conversations. Unrelated topics and ordinary group messages do not start work.

An attachment without a description starts a download, not an AI request.
Its card becomes **等待处理要求** when saved; no OpenMausBot conversation or
model execution is created just for the upload. The same sender's next
description in that chat/topic joins the pending task, including while its
download is running. Quoting the original attachment or its card selects it
explicitly. With multiple pending uploads, an unquoted description asks the
person to quote the intended attachment rather than guessing. Other users,
chats and topics cannot take over a pending upload. A message that already
contains both text and attachments can start processing after saving.

Feishu must deliver the unmentioned replies. An application with only
`im:message.group_at_msg:readonly` receives mentions; enable
`im:message.group_msg` and publish the application permission change to receive
ordinary user messages too. The connector still restricts processing to its
configured group access, allowed groups, and topics already admitted by a mention.
See the [official message FAQ](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/guide/faq).

Existing saved topic routes, bot selections and queued messages identify admitted topics, so
the first reply can arrive before the initial request finishes, and reconnecting
the connector preserves the conversation. Ordinary topic routes follow the
messaging state's retention policy. Explicit bot selections survive reconnects;
an unused selection card admits its creator's topic replies for 24 hours.

## Choose a bot with /bot

Send `/bot` in a private chat, or mention the application bot with `/bot` in a
listed group. The connector replies with a selection card containing the bots
visible to its paired owner/admin session, eight per page. Each bot's name is
followed by its public job (`title`) and introduction (`description`), limited
to 120 and 240 characters respectively; missing profiles show
“尚未填写职责介绍”. Instructions (`soul`) are not included. The configured
`botId` remains the default. Clicking a bot switches subsequent messages
directly to that bot; no manager bot or model inference handles the command.

Choices belong to the private chat's sender, or to the sender and topic in a
group. A new group topic starts with the configured default. Each bot keeps
its own conversation within that chat/topic, so switching back resumes it.
Already queued or running requests remain with their original bot. Their
task-card controls continue to target the original request after a switch.
`/stop` applies to the currently selected bot; use an earlier task's card to
stop work belonging to another bot.

Only the card's creator can select, in the original chat and card. A newer
`/bot` card invalidates older cards for that sender and chat/topic; a successful
selection consumes the card, and unused cards expire after 24 hours. Selection
rechecks the current bot catalog and configured sender/group access. Replayed
messages remain deduplicated across bot switches and connector restarts.

Both the managed connector and `openmausbot feishu` persist these choices
beside the original messaging state, preserving the default bot's existing
conversations and pending work. Bot lists are readable by all admitted users,
including members of groups configured for everyone, using the connector's
owner/admin access. Configure allowed users/groups accordingly.

Run `pnpm exec vitest run server/feishu/bot-router.e2e.test.ts
server/feishu/settings.e2e.test.ts` for isolated fake-engine and Feishu API
verification of direct routing, conversation continuity, restart recovery,
sender/topic isolation, pagination, duplicate delivery and callback rejection.
This checks the SDK event dispatcher and card JSON; it does not check visual
rendering or callback delivery in a real Feishu client.

Editing a connection shows a fixed asterisk placeholder and a saved-state
caption for its secret. The input value stays empty and saving it omits the
secret, preserving the server's saved value. Changing the app ID or platform
requires a new secret and removes the saved-secret placeholder.

## Task cards and controls

Every admitted request gets a shared Card 2.0 task card. The same card changes
from queued to downloading, waiting for a description, working, waiting for
input and a terminal state. The description reuses the upload's task/card and
saved files, so it creates no second inference request or download.
It shows elapsed time, the latest public reply or tool name, and a measured
graphical download bar when the resource supplies its total size. Unknown
sizes show received bytes without an invented percentage. Download cards also
show current speed in B/s, KB/s or MB/s and estimated remaining time when the
size and rate are known. Speed uses an eight-second window of bytes written
to the CLI's private staging file, rather than counting the later local
import a second time. The SDK obtains total bytes before payload download:
recursive folder metadata supplies each leaf's `size`, while missing sizes
use a one-byte `Range: bytes=0-0` probe. The probe reads `Content-Range` for a
206 response and `Content-Length` only for a complete 200 response, then closes
the stream immediately. The probe's bytes do not count as payload progress.
Compressed, malformed, missing or unavailable size metadata stays unknown;
the CLI still downloads the resource and the card does not invent a total.
Each probe is bounded to five seconds, with up to four concurrent probes and
a fifteen-second metadata-stage budget. Cancellation closes probe requests.
Folder progress adds file bytes only, never a directory's aggregate size.
Cards show the current file's bytes and the whole upload's cumulative bytes;
when the whole total is known, its graphical bar and remaining time describe
the whole upload. Saved receipt sizes survive pause/restart without counting
them as newly transferred bytes. CLI output must match a known metadata size
before import; a discrepancy fails integrity validation.
The card refreshes about every two seconds
while data arrives or stalls; after the window contains no new bytes it shows
zero speed and no ETA. Each resumed transfer starts a fresh speed measurement,
and paused cards do not retain a running rate. Tool arguments,
results and internal reasoning are not copied into status cards. Complete
answers retain their existing rich-text formatting below the status card.

In the developer console, enable **Events & Callbacks → Callback Configuration
→ `card.action.trigger`** using the existing long connection. No public
callback URL is needed. The app must also be able to update its own messages
(for example, with `im:message:update`). Missing update permission falls back
to ordinary status replies and does not prevent the task or final answer.

The task's original sender can use **暂停**, **继续** and **结束任务**. Group
membership or membership in the allowed-user list does not grant control over
someone else's task. Controls are checked against the saved card message,
chat, task, current access and button revision. Repeated, forwarded and stale
controls are refused. A stop targets the exact request's execution, never an
unrelated request running later in the same conversation.
An upload waiting for a description offers Stop only: it has no running model
to pause, and elapsed work time excludes the wait for the person's words.

Pause interrupts the current inference and holds this connector's later
requests in the same topic. It does not freeze the CLI process or undo work
already done. Continue sends a new, guarded continuation in the same
conversation after verifying the interrupted request still owns its branch.
If another user request or branch intervenes, continuation is refused. The
continuation keeps the bot's current approval mode; approval prompts still
need a response in OpenMausBot. A paused attachment transfer restarts the
current file when continued, retaining receipts for files already saved.
Paused tasks and accepted controls survive connector restart. Ending a paused
task releases the topic's queue. Card refreshes are throttled, and elapsed
time stops advancing while paused.

## Incoming attachments

After a successful save, the connector sends typed `attachmentContext`
metadata alongside the owned/guarded request. The server builds a short
runtime context from it through the existing app-context mechanism: files are
on the backend; follow the user's scope; use native images or file tools;
preserve relative paths and report real access errors within current
permissions. The saved directory is metadata too. These instructions are not
part of the stored user's text, chat history or Feishu card title. Visible
messages contain the actual description and attachment references, without a
synthetic “please process” instruction or a delivery-prompt paragraph.
The context does not make host files visible inside another execution
environment. It is supplied again on connector resume/retry while saved
receipts remain, and is not added for ordinary text or a user-written file tag
without a save receipt. The context schema accepts delivery metadata, not
arbitrary client-supplied hidden instructions.

The connection's **File download folder** accepts an absolute path or
`~/download`, resolved on the backend host. Empty keeps the default attachment
store. Each message creates one stable ID directory inside that location.
Standalone files keep their exact names there. An uploaded folder keeps its
own original name, all internal directories (including empty ones), filenames
and extensions beneath that ID directory. For example,
`~/download/<id>/rosbag/metadata.yaml` and
`~/download/<id>/rosbag/nested/record.mcap`. The ID isolates different messages
without changing names inside the upload. Retries verify existing
bytes, interrupted streams remove partial files, and disk checks leave a
64 MiB reserve. Custom files use disk capacity rather than the internal
attachment-store quota. Their actual paths reach the bot, so the person or
bot may remove them after analysis; deletion makes earlier file references
unavailable. Existing files stay where they were. Images are saved in the same
message directory and also retain an app-owned cache for native image input.
Image messages do not supply an original filename, so the connector supplies
one; embedded images get separate names. Choose a folder the bot can access, such as
one under the backend user's home; isolated engines may not see other disks.

File messages, folder messages, image messages and images embedded in rich-text posts are
downloaded through the message-resource API using the received message ID and
resource key. The application needs the `im:resource` permission. Direct chats
can send attachments directly; in groups, first mention the bot to establish a
topic, then send attachments as replies in that topic. Receiving those replies
also requires the group-message permission described above.

Folder messages first get a task card, then use the SDK's generic request to
`GET /open-apis/im/v1/files/:file_key/folder` with `recursive=true`,
`srctype=message` and the original message ID. Enumeration uses the
same configured bot identity as downloads and needs a message-read scope
(`im:message.history:readonly`, `im:message:readonly` or `im:message`). Children
are downloaded individually with the original message ID and each child's
resource key. Relative paths are recreated physically, and the bot receives
both the message directory and each file's real path, so metadata can keep
using its original relative references. Empty marker files such as `.done` are accepted, while ordinary
web uploads retain their existing empty-file checks.

A folder request admits up to 256 files, 32 directory levels and 1024 directory
entries. Incomplete trees, duplicate relative paths, unsafe names
and over-limit manifests produce a failure card instead of silently ignoring
the message or analyzing a partial list. The complete manifest is persisted
before file transfers. Pause/stop can cancel enumeration; continuing after
enumeration or restarting the bridge reuses the manifest and receipts for saved
files. Empty folders can also be saved and inspected. Download cards identify the relative filename and file index/count.

The SDK receives messages and card callbacks and sends replies/card updates.
Attachments are downloaded by the installed official `lark-cli` through
`im +messages-resources-download --as bot`. The SDK supplies a current bot
token for the same configured application; the child receives it only in its
environment. It never uses the person's CLI account, user token or profile.
Each transfer gets a private temporary HOME/config/data directory and output
folder. There are no credentials on argv and no shared CLI configuration writes.

The CLI owns Range requests, bounded retries, full-response fallback and
response validation. Version 1.0.97 is verified here and uses ranges up to
32 MiB for message files. Images use its image-resource path. A successful
CLI result must match a regular file at the exact expected staging path and
byte count. Images are identified by their byte signatures before import.
Feishu returns `206` with `Content-Range: bytes */0` for an empty file probe;
CLI 1.0.97 rejects that header. Only that exact protocol error triggers a
complete, un-ranged `lark-cli api GET` download of the same resource. Both the
CLI's saved byte count and the regular staging file must be zero; a nonempty
response remains an integrity failure. Other range/protocol errors do not
enter this compatibility path. The fallback uses the same isolated bot
credentials, cancellation, disk checks and a 15-second timeout.
Only then does the connector stream the file through the existing local save
endpoint. Partial CLI output is never sent to the bot. The process group is
stopped before cancellation cleanup; pause/restart downloads the current
unfinished attachment again, while completed upload receipts stay reusable.
Staging is monitored against the file limit and available disk space and is
removed after success or failure. CLI stderr is classified into safe failure
categories instead of being sent to Feishu or the model.
See [Feishu's resource API](https://open.feishu.cn/document/server-docs/im-v1/message/get-2?lang=zh-CN).

By default, files are saved under `DATA_DIR/attachments` (normally `~/.openmausbot/attachments`)
with message ID directories, subject to the workspace's storage quota. Nested
files are counted on quota scans and removed by the existing Settings clear.
The bot receives the same attachment tags
as a message sent from the app: file paths for reading with tools and native
image input. Existing execution permissions still apply. The bot can copy or
move a file to another permitted directory when asked. A configured download
folder instead receives ordinary files without a second
permanent copy in the attachment store; images retain their native-input cache.
CLI staging temporarily needs extra
disk space and is removed after import.

Files can exceed 100 MiB. With default storage, the file ceiling is the existing workspace attachment
quota, 512 MiB by default; a new file must also fit the remaining space. Set
the existing `OMB_ATTACHMENTS_MAX_BYTES` environment variable before starting
the server to raise that quota, for example `2147483648` for 2 GiB. This is a
total store limit, not space reserved for each download. No old attachment is
automatically deleted. Image messages retain the 10 MiB limit and are not
range-downloaded. Each message can contain four top-level attachments; folders
expand within the separate limits above. Audio/video message types, resources inside forwarded bundles and
interactive cards are not supported. Download or save failures produce a
failure card without starting inference. Permissions, missing resources,
network interruptions, invalid ranges, incomplete data, size limits and full
storage have different messages. Queued requests recheck access
before downloading. Persisted upload receipts and stable upload IDs prevent
duplicate storage or inference when delivery is retried or the bridge restarts.

`/api/feishu/files` requires an owner/admin bearer session, a loopback host and
socket, and an enabled local connector environment. Its optional `directory`
parameter is supplied by the owner's saved connection or CLI configuration,
never by incoming chat messages. The `batchId` and validated `relativePath`
parameters select a file only inside one message's ID directory. Parent and
leaf symbolic links, traversal, absolute paths and mismatched names are refused;
names are not silently sanitized or truncated. `/api/feishu/directories` has
the same owner/loopback requirements and creates the batch and original empty
directories before downloads. Without a custom directory, GET reports the quota and POST
uses ordinary upload accounting; with it, POST saves into that folder with
disk-space checks. Stable upload IDs are required. Ordinary `/api/files`
web uploads retain their 100 MiB ceiling. Failed or cancelled streams discard
their partial files; completed files retain their paths across retries.

## Automated verification

Use Node.js 24 or newer, as required by the project, and install official
`lark-cli` (verified with 1.0.97). Integration checks also need `openssl` to
make a temporary fixture-only TLS certificate.

```sh
pnpm exec vitest run src/components/FeishuCard.test.ts server/feishu/download-directory.test.ts server/feishu/events.test.ts server/feishu/resource-metadata.test.ts server/feishu/cli-download.test.ts server/feishu/task-card.test.ts server/feishu/service.test.ts server/messaging/bridge.test.ts server/messaging/openmausbot.test.ts server/feishu/cli.test.ts server/feishu/settings.e2e.test.ts server/feishu/bridge.e2e.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
node --experimental-strip-types scripts/verify-feishu.ts
```

The integration tests launch isolated servers with `launchVerificationServer`,
temporary homes and synthetic credentials. The real SDK event dispatcher and
HTTP client talk to a loopback Feishu stand-in. The actual installed CLI uses
a fixture-only loopback TLS proxy that refuses every host except the two
expected Feishu/Lark API hosts, forwarding them only to the stand-in. Its
temporary certificate and fake bot token are never installed globally.
No message is sent to a live
Feishu account, and no user's running workspace is changed.

The managed-connector fixture verifies a first mention and an immediately
queued reply without a mention, reconnects, and sends another unmentioned
reply. All three user messages must appear in one OpenMausBot thread. Replies
remain in the Feishu topic; unrelated topics, top-level unmentioned messages,
unauthorized private users and unauthorized groups create neither replies nor threads.
Another scenario configures two groups with different modes, lets two different
unlisted members share a topic only in the everyone group, then swaps the modes
and verifies that each group's admission changes independently. Both private users saved in the list
remain usable, and the saved group mode is returned by the settings endpoint.
Event unit checks cover root-message and thread identifiers and reject bot
senders. The bridge fixture also checks separate mentioned topics, duplicate
delivery, restart persistence, approvals and guarded execution.

A pending-upload fixture saves a real attachment without starting inference,
restarts the connector, supplies a quoted description and verifies one task,
one card and no second download. Its visible stored message must contain only
the description and attachment references, while the fake engine must receive
the short delivery context. Unit checks cover a description during transfer,
unquoted continuation in the same group topic, another sender, ambiguous
uploads, duplicate descriptions and refusing Pause while waiting for words.

Attachment integration checks download synthetic files into the fixture's real
attachment directory and have the fake engine execute a file-reading command
against the path in its prompt. The read bytes must match the original. An
additional managed connection saves `~/download`, receives a file into that
folder in its disposable home, retains the setting on reconnect and deletes
the file manually. The bridge fixture also has the fake engine read a file
from the custom folder before cleanup. Writer checks cover interrupted and
truncated streams, same-name files, concurrent retries, content conflicts,
symbolic-link destinations, long Unicode filenames and unavailable disk space. An
image with a generic binary MIME type must reach the engine's native image
input. A duplicate event after restart must not redownload or rerun inference;
missing resource permission must create no model thread. Unit checks cover
partial-batch restart, revoked access before download, streaming size limits,
CLI account isolation and image format detection.

Folder checks use the actual SDK against the same loopback Feishu stand-in;
payload transfers use the installed CLI through the fixture proxy. The engine
reads nested file paths, same-name metadata files and a
zero-byte marker, and duplicate delivery after restart must enumerate and
download nothing again. Incomplete listings show a failure card and start no
inference. Unit checks exercise cancellation during enumeration, persisted
manifests with more than four children, partial-batch restart, permission
failures, unsafe names, depth/count limits and zero-byte retry receipts.
The integration fixture checks the actual ID directory, unchanged inner tree
and filenames, an empty directory and metadata references to sibling files.
Ordinary-file and image checks also verify their ID directories and names,
while images must still reach native vision input. Storage checks cover nested
quota accounting/clearing and symbolic-link refusal; box checks retain relative
file references when named files enter the read-only conversation uploads.
Empty files use the production-observed `206 bytes */0` response in the
stand-in, and their subsequent complete download must be observed. A resource
that advertises an empty range but returns nonempty complete content is refused.

The large-file fixture downloads and stores a synthetic 405.4 MiB attachment,
has the test engine read it in chunks and checks its SHA-256 and exact size.
One range fails once and must be retried without duplicating bytes. Duplicate
message delivery must not redownload it. Full storage, oversized resources,
permission failures, corrupted ranges and repeated network
failure must start no model thread and leave no partial file. API checks
refuse unpaired and client-only callers. Storage checks retain the ordinary
web limit, large-file retry receipts and quota accounting for unknown sizes.
An intentionally slow CLI transfer verifies that SDK-probed totals, graphical
progress, saved-byte speed and estimated remaining time appear before the CLI
finishes. A refused probe must leave the total unknown and retain byte/rate
updates without a percentage or ETA. The folder fixture verifies its chart
against the sum of leaf sizes and probes only a leaf with no declared size.
Unit checks distinguish partial `Content-Length` from complete resource size,
close streams on success/refusal/cancellation, reject metadata/file size
conflicts and retain cumulative byte counts over pause/restart.
Full-response fallback is accepted when the server returns a complete valid
file instead of honoring Range. A real CLI transfer is also paused through
the task card, checked to have started no inference, then resumed after a
bridge restart. It must download again and deliver exactly one final answer.

Task-card integration checks use the real SDK callback dispatcher and local
card reply/patch endpoints. A synthetic engine execution is paused, its
cancelled request is checked through the real request snapshot API, the bridge
is restarted, and the same card continues and ends the new exact execution.
Another group member and stale button revisions must be refused; a subsequent
request in the same topic must still run. Unit checks cover cancellation during
download, branch changes, an already-completed request, lost interrupt
acknowledgements, revoked access and missing card-update permission.

A silent fake engine also triggers the first-reply rescue notice while a
Feishu request is running. The notice must carry its originating request ID
on the message row as well as in its rescue payload. Polling that request must
remain working through the notice, then deliver exactly one final answer when
the engine is released. Request ownership guards remain in effect.

The suites retain JSON evidence beside the fixture's persistent server log:
`.feishu-settings.json` for the managed connector and `.feishu.json` for the
bridge. They stop their own servers and remove only their temporary data.

The UI fixture adds and removes user tags, pastes multiple IDs separated by
newlines and Chinese punctuation, reopens the form, and checks the saved tags
and each group's own switch. It checks English and Chinese at desktop and
narrow widths in Daylight and Midnight, with screenshots under
`/tmp/omb-feishu-tags-ui-evidence` by default. UI unit checks also verify that
an existing fallback mode is preserved for the groups already saved, newly
added groups default to allowlist, and deleting a group removes its saved mode.

The wire field `groupAccessByChat` maps each allowed chat ID to `allowlist` or
`everyone`. The optional `groupAccess` field supplies the fallback for
configurations without a per-chat entry. Editing expands that fallback for the
saved groups; saving writes per-chat entries and omits the fallback, so it does
not enable every newly added group.

## Limits

These fixtures do not verify a real Feishu WebSocket connection, approval of
application permissions, or live platform delivery of unmentioned messages.
Check those in the Feishu developer console before using topic continuation.
They validate card JSON and callback behaviour against a stand-in, not visual
rendering or button delivery in a real Feishu desktop/mobile client.
