import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ClaudeHostEvent } from "./protocol.js";

const HostEvent = Type.Union([
	Type.Object({
		type: Type.Literal("ready"),
		sessionId: Type.String(),
		cwd: Type.String(),
		resumeCommand: Type.String(),
	}),
	Type.Object({ type: Type.Literal("text"), messageId: Type.String(), delta: Type.String() }),
	Type.Object({
		type: Type.Literal("tool"),
		toolUseId: Type.String(),
		name: Type.String(),
		phase: Type.Union([Type.Literal("start"), Type.Literal("done"), Type.Literal("denied"), Type.Literal("failed")]),
		detail: Type.Optional(Type.String()),
	}),
	Type.Object({ type: Type.Literal("turn_end") }),
	Type.Object({
		type: Type.Literal("error"),
		reason: Type.Union([
			Type.Literal("not_installed"),
			Type.Literal("not_logged_in"),
			Type.Literal("limit"),
			Type.Literal("crashed"),
		]),
		message: Type.String(),
	}),
	Type.Object({ type: Type.Literal("exited"), code: Type.Union([Type.Number(), Type.Null()]) }),
]);

export function parseHostEvent(value: unknown): ClaudeHostEvent {
	if (!Value.Check(HostEvent, value)) throw new Error("Invalid Claude host event");
	return value;
}
