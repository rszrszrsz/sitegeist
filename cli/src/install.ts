/**
 * Writes the native messaging host manifest for every Chromium browser present on
 * this machine, plus the launcher script the manifest points at. Idempotent; run
 * automatically by `sitegeist mcp` when the manifest is missing.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { NATIVE_HOST_NAME } from "../../src/bridge/protocol.ts";
import { browsers, EXTENSION_ID } from "./profiles.ts";

function browserDirs(): string[] {
	return browsers().map((b) => b.userDataDir);
}

function launcherPath(): string {
	return join(homedir(), ".config", "sitegeist", process.platform === "win32" ? "host.cmd" : "host");
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

function launcherSource(): string {
	const node = nodePath();
	const script = process.argv[1];
	if (process.platform === "win32") {
		return `@echo off\r\n"${node}" "${script}" host %*\r\n`;
	}
	return `#!/bin/sh\nexec "${node}" "${script}" host "$@"\n`;
}

function writeLauncher(): string {
	const path = launcherPath();
	mkdirSync(join(homedir(), ".config", "sitegeist"), { recursive: true, mode: 0o700 });
	writeFileSync(path, launcherSource());
	if (process.platform !== "win32") chmodSync(path, 0o755);
	return path;
}

function manifestFor(launcher: string): string {
	return `${JSON.stringify(
		{
			name: NATIVE_HOST_NAME,
			description: "sitegeist browser bridge",
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
	const manifest = manifestFor(launcher);
	const written: string[] = [];
	const skipped: string[] = [];

	if (process.platform === "win32") {
		const dir = join(homedir(), ".config", "sitegeist");
		const file = join(dir, `${NATIVE_HOST_NAME}.json`);
		writeFileSync(file, manifest);
		for (const hive of ["Google\\Chrome", "BraveSoftware\\Brave-Browser", "Microsoft\\Edge", "Chromium"]) {
			const key = `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
			try {
				execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
				written.push(key);
			} catch {
				skipped.push(key);
			}
		}
		return { launcher, written, skipped };
	}

	for (const dir of browserDirs()) {
		if (!existsSync(dir)) continue;
		const hostsDir = join(dir, "NativeMessagingHosts");
		const file = join(hostsDir, `${NATIVE_HOST_NAME}.json`);
		if (!options.force && existsSync(file) && readFileSync(file, "utf8") === manifest) {
			skipped.push(file);
			continue;
		}
		mkdirSync(hostsDir, { recursive: true });
		writeFileSync(file, manifest);
		written.push(file);
	}
	return { launcher, written, skipped };
}

export function isInstalled(): boolean {
	const launcher = launcherPath();
	if (!existsSync(launcher) || readFileSync(launcher, "utf8") !== launcherSource()) return false;
	if (process.platform === "win32") return existsSync(join(homedir(), ".config", "sitegeist", `${NATIVE_HOST_NAME}.json`));
	const manifest = manifestFor(launcher);
	return browserDirs().some((dir) => {
		const file = join(dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		return existsSync(file) && readFileSync(file, "utf8") === manifest;
	});
}
