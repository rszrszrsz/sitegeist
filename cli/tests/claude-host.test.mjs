import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { encodeFrame, FrameParser } from "../src/framing.ts";

async function host(t, executable) {
	const root = mkdtempSync(join(tmpdir(), "sitegeist-claude-"));
	const log = join(root, "launches.jsonl");
	const fake = join(root, "claude");
	writeFileSync(
		fake,
		`#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.SG_HOST_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const args = process.argv.slice(2);
const id = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
 const x = JSON.parse(line);
 if (x.type === "control_request") { emit({ type: "control_response", response: { subtype: "success", request_id: x.request_id } }); return; }
 if (x.message.content === "crash") { process.stderr.write("Not logged in. Please run /login"); process.exit(1); }
 emit({ type: "system", subtype: "init", session_id: id, cwd: process.cwd() });
 emit({ type: "assistant", message: { id: "message", content: [{ type: "text", text: x.message.content }] } });
 emit({ type: "result", subtype: "success" });
});
`,
	);
	chmodSync(fake, 0o755);
	const browser =
		process.platform === "darwin"
			? join(root, "Library", "Application Support", "Google", "Chrome")
			: join(root, ".config", "google-chrome");
	mkdirSync(join(browser, "Profile 7", "Local Extension Settings", "bbkgpflnkggdfabgjhofdmdopgjopamc"), {
		recursive: true,
	});
	writeFileSync(
		join(browser, "Local State"),
		JSON.stringify({ profile: { info_cache: { "Profile 7": { name: "Panel profile" } } } }),
	);
	writeFileSync(
		join(browser, "Profile 7", "Local Extension Settings", "bbkgpflnkggdfabgjhofdmdopgjopamc", "000001.log"),
		"panel-marker",
	);
	const env = { ...process.env, HOME: root, SG_HOST_LOG: log };
	if (executable === null) delete env.SITEGEIST_CLAUDE;
	else env.SITEGEIST_CLAUDE = executable ?? fake;
	const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "claude-host"], {
		env,
	});
	const events = [];
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const parser = new FrameParser(900 * 1024);
	child.stdout.on("data", (chunk) => events.push(...parser.push(chunk)));
	t.after(async () => {
		child.stdin.end();
		const kill = setTimeout(() => child.kill("SIGKILL"), 6000);
		await new Promise((resolve) => ((child.exitCode !== null || child.signalCode !== null) ? resolve() : child.once("exit", resolve)));
		clearTimeout(kill);
		rmSync(root, { recursive: true, force: true });
	});
	return {
		events,
		send: (event) => child.stdin.write(encodeFrame(event)),
		launches: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
		async wait(type, offset = 0) {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const event = events.slice(offset).find((event) => event.type === type);
				if (event) return event;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.fail(`Timed out waiting for ${type}: ${JSON.stringify(events)} ${stderr}`);
		},
	};
}

test(
	"native interrupt resumes the transcript on next say and resolves the panel profile",
	{ skip: process.platform === "win32" },
	async (t) => {
		const h = await host(t);
		const sessionId = randomUUID();
		h.send({
			type: "start",
			sessionId,
			resume: false,
			profileMarker: "panel-marker",
			pageUrl: "https://example.org",
		});
		await h.wait("ready");
		h.send({ type: "say", text: "first" });
		await h.wait("turn_end");
		h.send({ type: "interrupt" });
		await h.wait("exited");
		const offset = h.events.length;
		h.send({ type: "say", text: "second" });
		await h.wait("turn_end", offset);
		const launches = h.launches();
		assert.equal(launches.length, 2);
		assert.ok(launches[0].args.includes("--session-id"));
		assert.ok(launches[1].args.includes("--resume"));
		assert.equal(launches[1].args[launches[1].args.indexOf("--resume") + 1], sessionId);
		const config = JSON.parse(launches[0].args[launches[0].args.indexOf("--mcp-config") + 1]);
		assert.equal(config.mcpServers.sitegeist.env.SITEGEIST_PROFILE, "Chrome/Profile 7");
		assert.match(launches[0].args.at(-1), /https:\/\/example.org/);
		assert.deepEqual(
			h.events.filter((e) => e.type === "text").map((e) => e.delta),
			["first", "second"],
		);
		const endOffset = h.events.length;
		h.send({ type: "end" });
		assert.equal((await h.wait("exited", endOffset)).code, 0);
	},
);

for (const executable of [null, "/missing/sitegeist-claude"]) {
	test(`missing Claude executable ${executable} reports not_installed`, async (t) => {
		const h = await host(t, executable);
		h.send({ type: "start", sessionId: randomUUID(), resume: false });
		assert.equal((await h.wait("error")).reason, "not_installed");
	});
}

test(
	"a child failing authentication is classified using its stderr tail",
	{ skip: process.platform === "win32" },
	async (t) => {
		const h = await host(t);
		h.send({ type: "start", sessionId: randomUUID(), resume: false });
		await h.wait("ready");
		h.send({ type: "say", text: "crash" });
		const error = await h.wait("error");
		assert.equal(error.reason, "not_logged_in");
		assert.match(error.message, /Please run \/login/);
		assert.equal((await h.wait("exited")).code, 1);
	},
);
