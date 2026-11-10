import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html } from "lit";
import { sessionIdForTab } from "../browser/session.js";
import { type ClaudeChat, claudeSessionKey, listClaudeChats, loadClaudeChat } from "./storage.js";

export type ChatBackend = "pi" | "claude";

export type PanelRoute = { kind: "pi"; boundId?: string } | { kind: "choose" } | { kind: "claude"; chat?: ClaudeChat };

export async function routePanel(params: URLSearchParams, homeTabId: number | undefined): Promise<PanelRoute> {
	const sessionId = params.get("session");
	if (sessionId) {
		const chat = await loadClaudeChat(sessionId);
		return chat ? { kind: "claude", chat } : { kind: "pi" };
	}
	const boundId =
		params.get("new") !== "true" && homeTabId !== undefined ? await sessionIdForTab(homeTabId) : undefined;
	if (boundId) {
		const chat = (await listClaudeChats()).find((candidate) => claudeSessionKey(candidate.id) === boundId);
		return chat ? { kind: "claude", chat } : { kind: "pi", boundId };
	}
	const backend = params.get("backend") ?? (await chrome.storage.local.get("chat_backend")).chat_backend;
	if (backend === "claude") return { kind: "claude" };
	return backend === "pi" ? { kind: "pi" } : { kind: "choose" };
}

export async function openClaudeChat(
	stored: ClaudeChat | undefined,
	homeTabId: number | undefined,
): Promise<ClaudeChat> {
	const chat = await claudeChatFor(stored, homeTabId);
	const binding = await chrome.runtime.sendMessage({ type: "claude-bind", sessionId: chat.id, tabId: chat.homeTabId });
	if (binding?.ok !== true) throw new Error("Could not bind the Claude home tab");
	return chat;
}

async function claudeChatFor(chat: ClaudeChat | undefined, homeTabId: number | undefined): Promise<ClaudeChat> {
	if (chat && (await chrome.tabs.get(chat.homeTabId).catch(() => undefined))) return chat;
	if (homeTabId === undefined) throw new Error("Open Claude Code from a browser tab");
	if (chat) return { ...chat, homeTabId };
	const now = new Date().toISOString();
	return {
		id: crypto.randomUUID(),
		homeTabId,
		title: "Claude Code",
		createdAt: now,
		lastModified: now,
		items: [],
		resumeCommand: "",
		phase: "closed",
	};
}

export function backendPicker(current: ChatBackend, choose: (backend: ChatBackend) => void) {
	return html`<select aria-label="Backend for a new chat" class="text-sm bg-background border border-border rounded px-2 py-1" .value=${current} @change=${(
		event: Event,
	) => {
		if (event.target instanceof HTMLSelectElement && (event.target.value === "pi" || event.target.value === "claude"))
			choose(event.target.value);
	}}><option value="pi">Sitegeist agent</option><option value="claude">Claude Code</option></select>`;
}

export function backendChooser(choose: (backend: ChatBackend) => void) {
	return html`<div class="p-4 space-y-4"><p>Choose how to start this chat.</p><div class="flex flex-wrap gap-2">${Button({ variant: "outline", children: "Sitegeist agent", onClick: () => choose("pi") })}${Button({ children: "Claude Code", onClick: () => choose("claude") })}</div><p class="text-sm text-muted-foreground">Claude Code uses the claude app you have signed in to on this computer.</p></div>`;
}
