import type { Static } from "@sinclair/typebox";
import type { Failure, HostEvent, ToolPhase } from "./schema.js";

export const CLAUDE_HOST_NAME = "ai.sitegeist.claude";
export const CLAUDE_CLIENT_NAME = "claude";

export type ClaudeFailure = Static<typeof Failure>;
export type ClaudeToolPhase = Static<typeof ToolPhase>;
export type ClaudeHostEvent = Static<typeof HostEvent>;

export type PanelToClaudeHost =
	| { type: "start"; sessionId: string; resume: boolean; profileMarker?: string; pageUrl?: string }
	| { type: "say"; text: string }
	| { type: "interrupt" }
	| { type: "end" };
