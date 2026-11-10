import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameParser } from "../src/framing.ts";

assert.ok(process.env.SITEGEIST_CLAUDE, "Set SITEGEIST_CLAUDE to the absolute installed claude executable");
const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "claude-host"], {
	stdio: ["pipe", "pipe", "pipe"],
	env: process.env,
});
let stderr = "";
let failure;
const events = [];
const parser = new FrameParser(900 * 1024);
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
child.stdout.on("data", (chunk) => {
	try {
		for (const event of parser.push(chunk)) {
			events.push(event);
			if (event.type === "error") failure = new Error(JSON.stringify(event));
		}
	} catch (error) {
		failure = error;
	}
});
child.on("error", (error) => {
	failure = error;
});
child.on("exit", (code, signal) => {
	failure ??= new Error(`Host exited: ${code}/${signal}: ${stderr}`);
});
const send = (message) => child.stdin.write(encodeFrame(message));
async function waitFor(type, offset = 0) {
	const deadline = Date.now() + 120000;
	while (Date.now() < deadline) {
		if (failure) throw failure;
		const event = events.slice(offset).find((event) => event.type === type);
		if (event) return event;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timeout waiting for ${type}: ${JSON.stringify(events)} ${stderr}`);
}
const sessionId = randomUUID();
try {
	send({ type: "start", sessionId, resume: false });
	const ready = await waitFor("ready");
	assert.equal(ready.sessionId, sessionId);
	assert.ok(ready.resumeCommand.includes(`claude --resume ${sessionId}`));
	console.log(`ready: ${sessionId}, cwd: ${ready.cwd}`);
	send({ type: "say", text: "reply with the word ok" });
	await waitFor("turn_end");
	const first = events
		.filter((event) => event.type === "text")
		.map((event) => event.delta)
		.join("");
	assert.match(first, /ok/i);
	console.log(`first turn: ${first}`);
	send({ type: "end" });
	await waitFor("exited");
	const offset = events.length;
	send({ type: "start", sessionId, resume: true });
	await waitFor("ready", offset);
	send({ type: "say", text: "what was my previous message?" });
	await waitFor("turn_end", offset);
	const resumed = events
		.slice(offset)
		.filter((event) => event.type === "text")
		.map((event) => event.delta)
		.join("");
	assert.match(resumed, /reply with the word ok/i);
	console.log(`resumed turn: ${resumed}`);
	const endOffset = events.length;
	send({ type: "end" });
	await waitFor("exited", endOffset);
	const projects = join(homedir(), ".claude", "projects");
	const transcript = readdirSync(projects)
		.map((dir) => join(projects, dir, `${sessionId}.jsonl`))
		.find(existsSync);
	assert.ok(transcript, "Claude persisted the session transcript");
	assert.ok(readFileSync(transcript, "utf8").includes("reply with the word ok"));
	console.log(`PASS: native frames, fresh turn, end, resume, transcript ${transcript}`);
} finally {
	child.stdin.end();
	const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
	await new Promise((resolve) => ((child.exitCode !== null || child.signalCode !== null) ? resolve() : child.once("exit", resolve)));
	clearTimeout(timeout);
}
