import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
	getPendingRequests,
	type PendingRequest,
	type PermissionDecision,
	recordDecision,
} from "../bridge/permissions.js";
import { parseHostEvent } from "./events.js";
import { type ClaudeAction, type ClaudeChatState, transition } from "./phase.js";
import { CLAUDE_HOST_NAME, type PanelToClaudeHost } from "./protocol.js";
import { type ClaudeChat, saveClaudeChat } from "./storage.js";

@customElement("claude-chat-view")
export class ClaudeChatView extends LitElement {
	@state() private chatState: ClaudeChatState = {
		phase: { kind: "closed" },
		items: [],
		resumeCommand: "",
		exitIntent: null,
	};
	@state() private draft = "";
	@state() private pending: PendingRequest[] = [];
	@state() private notice = "";
	private chat?: ClaudeChat;
	private windowId = 0;
	private nativePort?: chrome.runtime.Port;
	private permissionPort?: chrome.runtime.Port;
	private saveQueue: Promise<void> = Promise.resolve();
	private saveTimer?: ReturnType<typeof setTimeout>;
	private queuedText?: string;

	initialize(chat: ClaudeChat, windowId: number): void {
		this.chat = chat;
		this.windowId = windowId;
		this.chatState = {
			phase:
				chat.phase === "handedOff" ? { kind: "handedOff", resumeCommand: chat.resumeCommand } : { kind: "closed" },
			items: chat.items,
			resumeCommand: chat.resumeCommand,
			exitIntent: null,
		};
	}

	override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.className = "flex flex-col flex-1 min-h-0";
		if (this.chat) this.permissionPort = chrome.runtime.connect({ name: `claude-panel:${this.chat.id}` });
		chrome.storage.onChanged.addListener(this.permissionsChanged);
		window.addEventListener("pagehide", this.close);
		void this.refreshPermissions();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.permissionsChanged);
		window.removeEventListener("pagehide", this.close);
		this.close();
	}

	private close = (): void => {
		this.persist();
		this.nativePort?.disconnect();
		this.nativePort = undefined;
		this.permissionPort?.disconnect();
		this.permissionPort = undefined;
		void chrome.storage.session.remove(`sidepanel_busy_${this.windowId}`);
	};

	private permissionsChanged = (_changes: unknown, area: string): void => {
		if (area === "session") void this.refreshPermissions();
	};

	private async refreshPermissions(): Promise<void> {
		this.pending = (await getPendingRequests()).filter((request) => request.sessionKey === this.chat?.sessionKey);
	}

	private apply(action: ClaudeAction): void {
		this.chatState = transition(this.chatState, action);
		const busy =
			this.chatState.phase.kind === "starting" ||
			this.chatState.phase.kind === "turn" ||
			this.chatState.exitIntent === "handoff";
		void chrome.storage.session.set({ [`sidepanel_busy_${this.windowId}`]: busy ? this.chat?.homeTabId : false });
		if (action.type === "text") {
			if (!this.saveTimer) this.saveTimer = setTimeout(() => this.persist(), 150);
		} else this.persist();
	}

	private persist(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		if (!this.chat) return;
		const firstUser = this.chatState.items.find((item) => item.kind === "user");
		const snapshot: ClaudeChat = {
			...this.chat,
			title: firstUser?.text.slice(0, 80) || "Claude Code",
			items: this.chatState.items,
			resumeCommand: this.chatState.resumeCommand,
			phase: this.chatState.phase.kind === "handedOff" ? "handedOff" : "closed",
			lastModified: new Date().toISOString(),
		};
		this.chat = snapshot;
		this.saveQueue = this.saveQueue
			.then(() => saveClaudeChat(snapshot))
			.catch(() => {
				this.notice = "Could not save this chat. Keep the panel open and try again.";
			});
	}

	private post(message: PanelToClaudeHost): void {
		try {
			if (!this.nativePort) throw new Error("Claude Code is disconnected");
			this.nativePort.postMessage(message);
		} catch {
			this.queuedText = undefined;
			this.apply({ type: "disconnect", message: "Claude Code disconnected. Continue here to reconnect." });
		}
	}

	private async start(): Promise<void> {
		if (!this.chat || this.nativePort) return;
		this.notice = "";
		this.apply({ type: "start" });
		try {
			const binding = await chrome.runtime.sendMessage({
				type: "claude-bind",
				sessionId: this.chat.id,
				tabId: this.chat.homeTabId,
			});
			if (!binding || typeof binding.sessionKey !== "string") throw new Error("Could not bind the home tab");
			this.chat = { ...this.chat, sessionKey: binding.sessionKey };
			const tab = await chrome.tabs.get(this.chat.homeTabId);
			const data = await chrome.storage.local.get("bridge_profile_marker");
			const native = chrome.runtime.connectNative(CLAUDE_HOST_NAME);
			this.nativePort = native;
			native.onMessage.addListener((value: unknown) => {
				if (this.nativePort !== native) return;
				try {
					const event = parseHostEvent(value);
					if (event.type === "ready" && event.sessionId !== this.chat?.id)
						throw new Error("Claude session identity changed");
					this.apply(event);
					if (event.type === "ready" && this.queuedText !== undefined) {
						const text = this.queuedText;
						this.queuedText = undefined;
						this.sendTurn(text);
					}
					if (event.type === "error") {
						this.queuedText = undefined;
						this.nativePort = undefined;
						native.disconnect();
					}
					if (event.type === "exited") {
						this.nativePort = undefined;
						native.disconnect();
						if (this.chatState.phase.kind === "handedOff") void this.copyCommand();
					}
				} catch {
					this.apply({
						type: "error",
						reason: "crashed",
						message: "Claude Code returned an invalid response. Run sitegeist install and try again.",
					});
					this.nativePort = undefined;
					this.queuedText = undefined;
					native.disconnect();
				}
			});
			native.onDisconnect.addListener(() => {
				const error = chrome.runtime.lastError?.message;
				if (this.nativePort !== native) return;
				this.nativePort = undefined;
				this.queuedText = undefined;
				this.apply({
					type: "disconnect",
					message: error ? "Run sitegeist install, then continue here." : undefined,
				});
			});
			this.post({
				type: "start",
				sessionId: this.chat.id,
				resume: this.chatState.items.some((item) => item.kind === "user"),
				profileMarker: typeof data.bridge_profile_marker === "string" ? data.bridge_profile_marker : undefined,
				pageUrl: tab.url,
			});
		} catch {
			this.queuedText = undefined;
			this.apply({
				type: "error",
				reason: "crashed",
				message: "Could not start Claude Code. Reopen the panel on its home tab and run sitegeist install.",
			});
		}
	}

	private sendTurn(text: string): void {
		this.apply({ type: "say", text });
		this.draft = "";
		this.post({ type: "say", text });
	}

	private submit = (): void => {
		const text = this.draft.trim();
		if (
			!text ||
			this.chatState.exitIntent ||
			this.chatState.phase.kind === "starting" ||
			this.chatState.phase.kind === "turn"
		)
			return;
		if (this.chatState.phase.kind === "handedOff") return;
		if (this.chatState.phase.kind === "ready") this.sendTurn(text);
		else {
			this.queuedText = text;
			void this.start();
		}
	};

	private async handOff(): Promise<void> {
		if (!this.nativePort || !this.chatState.resumeCommand) return;
		this.apply({ type: "end" });
		await this.saveQueue;
		this.post({ type: "end" });
	}

	private async copyCommand(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.chatState.resumeCommand);
			this.notice = "Resume command copied.";
		} catch {
			this.notice = "Copy the resume command below.";
		}
	}

	private async decide(request: PendingRequest, decision: PermissionDecision): Promise<void> {
		await recordDecision(request.requestId, decision);
		await this.refreshPermissions();
	}

	protected override updated(): void {
		const log = this.querySelector("[data-chat-log]");
		if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight;
	}

	protected override render() {
		const phase = this.chatState.phase;
		const busy = phase.kind === "turn" || phase.kind === "starting" || this.chatState.exitIntent !== null;
		const failure =
			phase.kind === "failed"
				? phase.reason === "not_installed"
					? "Run sitegeist install to set up Claude Code."
					: phase.reason === "not_logged_in"
						? "Run claude in a terminal, then /login, and continue here."
						: phase.reason === "limit"
							? "Claude has reached its usage limit. Try again when your limit resets."
							: phase.message
				: "";
		return html`
			<div class="px-3 py-2 border-b border-border flex flex-wrap items-center gap-2 text-sm">
				<span class="font-medium">Claude Code</span>
				<span class="text-muted-foreground" role="status">${this.chatState.exitIntent ? "Ending session…" : phase.kind === "starting" ? "Starting…" : phase.kind === "turn" ? "Working…" : ""}</span>
				${Button({ variant: "ghost", size: "sm", children: "Continue in terminal", disabled: !this.nativePort || !this.chatState.resumeCommand || this.chatState.exitIntent !== null, onClick: () => void this.handOff() })}
			</div>
			<div data-chat-log role="log" aria-label="Claude conversation" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
				${this.chatState.items.length === 0 ? html`<p class="text-muted-foreground text-sm">Chat with your signed-in Claude Code on this page.</p>` : ""}
				${repeat(
					this.chatState.items,
					(item) => (item.kind === "assistant" ? item.messageId : item.kind === "tool" ? item.toolUseId : item),
					(item) =>
						item.kind === "tool"
							? html`<div class="text-xs text-muted-foreground" title=${item.detail ?? ""}>${item.name} · ${item.phase}</div>`
							: html`<div class=${item.kind === "user" ? "rounded-lg bg-secondary p-3" : ""}><markdown-block .content=${item.text}></markdown-block></div>`,
				)}
			</div>
			<div class="px-4 space-y-3">
				${this.pending.map(
					(request) =>
						html`<div class="border border-border rounded-lg p-3 text-sm"><p class="break-words">Allow Claude Code to open ${request.host}?</p><div class="flex flex-wrap gap-2 mt-2">${(
							[
								["allow_once", "Allow once"],
								["allow_host", "Always allow this site"],
								["deny", "Deny"],
							] satisfies [PermissionDecision, string][]
						).map(([decision, label]) =>
							Button({
								variant: "outline",
								size: "sm",
								children: label,
								onClick: () => void this.decide(request, decision),
							}),
						)}</div></div>`,
				)}
				${failure ? html`<p role="alert" class="text-sm text-destructive">${failure}</p>` : ""}
				${this.notice ? html`<p role="status" class="text-sm text-muted-foreground">${this.notice}</p>` : ""}
				${phase.kind === "handedOff" ? html`<p class="text-sm">Continue in your terminal. End that session before continuing here.</p><pre class="text-xs whitespace-pre-wrap break-all select-all">${phase.resumeCommand}</pre>${Button({ variant: "outline", size: "sm", children: "Copy command", onClick: () => void this.copyCommand() })}` : ""}
				${(phase.kind === "closed" || phase.kind === "failed" || phase.kind === "handedOff") && this.chatState.items.length > 0 ? Button({ variant: "outline", size: "sm", children: "Continue here", onClick: () => void this.start() }) : ""}
			</div>
			<form class="p-3 border-t border-border mt-3 flex flex-col gap-2" @submit=${(event: Event) => {
				event.preventDefault();
				this.submit();
			}}>
				<textarea aria-label="Message Claude Code" class="w-full min-h-20 max-h-48 resize-y rounded-lg border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary" placeholder="Message Claude Code…" .value=${this.draft} ?disabled=${busy || phase.kind === "handedOff"} @input=${(
					event: Event,
				) => {
					if (event.target instanceof HTMLTextAreaElement) this.draft = event.target.value;
				}} @keydown=${(event: KeyboardEvent) => {
					if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
						event.preventDefault();
						this.submit();
					}
				}}></textarea>
				<div class="flex justify-end">${
					phase.kind === "turn" && !this.chatState.exitIntent
						? Button({
								variant: "outline",
								size: "sm",
								children: "Stop",
								onClick: () => {
									this.apply({ type: "interrupt" });
									this.post({ type: "interrupt" });
								},
							})
						: Button({
								size: "sm",
								children: "Send",
								disabled: busy || !this.draft.trim() || phase.kind === "handedOff",
								onClick: this.submit,
							})
				}</div>
			</form>
		`;
	}
}
