import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LogItem = Type.Union([
	Type.Object({ kind: Type.Literal("user"), text: Type.String() }),
	Type.Object({ kind: Type.Literal("assistant"), messageId: Type.String(), text: Type.String() }),
	Type.Object({
		kind: Type.Literal("tool"),
		toolUseId: Type.String(),
		name: Type.String(),
		phase: Type.Union([Type.Literal("start"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("denied")]),
		detail: Type.Optional(Type.String()),
	}),
]);
const Chat = Type.Object({
	id: Type.String(),
	sessionKey: Type.String(),
	homeTabId: Type.Number(),
	title: Type.String(),
	createdAt: Type.String(),
	lastModified: Type.String(),
	items: Type.Array(LogItem),
	resumeCommand: Type.String(),
	phase: Type.Union([Type.Literal("closed"), Type.Literal("handedOff")]),
});
export type ClaudeChat = Static<typeof Chat>;
export function isClaudeChat(value: unknown): value is ClaudeChat {
	return Value.Check(Chat, value);
}
const PREFIX = "claude_chat_";

export async function loadClaudeChat(id: string): Promise<ClaudeChat | undefined> {
	const data = await chrome.storage.local.get(`${PREFIX}${id}`);
	const chat: unknown = data[`${PREFIX}${id}`];
	return Value.Check(Chat, chat) ? chat : undefined;
}

export async function listClaudeChats(): Promise<ClaudeChat[]> {
	const data = await chrome.storage.local.get(null);
	return Object.entries(data).flatMap(([key, value]) =>
		key.startsWith(PREFIX) && Value.Check(Chat, value) ? [value] : [],
	);
}

export async function saveClaudeChat(chat: ClaudeChat): Promise<void> {
	await chrome.storage.local.set({ [`${PREFIX}${chat.id}`]: chat });
}

export async function deleteClaudeChat(id: string): Promise<void> {
	await chrome.storage.local.remove(`${PREFIX}${id}`);
}
