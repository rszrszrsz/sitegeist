import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClaudeStream } from "../src/claude-stream.ts";

function fixture(name) {
	const translate = createClaudeStream();
	return readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), "utf8")
		.trim()
		.split("\n")
		.flatMap(translate);
}

test("recorded partial text appears once across two turns, ignoring user replays", () => {
	assert.deepEqual(fixture("run1"), [
		{ type: "text", messageId: "msg_011CgugGDZ4VHycSSX8oZqR5", delta: "ok" },
		{ type: "turn_end" },
		{ type: "text", messageId: "msg_011CgugGPCjgTvS62dndUiXG", delta: "kiwi" },
		{ type: "turn_end" },
	]);
});

test("a streamed tool and its completed assistant block produce one start and one completion", () => {
	assert.deepEqual(fixture("run3"), [
		{ type: "tool", toolUseId: "toolu_01VSvmo3yDdH6yMGJekx559u", name: "mcp__probe__echo", phase: "start" },
		{ type: "tool", toolUseId: "toolu_01VSvmo3yDdH6yMGJekx559u", name: "mcp__probe__echo", phase: "done" },
		{ type: "text", messageId: "msg_011CgugKaH5YEtLf5rM6g6Xq", delta: "ok" },
		{ type: "turn_end" },
	]);
});

test("recorded denial is reported even when the turn succeeds", () => {
	assert.deepEqual(fixture("run4"), [
		{ type: "tool", toolUseId: "toolu_01HahH5YHY51uVVifqMQPfHC", name: "mcp__probe__echo", phase: "start" },
		{ type: "tool", toolUseId: "toolu_01HahH5YHY51uVVifqMQPfHC", name: "mcp__probe__echo", phase: "failed" },
		{ type: "text", messageId: "msg_011CgugLCRwiL4ro6g1W9ZAL", delta: "denied" },
		{ type: "tool", toolUseId: "toolu_01HahH5YHY51uVVifqMQPfHC", name: "mcp__probe__echo", phase: "denied" },
		{ type: "turn_end" },
	]);
});

test("thinking and text sharing an assistant message id do not lose the text", () => {
	const events = fixture("run5");
	assert.equal(events.length, 2);
	assert.equal(events[0].type, "text");
	assert.match(events[0].delta, /I have these tools now/);
	assert.deepEqual(events[1], { type: "turn_end" });
});

test("tool results never expose screenshots or text payloads and replay results are ignored", () => {
	const translate = createClaudeStream();
	const result = {
		type: "user",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					content: [
						{ type: "image", source: { type: "base64", data: "x".repeat(1000000) } },
						{ type: "text", text: "sensitive tool result" },
					],
				},
			],
		},
	};
	assert.deepEqual(translate(JSON.stringify({ ...result, isReplay: true })), []);
	assert.deepEqual(translate(JSON.stringify(result)), [
		{ type: "tool", toolUseId: "tool-1", name: "", phase: "done" },
	]);
});

for (const [subtype, errors, reason] of [
	["error_during_execution", ["Not logged in. Please run /login"], "not_logged_in"],
	["error_during_execution", ["You've hit your usage limit"], "limit"],
	["error_max_turns", [], "limit"],
	["error_during_execution", ["Unexpected failure"], "crashed"],
]) {
	test(`error result ${errors[0] ?? subtype} ends the turn with ${reason}`, () => {
		const events = createClaudeStream()(JSON.stringify({ type: "result", subtype, is_error: true, errors }));
		assert.equal(events[0].type, "error");
		assert.equal(events[0].reason, reason);
		assert.deepEqual(events[1], { type: "turn_end" });
	});
}
