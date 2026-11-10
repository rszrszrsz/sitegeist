/**
 * Writes the native messaging host manifest for every Chromium browser present on
 * this machine, plus the launcher script the manifest points at. Idempotent; run
 * automatically by `sitegeist mcp` when the manifest is missing.
 */

import { execFileSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { NATIVE_HOST_NAME } from "../../src/bridge/protocol.ts";
import { CLAUDE_HOST_NAME } from "../../src/claude/protocol.ts";
import { browsers, EXTENSION_ID } from "./profiles.ts";

function browserDirs(): string[] {
	return browsers().map((b) => b.userDataDir);
}

function launcherPath(command = "host"): string {
	return join(homedir(), ".config", "sitegeist", process.platform === "win32" ? `${command}.cmd` : command);
}

function nodePath(): string {
	const executable = realpathSync(process.execPath);
	const name = process.platform === "win32" ? "node.exe" : "node";
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = resolve(directory, name);
		try {
			if (realpathSync(candidate) === executable && lstatSync(candidate).isSymbolicLink()) return candidate;
		} catch {
			continue;
		}
	}
	return process.execPath;
}

function findClaude(): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = resolve(directory, process.platform === "win32" ? "claude.exe" : "claude");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function launcherSource(command = "host"): string {
	const node = nodePath();
	const script = resolve(process.argv[1]);
	const claude = command === "claude-host" ? findClaude() : undefined;
	if (process.platform === "win32") {
		return `@echo off\r\n${claude ? `set "SITEGEIST_CLAUDE=${claude}"\r\n` : ""}"${node}" "${script}" ${command} %*\r\n`;
	}
	return `#!/bin/sh\n${claude ? `export SITEGEIST_CLAUDE=${shellQuote(claude)}\n` : ""}exec ${shellQuote(node)} ${shellQuote(script)} ${command} "$@"\n`;
}

function writeLauncher(command = "host"): string {
	const path = launcherPath(command);
	mkdirSync(join(homedir(), ".config", "sitegeist"), { recursive: true, mode: 0o700 });
	writeFileSync(path, launcherSource(command));
	if (process.platform !== "win32") chmodSync(path, 0o755);
	return path;
}

function manifestFor(launcher: string, name = NATIVE_HOST_NAME): string {
	return `${JSON.stringify(
		{
			name,
			description: name === CLAUDE_HOST_NAME ? "sitegeist Claude panel" : "sitegeist browser bridge",
			path: launcher,
			type: "stdio",
			allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
		},
		null,
		2,
	)}\n`;
}

export interface InstallResult {
	launcher: string;
	written: string[];
	skipped: string[];
}

export function install(options: { force?: boolean } = {}): InstallResult {
	const launcher = writeLauncher();
	const hosts = [
		[NATIVE_HOST_NAME, launcher],
		[CLAUDE_HOST_NAME, writeLauncher("claude-host")],
	];
	const written: string[] = [];
	const skipped: string[] = [];

	if (process.platform === "win32") {
		const dir = join(homedir(), ".config", "sitegeist");
		for (const [name, hostLauncher] of hosts) {
			const file = join(dir, `${name}.json`);
			writeFileSync(file, manifestFor(hostLauncher, name));
			for (const hive of ["Google\\Chrome", "BraveSoftware\\Brave-Browser", "Microsoft\\Edge", "Chromium"]) {
				const key = `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${name}`;
				try {
					execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
					written.push(key);
				} catch {
					skipped.push(key);
				}
			}
		}
		return { launcher, written, skipped };
	}

	for (const dir of browserDirs()) {
		if (!existsSync(dir)) continue;
		const hostsDir = join(dir, "NativeMessagingHosts");
		for (const [name, hostLauncher] of hosts) {
			const manifest = manifestFor(hostLauncher, name);
			const file = join(hostsDir, `${name}.json`);
			if (!options.force && existsSync(file) && readFileSync(file, "utf8") === manifest) {
				skipped.push(file);
				continue;
			}
			mkdirSync(hostsDir, { recursive: true });
			writeFileSync(file, manifest);
			written.push(file);
		}
	}
	return { launcher, written, skipped };
}

export function isInstalled(): boolean {
	const launcher = launcherPath();
	if (!existsSync(launcher) || readFileSync(launcher, "utf8") !== launcherSource()) return false;
	const hosts = [
		[NATIVE_HOST_NAME, launcher],
		[CLAUDE_HOST_NAME, launcherPath("claude-host")],
	];
	if (!existsSync(launcherPath("claude-host"))) return false;
	const hasManifests = (dir: string) =>
		hosts.every(([name, path]) => {
			const file = join(dir, `${name}.json`);
			return existsSync(file) && readFileSync(file, "utf8") === manifestFor(path, name);
		});
	if (process.platform === "win32") return hasManifests(join(homedir(), ".config", "sitegeist"));
	return browserDirs().some((dir) => hasManifests(join(dir, "NativeMessagingHosts")));
}
