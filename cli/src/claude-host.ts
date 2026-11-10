import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { MAX_FRAME_TO_EXTENSION, MAX_FRAME_FROM_EXTENSION } from "../../src/bridge/protocol.ts";
import type { ClaudeHostEvent, PanelToClaudeHost } from "../../src/claude/protocol.ts";
import { claudeFailure, createClaudeStream } from "./claude-stream.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { findProfileByMarker, resolveProfile, sameProfile } from "./profiles.ts";

const panelSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("start"),
		sessionId: z.string().uuid(),
		resume: z.boolean(),
		profileMarker: z.string().min(1).optional(),
		pageUrl: z.string().optional(),
	}),
	z.object({ type: z.literal("say"), text: z.string() }),
	z.object({ type: z.literal("interrupt") }),
	z.object({ type: z.literal("end") }),
]);
const initSchema = z.object({
	type: z.literal("system"),
	subtype: z.literal("init"),
	cwd: z.string(),
	session_id: z.string(),
});
const initializedSchema = z.object({
	type: z.literal("control_response"),
	response: z.object({ subtype: z.literal("success"), request_id: z.literal("sitegeist-initialize") }),
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runClaudeHost(): void {
	const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
	let session: Extract<PanelToClaudeHost, { type: "start" }> | undefined;
	let active: ReturnType<typeof launch> | undefined;
	let closed = false;
	let commands = Promise.resolve();

	function emit(event: ClaudeHostEvent): void {
		if (closed) return;
		if (event.type === "text" && event.delta.length > 64000) {
			for (let offset = 0; offset < event.delta.length; offset += 64000)
				emit({ ...event, delta: event.delta.slice(offset, offset + 64000) });
			return;
		}
		const frame = encodeFrame(event);
		if (frame.length - 4 > MAX_FRAME_TO_EXTENSION) throw new Error("Claude event exceeds native messaging budget");
		process.stdout.write(frame);
	}

	function launch(start: Extract<PanelToClaudeHost, { type: "start" }>) {
		const executable = process.env.SITEGEIST_CLAUDE;
		if (!executable || !isAbsolute(executable)) {
			emit({
				type: "error",
				reason: "not_installed",
				message: "Claude Code was not found. Install claude and run sitegeist install again.",
			});
			return undefined;
		}
		const cwd = join(homedir(), "sitegeist-chats");
		mkdirSync(cwd, { recursive: true });
		const mcpEnv: Record<string, string> = {};
		if (start.profileMarker) {
			const profile = findProfileByMarker(start.profileMarker);
			if (!profile) throw new Error("Could not find the browser profile for this panel");
			const selector = `${profile.browser}/${profile.directory}`;
			if (!sameProfile(profile, resolveProfile(selector)))
				throw new Error("Browser profile selector did not round trip");
			mcpEnv.SITEGEIST_PROFILE = selector;
		}
		const config = {
			mcpServers: { sitegeist: { command: process.execPath, args: [process.argv[1], "mcp"], env: mcpEnv } },
		};
		const prompt = `The user is chatting from the Sitegeist side panel. Their page is ${start.pageUrl ?? "the current browser page"}. That tab is already your current Sitegeist tab: read it with read_page or get_page_text without navigating. Answer in the user's language.`;
		const child = spawn(
			executable,
			[
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				start.resume ? "--resume" : "--session-id",
				start.sessionId,
				"--strict-mcp-config",
				"--mcp-config",
				JSON.stringify(config),
				"--tools",
				"",
				"--allowedTools",
				"mcp__sitegeist",
				"--permission-mode",
				"dontAsk",
				"--append-system-prompt",
				prompt,
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		const state = {
			child,
			intentional: false,
			reportedError: false,
			ready: false,
			stderr: "",
			done: Promise.resolve(),
		};
		const translate = createClaudeStream();
		const ready = (sessionId: string, directory: string) => {
			if (state.ready) return;
			state.ready = true;
			emit({
				type: "ready",
				sessionId,
				cwd: directory,
				resumeCommand: `cd ${shellQuote(directory)} && claude --resume ${sessionId}`,
			});
		};
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			try {
				const raw = JSON.parse(line);
				const init = initSchema.safeParse(raw);
				if (init.success) {
					session = { ...start, resume: true };
					ready(init.data.session_id, init.data.cwd);
				}
				if (initializedSchema.safeParse(raw).success) ready(start.sessionId, realpathSync(cwd));
				for (const event of translate(line)) {
					if (event.type === "error") state.reportedError = true;
					emit(event);
				}
			} catch (error) {
				state.reportedError = true;
				emit({
					type: "error",
					reason: "crashed",
					message: `Invalid Claude stream: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						2000,
					),
				});
				child.kill("SIGTERM");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			state.stderr = (state.stderr + chunk.toString("utf8")).slice(-4000);
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") process.stderr.write(`${error.message}\n`);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			state.reportedError = true;
			emit({
				type: "error",
				reason: error.code === "ENOENT" ? "not_installed" : "crashed",
				message: error.message.slice(0, 2000),
			});
		});
		state.done = new Promise<void>((resolve) => {
			child.once("close", (code) => {
				if (!state.intentional && !state.reportedError && code !== 0) {
					const message = state.stderr.trim() || `Claude exited with code ${code}`;
					emit({ type: "error", reason: claudeFailure(message), message });
				}
				if (active === state) active = undefined;
				emit({ type: "exited", code });
				resolve();
			});
		});
		child.stdin.write(
			`${JSON.stringify({ type: "control_request", request_id: "sitegeist-initialize", request: { subtype: "initialize" } })}\n`,
		);
		return state;
	}

	async function stop(interrupt: boolean): Promise<void> {
		const state = active;
		if (!state) {
			emit({ type: "exited", code: null });
			return;
		}
		state.intentional = true;
		if (interrupt) state.child.kill("SIGTERM");
		else state.child.stdin.end();
		const terminate = setTimeout(() => state.child.kill("SIGTERM"), interrupt ? 1000 : 10000);
		const kill = setTimeout(() => state.child.kill("SIGKILL"), interrupt ? 5000 : 15000);
		await state.done;
		clearTimeout(terminate);
		clearTimeout(kill);
	}

	async function handle(message: PanelToClaudeHost): Promise<void> {
		switch (message.type) {
			case "start":
				if (active) await stop(true);
				session = message;
				active = launch(message);
				return;
			case "say":
				if (!session) throw new Error("Start a Claude session before sending a message");
				if (!active) active = launch(session);
				active?.child.stdin.write(
					`${JSON.stringify({ type: "user", message: { role: "user", content: message.text } })}\n`,
				);
				return;
			case "interrupt":
				await stop(true);
				return;
			case "end":
				await stop(false);
				return;
		}
	}

	process.stdin.on("data", (chunk: Buffer) => {
		try {
			for (const frame of parser.push(chunk)) {
				const message = panelSchema.parse(frame);
				commands = commands
					.then(() => {
						if (!closed) return handle(message);
					})
					.catch((error: unknown) => {
						emit({
							type: "error",
							reason: "crashed",
							message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
						});
					});
			}
		} catch (error) {
			emit({
				type: "error",
				reason: "crashed",
				message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
			});
		}
	});
	const disconnect = () => {
		closed = true;
		process.stdin.destroy();
		void stop(true);
	};
	process.stdin.once("end", disconnect);
	process.stdout.once("error", disconnect);
	process.once("SIGTERM", disconnect);
	process.once("SIGINT", disconnect);
}
