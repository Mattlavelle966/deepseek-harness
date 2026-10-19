# Terminal frontend

English | [中文](README.zh.md)

The `tui` profile attaches a keyboard and mouse frontend to an existing Web harness. Web and TUI share the backend's sessions, tools, settings, approvals, and persistence. The terminal frontend never starts a server or loads another model runtime.

## Run

Start a harness separately with `dsh web --no-open`, then run in a Linux terminal or tmux pane:

```sh
dsh tui --url http://127.0.0.1:3032
```

The port must match the existing server. `DSH_TUI_URL` supplies the URL when `--url` is omitted. The TUI uses a local-only attach handshake and needs no token. The Harness must include local TUI authentication support; restart an older server after updating it. `--session <id>` selects an existing session; `--no-mouse` leaves mouse handling to tmux. A missing server, incompatible handshake, or noninteractive terminal fails with an actionable diagnostic.

For a remote harness, forward its port with SSH and pass the forwarded localhost URL. Mount prefixes are preserved. The local TUI handshake is accepted only on loopback socket connections.

For a source checkout, run `pnpm run build:artifacts` before `pnpm dsh tui --url <url>`. The frontend uses Node and TypeScript alongside the existing Cordis stack.

## Navigation

The interface starts in Normal mode. `i` or `a` enters the built-in multiline editor; Escape returns to Normal mode. Arrow keys and `hjkl` navigate, `w/b` move by word, `0/$` select line edges, `gg/G` select the beginning/end, and Ctrl-u/Ctrl-d scroll. The editor supports undo/redo, `v` selection, yank/delete, and paste. Bracketed paste remains literal and cannot submit a prompt or run a command.

Tab and Shift-Tab cycle focus. Ctrl-w followed by `h/j/k/l` changes panes. Space Space opens the searchable action palette; `:` opens TUI commands, `/` searches the visible transcript, and `?` opens help. Menus use arrows and Enter while typing filters their entries. Forms use Tab between fields and Ctrl-s to submit. Complex structured parameters accept JSON and are validated by the existing generated codecs.

Enter follows the Host-backed busy-state delivery preference; Alt-Enter uses its complement. Ctrl-j inserts a newline. Slash-prefixed prompts invoke harness commands. Drafts and attachment selections are per-session and local to this frontend. Mouse support includes focus, lists, scrolling, pane sizing, and transcript selection; `:copy` sends selected text through the terminal clipboard protocol. Terminal clipboard support depends on the terminal and tmux configuration.

## Workflows

| Command | Behavior |
| --- | --- |
| `:sessions`, `:new <host directory>`, `:rename <title>` | Browse, create, or rename shared sessions |
| `:fork`, `:older`, `:stop`, `:search <text>` | Fork, page history, stop the current turn, or search sessions |
| `:files` | Browse host workspace files and preview text |
| `:settings`, `:models`, `:workspaces` | Open actions backed by the existing controllers |
| `:plugins`, `:goals`, `:schedules`, `:jobs`, `:subagents`, `:commands` | Browse the corresponding feature actions |
| `:actions` | Browse every method selected by the shared Remote facade, plus extension actions |
| `:attach <local path>`, `:image <local path>` | Stage file/image attachments for the current draft |
| `:clearattachments` | Remove staged draft attachments |
| `:terminal`, `:terminals`, `:terminal <id>` | Create or attach a retained harness terminal |
| `:terminalinput`, `:termdetach`, `:termclose` | Enter input mode, detach, or explicitly close the remote terminal |
| `:export <local path.zip>` | Download the complete native session archive |
| `:transcript <local path>` | Save the currently loaded text transcript |
| `:download <route> <local path>` | Save an authenticated harness download |
| `:open <URL>` | Explicitly launch a visual preview in the system viewer |
| `:questions` | Answer agent questions that remain pending after their foreground wait |
| `:inspect`, `:result` | Inspect session state or the latest action result |
| `:reconnect`, `:cancelobservation`, `:mouse`, `:q` | Reconnect, stop an action stream, toggle mouse, or disconnect |

Approvals and agent questions appear in both frontends. The first answer wins through the existing gateway, which dismisses the other copy. Escape delegates a request rather than approving it. Free-text and option answers are supported; multi-select answers accept comma-separated option labels.

A retained terminal uses the existing client terminal controller for retention, reconnection, input acknowledgements, and backpressure. Ctrl-Backslash returns from terminal input mode. Detaching or exiting the TUI leaves the remote terminal and agent running; only `:termclose` explicitly ends the terminal.

Profile overlays configure `frameMs`, `escapeDelayMs`, `connectTimeoutMs`, `maxStreamCharacters`, and mouse defaults on the `tui` row. Connection loss preserves drafts and uses the existing recovery service. Mutations with unknown outcomes are never automatically replayed.

## Extension API

Plugins inject `tui`, then register `TuiAction` entries through `registerAction()` or renderers through `registerRenderer(kind, renderer)`. Both return exact disposers; plugins register them through `ctx.effect()`. Renderers receive shared Chat data and return text lines. Unknown Chat kinds retain a structured fallback.

## Model Experience

The TUI supplies the same prompts, attachments, command invocations, and interaction answers as the Web client. It does not modify model requests, tools, sandbox policy, or session formats.

### KV Cache effect

None beyond the user's ordinary session actions: the frontend contributes no model-visible context or prompt changes.

## Known Limitations and Deferred Work

The supported environment is Linux, including tmux and SSH port forwarding. Browser pages, images, and Office/PDF previews use explicit external viewers or downloads. Arbitrary third-party DOM components need terminal renderers. The built-in editor implements modal navigation and common editing operations rather than the complete Neovim command language. Extended management workflows use generated action forms rather than reproducing browser-specific layouts. UI drafts are process-local and are not synchronized with browser-local drafts.
