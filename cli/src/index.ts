import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, listSockets, probeBridges } from "./client.ts";
import { runNativeHost } from "./host.ts";
import { install, isInstalled } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { writePiExtension } from "./pi-extension.ts";
import { describeProfile, profileStatusLines, resolveProfile } from "./profiles.ts";
import { VERSION } from "./version.ts";

const HELP = `sitegeist ${VERSION} - browser bridge for coding harnesses

Usage:
  sitegeist mcp             Run the MCP server on stdio (installs the native host on first run)
  sitegeist install         Write the native messaging manifest for every Chromium browser found
  sitegeist status          Show whether the extension is reachable, per browser profile
  sitegeist profiles        List browser profiles: open, closed, or without the extension
  sitegeist reload          Reload the extension (picks up a rebuilt dist-chrome)
  sitegeist allow <host>    Allow agents to open a site (subdomains included)
  sitegeist yolo            Allow agents to open ANY site (no per-site prompts)
  sitegeist ask             Require a prompt before agents open an un-allowed site (default)
  sitegeist debug           Print the extension's bridge state and recent timing log
  sitegeist pi-extension    Write a pi extension to ~/.pi/agent/extensions/sitegeist.ts
  sitegeist host            (internal) native messaging host, spawned by the browser

  allow, yolo, ask, reload and debug act on the newest bridge; with several profiles
  open, pick one with --profile <email | name | directory>.

Harness setup:
  claude mcp add sitegeist -- sitegeist mcp
  codex:  [mcp_servers.sitegeist]  command = "sitegeist"  args = ["mcp"]
  omp:    add an MCP server entry running "sitegeist mcp"
  pi:     sitegeist pi-extension
`;

async function status(): Promise<void> {
	const sockets = listSockets();
	console.log(`native host manifest: ${isInstalled() ? "installed" : "missing (run: sitegeist install)"}`);
	if (sockets.length === 0) {
		console.log("bridge sockets: none. Is the sitegeist extension loaded in a running Chromium browser?");
		process.exitCode = 1;
		return;
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "status" });
		try {
			await client.connect(path);
			console.log(`${path}: host ok, extension ${client.extensionConnected ? "connected" : "not connected"}`);
			if (client.profile) console.log(`  profile: ${describeProfile(client.profile)}`);
			if (client.extensionConnected) {
				const ctx = (await client.call("tabs.context", {}, 5000)) as { tabs: unknown[] };
				console.log(`  session tabs: ${ctx.tabs.length}`);
			}
		} catch (err) {
			console.log(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			client.close();
		}
	}
}

/** `--profile <query>` and positional arguments after the command. */
function parseArgs(): { positional: string[]; profile?: string } {
	const rest = process.argv.slice(3);
	const isProfileFlag = (arg: string) => arg === "--profile" || arg.startsWith("--profile=");
	const i = rest.findIndex(isProfileFlag);
	if (i < 0) return { positional: rest };
	const separateValue = rest[i] === "--profile";
	const profile = separateValue ? rest[i + 1] : rest[i].slice("--profile=".length);
	if (!profile?.trim() || profile.startsWith("--")) throw new Error("--profile needs a value: email, profile name, or directory");
	const end = i + (separateValue ? 2 : 1);
	if (rest.slice(end).some(isProfileFlag)) throw new Error("--profile may only be specified once");
	if (!["allow", "yolo", "ask", "reload", "debug"].includes(process.argv[2])) {
		throw new Error("--profile is supported by allow, yolo, ask, reload and debug; use SITEGEIST_PROFILE for mcp");
	}
	return { positional: [...rest.slice(0, i), ...rest.slice(end)], profile };
}

/** Client for a one-shot maintenance command, on the --profile bridge if given. */
async function maintenanceClient(name: string, profile: string | undefined): Promise<BridgeClient> {
	const client = new BridgeClient({ name, profile: profile ? resolveProfile(profile) : undefined });
	await client.connect();
	return client;
}

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);
	const { positional, profile } = parseArgs();
	switch (command) {
		case "host":
			runNativeHost();
			return;
		case "mcp":
			await runMcpServer();
			return;
		case "install": {
			const result = install({ force: process.argv.includes("--force") });
			console.log(`launcher: ${result.launcher}`);
			for (const f of result.written) console.log(`wrote   ${f}`);
			for (const f of result.skipped) console.log(`current ${f}`);
			if (result.written.length + result.skipped.length === 0) console.log("no Chromium browser profile directories found");
			console.log("Reload the sitegeist extension once if it was loaded before this install.");
			return;
		}
		case "status":
			await status();
			return;
		case "profiles":
			for (const line of profileStatusLines(await probeBridges())) console.log(line);
			return;
		case "allow": {
			const [host] = positional;
			if (!host) throw new Error("usage: sitegeist allow <host> [--profile <profile>]");
			const client = await maintenanceClient("allow", profile);
			console.log(JSON.stringify(await client.call("permission.allow", { host }, 5000)));
			client.close();
			return;
		}
		case "yolo":
		case "ask": {
			const mode = command === "yolo" ? "allow_all" : "ask";
			const client = await maintenanceClient(command, profile);
			console.log(JSON.stringify(await client.call("permission.setMode", { mode }, 5000)));
			client.close();
			return;
		}
		case "debug": {
			const client = await maintenanceClient("debug", profile);
			const info = (await client.call("bridge.debug", {}, 5000)) as Record<string, unknown>;
			const bench = (await client.call("bridge.bench", {}, 30000)) as Record<string, unknown>;
			console.log(JSON.stringify({ ...info, bench }, null, 2));
			client.close();
			return;
		}
		case "reload": {
			// Refuse to reload onto a broken bundle: a half-written dist-chrome unloads the extension.
			const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-chrome");
			const required = ["manifest.json", "background.js", "sidepanel.js", "sidepanel.html", "app.css"];
			const missing = required.filter((f) => !existsSync(join(dist, f)));
			if (existsSync(dist) && missing.length > 0) {
				throw new Error(`dist-chrome is incomplete (missing ${missing.join(", ")}); run \`npm run build\` first`);
			}
			const client = await maintenanceClient("reload", profile);
			console.log(JSON.stringify(await client.call("bridge.reload", {}, 5000)));
			client.close();
			return;
		}
		case "pi-extension":
			console.log(`wrote ${writePiExtension(process.argv[3])}`);
			return;
		case "--version":
		case "-v":
			console.log(VERSION);
			return;
		default:
			process.stdout.write(HELP);
			if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
