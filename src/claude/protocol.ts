export const CLAUDE_HOST_NAME = "ai.sitegeist.claude";

export type ClaudeFailure = "not_installed" | "not_logged_in" | "limit" | "crashed";

export type PanelToClaudeHost =
	| { type: "start"; sessionId: string; resume: boolean; profileMarker?: string; pageUrl?: string }
	| { type: "say"; text: string }
	| { type: "interrupt" }
	| { type: "end" };

export type ClaudeToolPhase = "start" | "done" | "denied" | "failed";

export type ClaudeHostEvent =
	| { type: "ready"; sessionId: string; cwd: string; resumeCommand: string }
	| { type: "text"; messageId: string; delta: string }
	| { type: "tool"; toolUseId: string; name: string; phase: ClaudeToolPhase; detail?: string }
	| { type: "turn_end" }
	| { type: "error"; reason: ClaudeFailure; message: string }
	| { type: "exited"; code: number | null };

export type ChatPhase =
	| { kind: "closed" }
	| { kind: "starting" }
	| { kind: "ready" }
	| { kind: "turn" }
	| { kind: "handedOff"; resumeCommand: string }
	| { kind: "failed"; reason: ClaudeFailure; message: string };
