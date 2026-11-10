import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sessionIdFor } from "../bridge/protocol.js";
import { CLAUDE_CLIENT_NAME } from "./protocol.js";
import { Chat } from "./schema.js";

export type ClaudeChat = Static<typeof Chat>;
export function isClaudeChat(value: unknown): value is ClaudeChat {
	return Value.Check(Chat, value);
}
const PREFIX = "claude_chat_";

export function claudeSessionKey(chatId: string): string {
	return sessionIdFor({ name: CLAUDE_CLIENT_NAME, session: chatId }, chatId);
}

export async function loadClaudeChat(id: string): Promise<ClaudeChat | undefined> {
	const data = await chrome.storage.local.get(`${PREFIX}${id}`);
	const chat: unknown = data[`${PREFIX}${id}`];
	return isClaudeChat(chat) ? chat : undefined;
}

export async function listClaudeChats(): Promise<ClaudeChat[]> {
	const data = await chrome.storage.local.get(null);
	return Object.entries(data).flatMap(([key, value]) =>
		key.startsWith(PREFIX) && isClaudeChat(value) ? [value] : [],
	);
}

export async function saveClaudeChat(chat: ClaudeChat): Promise<void> {
	await chrome.storage.local.set({ [`${PREFIX}${chat.id}`]: chat });
}

export async function deleteClaudeChat(id: string): Promise<void> {
	await chrome.storage.local.remove(`${PREFIX}${id}`);
}
