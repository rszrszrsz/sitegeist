import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const ToolPhase = Type.Union([
	Type.Literal("start"),
	Type.Literal("done"),
	Type.Literal("denied"),
	Type.Literal("failed"),
]);

export const Failure = Type.Union([
	Type.Literal("not_installed"),
	Type.Literal("not_logged_in"),
	Type.Literal("limit"),
	Type.Literal("crashed"),
]);

const ToolEvent = {
	toolUseId: Type.String(),
	name: Type.String(),
	phase: ToolPhase,
	detail: Type.Optional(Type.String()),
};

export const HostEvent = Type.Union([
	Type.Object({
		type: Type.Literal("ready"),
		sessionId: Type.String(),
		cwd: Type.String(),
		resumeCommand: Type.String(),
	}),
	Type.Object({ type: Type.Literal("text"), messageId: Type.String(), delta: Type.String() }),
	Type.Object({ type: Type.Literal("tool"), ...ToolEvent }),
	Type.Object({ type: Type.Literal("turn_end") }),
	Type.Object({ type: Type.Literal("error"), reason: Failure, message: Type.String() }),
	Type.Object({ type: Type.Literal("exited"), code: Type.Union([Type.Number(), Type.Null()]) }),
]);

export const LogItem = Type.Union([
	Type.Object({ kind: Type.Literal("user"), text: Type.String() }),
	Type.Object({ kind: Type.Literal("assistant"), messageId: Type.String(), text: Type.String() }),
	Type.Object({ kind: Type.Literal("tool"), ...ToolEvent }),
]);

export const Chat = Type.Object({
	id: Type.String(),
	homeTabId: Type.Number(),
	title: Type.String(),
	createdAt: Type.String(),
	lastModified: Type.String(),
	items: Type.Array(LogItem),
	resumeCommand: Type.String(),
	phase: Type.Union([Type.Literal("closed"), Type.Literal("handedOff")]),
});

export function parseHostEvent(value: unknown): Static<typeof HostEvent> {
	if (!Value.Check(HostEvent, value)) throw new Error("Invalid Claude host event");
	return value;
}
