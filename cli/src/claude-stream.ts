import { z } from "zod";
import type { ClaudeFailure, ClaudeHostEvent } from "../../src/claude/protocol.ts";

const blockSchema = z.union([
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string() }),
	z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.boolean().optional() }),
	z.object({ type: z.string() }),
]);
const streamSchema = z.object({
	type: z.string(),
	isReplay: z.boolean().optional(),
	subtype: z.string().optional(),
	is_error: z.boolean().optional(),
	error: z.string().optional(),
	result: z.string().optional(),
	errors: z.array(z.string()).optional(),
	permission_denials: z.array(z.object({ tool_use_id: z.string(), tool_name: z.string() })).optional(),
	message: z
		.object({ id: z.string().optional(), content: z.union([z.string(), z.array(blockSchema)]).optional() })
		.optional(),
	event: z
		.object({
			type: z.string(),
			message: z.object({ id: z.string() }).optional(),
			content_block: blockSchema.optional(),
			delta: z.object({ type: z.string().optional(), text: z.string().optional() }).optional(),
		})
		.optional(),
});
const envelopeSchema = z.object({ type: z.string() });

export function claudeFailure(message: string): ClaudeFailure {
	if (
		/not.logged.in|login required|please (?:run|log)|authentication|unauthorized|invalid.api.key|oauth.*(?:expired|invalid)|401/i.test(
			message,
		)
	)
		return "not_logged_in";
	if (/limit|quota|rate.?limit|max_turns|max_budget|overloaded|429/i.test(message)) return "limit";
	return "crashed";
}

export function createClaudeStream(): (line: string) => ClaudeHostEvent[] {
	let messageId = "";
	const streamed = new Set<string>();
	const tools = new Map<string, string>();
	const finished = new Set<string>();
	return (line) => {
		const raw: unknown = JSON.parse(line);
		if (!["stream_event", "assistant", "user", "result"].includes(envelopeSchema.parse(raw).type)) return [];
		const parsed = streamSchema.parse(raw);
		const events: ClaudeHostEvent[] = [];
		const startTool = (id: string, name: string) => {
			if (tools.has(id)) return;
			tools.set(id, name);
			events.push({ type: "tool", toolUseId: id, name, phase: "start" });
		};
		if (parsed.type === "stream_event" && parsed.event) {
			const event = parsed.event;
			if (event.type === "message_start" && event.message) messageId = event.message.id;
			if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
				streamed.add(messageId);
				events.push({ type: "text", messageId, delta: event.delta.text });
			}
			if (
				event.type === "content_block_start" &&
				event.content_block?.type === "tool_use" &&
				"id" in event.content_block
			) {
				startTool(event.content_block.id, event.content_block.name);
			}
		}
		if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
			const id = parsed.message.id ?? messageId;
			for (const block of parsed.message.content) {
				if (block.type === "text" && "text" in block && !streamed.has(id))
					events.push({ type: "text", messageId: id, delta: block.text });
				if (block.type === "tool_use" && "id" in block) startTool(block.id, block.name);
			}
		}
		if (parsed.type === "user" && !parsed.isReplay && Array.isArray(parsed.message?.content)) {
			for (const block of parsed.message.content) {
				if (block.type !== "tool_result" || !("tool_use_id" in block) || finished.has(block.tool_use_id)) continue;
				finished.add(block.tool_use_id);
				events.push({
					type: "tool",
					toolUseId: block.tool_use_id,
					name: tools.get(block.tool_use_id) ?? "",
					phase: block.is_error ? "failed" : "done",
				});
			}
		}
		if (parsed.type === "result") {
			for (const denial of parsed.permission_denials ?? []) {
				events.push({ type: "tool", toolUseId: denial.tool_use_id, name: denial.tool_name, phase: "denied" });
			}
			if (parsed.is_error || (parsed.subtype && parsed.subtype !== "success")) {
				const message = [...(parsed.errors ?? []), parsed.result, parsed.error, parsed.subtype]
					.filter(Boolean)
					.join(" ");
				events.push({ type: "error", reason: claudeFailure(message), message: message.slice(0, 2000) });
			}
			events.push({ type: "turn_end" });
		}
		return events;
	};
}
