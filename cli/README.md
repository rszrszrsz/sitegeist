# sitegeist (CLI)

Bridge between coding harnesses and the Sitegeist browser extension. Any MCP client
(Claude Code, Codex, omp) and pi can drive a Chromium browser through it. Each harness
gets its own tab group and works in the background while you keep using your tabs.

```
harness ── stdio MCP ── sitegeist mcp ── unix socket ── native host ── native messaging ── extension
```

Nothing listens on the network. The browser spawns the native host; the host owns a
socket in `/tmp/sitegeist-bridge-<user>/` (0700 directory, 0600 socket) that only your
user can reach. The client refuses sockets and directories it does not own.

## Install

```bash
npm install -g sitegeist        # or: npm link from this directory
sitegeist install               # writes the native-messaging manifest for every Chromium browser found
```

`sitegeist mcp` runs the installer itself on first use, so a harness configured to start
it needs no extra step. Reload the extension once after the first install.

## Commands

| Command | Purpose |
| --- | --- |
| `sitegeist mcp` | stdio MCP server exposing the browser tools |
| `sitegeist install [--force]` | write the native host manifest (Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera; Linux and Windows too) |
| `sitegeist status` | is a browser reachable, is the extension connected, which profile |
| `sitegeist profiles` | browser profiles: open, closed (extension installed), no extension |
| `sitegeist allow <host>` | let agents open a site without a prompt (subdomains included) |
| `sitegeist reload` | reload the extension (after rebuilding `dist-chrome`) |
| `sitegeist debug` | bridge state, recent request timings, Chrome API benchmark |
| `sitegeist pi-extension` | write `~/.pi/agent/extensions/sitegeist.ts` for pi |

`allow`, `yolo`, `ask`, `reload` and `debug` act on the newest bridge; pass
`--profile <email | name | directory>` to pick one when several profiles are open.

## Harness setup

```bash
claude mcp add sitegeist -- sitegeist mcp
sitegeist pi-extension
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.sitegeist]
command = "sitegeist"
args = ["mcp"]
```

omp: add an MCP server entry that runs `sitegeist mcp`.

## Permissions

By default the extension asks before an agent opens a new site. MCP clients that support
elicitation (Claude Code, Codex) show the prompt inline; otherwise answer it in the
Sitegeist side panel under Settings > Bridge, run `sitegeist allow <host>`, or switch the
mode to "allow any site" there. pi: set `SITEGEIST_AUTO_ALLOW=1` to auto-approve.

`SITEGEIST_SESSION=<name>` makes a harness re-adopt the same tab group across restarts.
`SITEGEIST_CLIENT_NAME` overrides the tab group label.

## Browser profiles

Each browser profile with the extension runs its own bridge. The host finds out which
profile it serves: the extension writes a random marker to its storage before its hello,
and the host looks for that marker in each profile's extension storage, then reads the
name and account from the browser's `Local State`.

The MCP server uses the newest bridge unless `SITEGEIST_PROFILE` names a profile (email,
profile name, or directory such as `Profile 3`; `Chrome/Profile 3` when several browsers
have one). A name that matches no profile stops the server instead of driving another
account. The `profiles` tool lists profiles; `profile_use` switches to one and opens a
window of it when it is closed (macOS and Linux; the extension must have been loaded in
that profile once). Site permissions are stored per profile. The pi extension still uses
the newest bridge.

## MCP tools

`tabs_context`, `tabs_create`, `tabs_close`, `tabs_select`, `tabs_show`, `navigate`,
`screenshot`, `read_page`, `get_page_text`, `get_page_html`, `find`, `click`, `hover`,
`type`, `press`, `fill`, `scroll`, `drag`, `actions`, `run_js`, `wait`, `read_console`,
`read_network`, `profiles`, `profile_use`. `tabs_show` brings a tab forward; `navigate`
with `showTab` also does so, and `profile_use` opens a window when opening a closed profile.
