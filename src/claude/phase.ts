import type { Static } from "@sinclair/typebox";
import type { ClaudeFailure, ClaudeHostEvent } from "./protocol.js";
import type { LogItem } from "./schema.js";

export type ClaudeLogItem = Static<typeof LogItem>;

export type ChatPhase =
	| { kind: "closed" }
	| { kind: "starting" }
	| { kind: "ready" }
	| { kind: "turn" }
	| { kind: "handedOff"; resumeCommand: string }
	| { kind: "failed"; reason: ClaudeFailure; message: string };

export interface ClaudeChatState {
	phase: ChatPhase;
	items: ClaudeLogItem[];
	resumeCommand: string;
	exitIntent: "handoff" | null;
}

export type ClaudeAction =
	| ClaudeHostEvent
	| { type: "start" }
	| { type: "say"; text: string }
	| { type: "interrupt" }
	| { type: "end" }
	| { type: "disconnect"; message?: string };

export function transition(state: ClaudeChatState, action: ClaudeAction): ClaudeChatState {
	switch (action.type) {
		case "start":
			return { ...state, phase: { kind: "starting" }, exitIntent: null };
		case "ready":
			return {
				...state,
				phase: state.phase.kind === "turn" ? state.phase : { kind: "ready" },
				resumeCommand: action.resumeCommand,
			};
		case "say":
			return { ...state, phase: { kind: "turn" }, items: [...state.items, { kind: "user", text: action.text }] };
		case "text": {
			const existing = state.items.some((item) => item.kind === "assistant" && item.messageId === action.messageId);
			return {
				...state,
				items: existing
					? state.items.map((item) =>
							item.kind === "assistant" && item.messageId === action.messageId
								? { ...item, text: item.text + action.delta }
								: item,
						)
					: [...state.items, { kind: "assistant", messageId: action.messageId, text: action.delta }],
			};
		}
		case "tool": {
			const item: ClaudeLogItem = {
				kind: "tool",
				toolUseId: action.toolUseId,
				name: action.name,
				phase: action.phase,
				detail: action.detail,
			};
			return {
				...state,
				items: state.items.some((entry) => entry.kind === "tool" && entry.toolUseId === action.toolUseId)
					? state.items.map((entry) =>
							entry.kind === "tool" && entry.toolUseId === action.toolUseId ? item : entry,
						)
					: [...state.items, item],
			};
		}
		case "turn_end":
			return state.phase.kind === "failed" ? state : { ...state, phase: { kind: "ready" } };
		case "interrupt":
			return state;
		case "end":
			return { ...state, exitIntent: "handoff" };
		case "exited":
			return {
				...state,
				phase:
					state.exitIntent === "handoff" && state.resumeCommand
						? { kind: "handedOff", resumeCommand: state.resumeCommand }
						: state.phase.kind === "failed"
							? state.phase
							: { kind: "closed" },
				exitIntent: null,
			};
		case "error":
			return {
				...state,
				phase: { kind: "failed", reason: action.reason, message: action.message },
				exitIntent: null,
			};
		case "disconnect":
			if (state.phase.kind === "handedOff" || state.phase.kind === "failed") return state;
			return {
				...state,
				phase: action.message ? { kind: "failed", reason: "crashed", message: action.message } : { kind: "closed" },
				exitIntent: null,
			};
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
	}
}
