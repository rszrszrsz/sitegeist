/**
 * Browser profiles: which Chromium profiles exist, which one a native host serves,
 * and how to open one. The browser gives neither the extension nor the host its
 * profile path, so the host looks for the extension's marker in each profile's
 * extension storage (LevelDB appends writes to its .log file as they happen).
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserProfile } from "../../src/bridge/protocol.ts";

/** Stable id from the `key` in static/manifest.chrome.json. */
export const EXTENSION_ID = "bbkgpflnkggdfabgjhofdmdopgjopamc";

interface Browser {
	label: string;
	userDataDir: string;
	/** macOS app name or Linux executable; omitted when the browser has no --profile-directory. */
	launcher?: string;
}

export function browsers(): Browser[] {
	const home = homedir();
	if (process.platform === "darwin") {
		const base = join(home, "Library", "Application Support");
		return [
			{ label: "Chrome", userDataDir: join(base, "Google", "Chrome"), launcher: "Google Chrome" },
			{ label: "Chrome Beta", userDataDir: join(base, "Google", "Chrome Beta"), launcher: "Google Chrome Beta" },
			{ label: "Chrome Canary", userDataDir: join(base, "Google", "Chrome Canary"), launcher: "Google Chrome Canary" },
			{ label: "Chromium", userDataDir: join(base, "Chromium"), launcher: "Chromium" },
			{ label: "Brave", userDataDir: join(base, "BraveSoftware", "Brave-Browser"), launcher: "Brave Browser" },
			{ label: "Edge", userDataDir: join(base, "Microsoft Edge"), launcher: "Microsoft Edge" },
			{ label: "Arc", userDataDir: join(base, "Arc", "User Data") },
			{ label: "Vivaldi", userDataDir: join(base, "Vivaldi"), launcher: "Vivaldi" },
			{ label: "Opera", userDataDir: join(base, "com.operasoftware.Opera") },
		];
	}
	if (process.platform === "linux") {
		const cfg = join(home, ".config");
		return [
			{ label: "Chrome", userDataDir: join(cfg, "google-chrome"), launcher: "google-chrome" },
			{ label: "Chrome Beta", userDataDir: join(cfg, "google-chrome-beta"), launcher: "google-chrome-beta" },
			{ label: "Chromium", userDataDir: join(cfg, "chromium"), launcher: "chromium" },
			{ label: "Brave", userDataDir: join(cfg, "BraveSoftware", "Brave-Browser"), launcher: "brave-browser" },
			{ label: "Edge", userDataDir: join(cfg, "microsoft-edge"), launcher: "microsoft-edge" },
			{ label: "Vivaldi", userDataDir: join(cfg, "vivaldi"), launcher: "vivaldi" },
			{ label: "Opera", userDataDir: join(cfg, "opera") },
		];
	}
	return [];
}

function extensionStorageDir(profile: Pick<BrowserProfile, "userDataDir" | "directory">): string {
	return join(profile.userDataDir, profile.directory, "Local Extension Settings", EXTENSION_ID);
}

/** Profiles listed in a browser's Local State; [] when it has none or cannot be read. */
function profilesOf(browser: Browser): BrowserProfile[] {
	let cache: Record<string, { name?: string; user_name?: string }>;
	try {
		const state = JSON.parse(readFileSync(join(browser.userDataDir, "Local State"), "utf8"));
		cache = state?.profile?.info_cache ?? {};
	} catch {
		return [];
	}
	return Object.entries(cache).map(([directory, info]) => ({
		browser: browser.label,
		userDataDir: browser.userDataDir,
		directory,
		name: info.name || undefined,
		email: info.user_name || undefined,
	}));
}

export function listProfiles(): BrowserProfile[] {
	return browsers().flatMap(profilesOf);
}

/** The extension has run in this profile (it writes its storage on every start). */
export function hasExtension(profile: BrowserProfile): boolean {
	return existsSync(extensionStorageDir(profile));
}

/** The profile whose extension storage holds `marker`, or undefined. */
export function findProfileByMarker(marker: string): BrowserProfile | undefined {
	const needle = Buffer.from(marker, "utf8");
	for (const profile of listProfiles()) {
		const dir = extensionStorageDir(profile);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".log"));
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				if (readFileSync(join(dir, file)).includes(needle)) return profile;
			} catch {
				/* rotated away while reading */
			}
		}
	}
	return undefined;
}

export function sameProfile(a: BrowserProfile | undefined, b: BrowserProfile | undefined): boolean {
	return !!a && !!b && a.userDataDir === b.userDataDir && a.directory === b.directory;
}

export function describeProfile(profile: BrowserProfile): string {
	const label = profile.name && profile.name !== profile.email ? `${profile.name} ` : "";
	const email = profile.email ? `<${profile.email}> ` : "";
	return `${label}${email}(${profile.browser}/${profile.directory})`.trim();
}

/**
 * Profiles matching `query` by directory, display name, or email (case-insensitive).
 * "Chrome/Profile 3" narrows the directory to one browser.
 */
function matchProfiles(query: string, profiles: BrowserProfile[] = listProfiles()): BrowserProfile[] {
	const q = query.trim().toLowerCase();
	return profiles.filter((p) =>
		[p.directory, p.name, p.email, `${p.browser}/${p.directory}`].some((v) => v?.toLowerCase() === q),
	);
}

/** Exactly one profile for `query`, or an error that lists the candidates. */
export function resolveProfile(query: string): BrowserProfile {
	const matches = matchProfiles(query);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`No browser profile matches "${query}". Known: ${listProfiles().map(describeProfile).join(", ")}`);
	throw new Error(`"${query}" matches several profiles: ${matches.map(describeProfile).join(", ")}. Use Browser/Directory.`);
}

/**
 * One line per known profile: current (the caller's bridge), open (bridge running),
 * closed (the extension has run there), no-extension.
 */
export function profileStatusLines(bridges: Array<{ profile?: BrowserProfile }>, current?: BrowserProfile): string[] {
	const status = (p: BrowserProfile) => {
		if (sameProfile(p, current)) return "current";
		if (bridges.some((b) => sameProfile(b.profile, p))) return "open";
		return hasExtension(p) ? "closed" : "no-extension";
	};
	const lines = listProfiles().map((p) => `${status(p).padEnd(12)} ${describeProfile(p)}`);
	const unknown = bridges.filter((b) => !b.profile).length;
	if (unknown) lines.push(`${unknown} running bridge(s) could not tell their profile`);
	return lines;
}

/** Ask the browser for a window of the profile; a running browser picks the request up. */
export function openProfile(profile: BrowserProfile): Promise<void> {
	const launcher = browsers().find((b) => b.userDataDir === profile.userDataDir)?.launcher;
	if (!launcher) return Promise.reject(new Error(`Opening profiles is not supported for ${profile.browser}`));
	const flag = `--profile-directory=${profile.directory}`;
	return new Promise((resolve, reject) => {
		if (process.platform === "darwin") {
			// `open` hands the request to the browser and exits; non-zero means the app is missing.
			const child = spawn("open", ["-na", launcher, "--args", flag], { stdio: "ignore" });
			child.once("error", reject);
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`))));
		} else {
			// The browser binary may keep running as the browser itself; do not wait for it.
			const child = spawn(launcher, [flag], { detached: true, stdio: "ignore" });
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		}
	});
}
