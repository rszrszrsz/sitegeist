/**
 * Socket client: dials the native host's unix socket, checks its ownership, and
 * exposes request/response plus events. One instance per harness process.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { BrowserProfile, ClientToHost, HostToClient, RpcError } from "../../src/bridge/protocol.ts";
import { MAX_FRAME_FROM_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { assertSecurePath, socketDir } from "./paths.ts";
import { describeProfile, sameProfile } from "./profiles.ts";
import { VERSION } from "./version.ts";

export class BridgeRpcError extends Error {
	constructor(readonly rpc: RpcError) {
		super(rpc.message);
	}
}

export interface ClientOptions {
	name: string;
	session?: string;
	/** Fires for permission prompts and other pushed events. */
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	onExtensionStatus?: (connected: boolean) => void;
	requestTimeoutMs?: number;
	/** Only connect to the bridge of this browser profile; default: the newest bridge. */
	profile?: BrowserProfile;
}

/** Live sockets, newest host first. */
export function listSockets(): string[] {
	const dir = socketDir();
	if (process.platform === "win32") return [dir];
	if (!existsSync(dir)) return [];
	assertSecurePath(dir, "dir");
	return readdirSync(dir)
		.filter((n) => n.endsWith(".sock"))
		.map((n) => join(dir, n))
		.filter((p) => {
			const pid = Number.parseInt(p.slice(p.lastIndexOf("/") + 1), 10);
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export interface BridgeInfo {
	path: string;
	/** Known once the extension said hello; the host exits when the extension goes away. */
	profile?: BrowserProfile;
}

/** Every live bridge with the profile its host found; unreachable ones are skipped. */
export async function probeBridges(): Promise<BridgeInfo[]> {
	const results = await Promise.all(
		listSockets().map(async (path): Promise<BridgeInfo | undefined> => {
			const client = new BridgeClient({ name: "probe" });
			try {
				await client.connect(path);
				return { path, profile: client.profile };
			} catch {
				return undefined;
			} finally {
				client.close();
			}
		}),
	);
	return results.filter((r): r is BridgeInfo => r !== undefined);
}

function isConnectionError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as { code?: string } | undefined)?.code;
	return (
		message === "Bridge connection closed" ||
		message === "Not connected" ||
		message.startsWith("No sitegeist browser bridge") ||
		code === "ECONNREFUSED" ||
		code === "ENOENT" ||
		code === "EPIPE" ||
		code === "ECONNRESET"
	);
}

export class BridgeClient {
	private socket?: Socket;
	private connecting?: Promise<void>;
	private generation = 0;
	private seq = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	clientId?: string;
	extensionConnected = false;
	/** Profile of the connected bridge, when its host could tell. */
	profile?: BrowserProfile;
	/** Profile whose bridge connect() dials; undefined: the newest bridge. */
	private wanted?: BrowserProfile;

	constructor(private readonly options: ClientOptions) {
		this.wanted = options.profile;
	}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	/** Drop the current bridge and connect to the profile's. Its old session keeps its tabs. */
	async useProfile(profile: BrowserProfile): Promise<void> {
		this.wanted = profile;
		this.close();
		await this.connect();
	}

	private async findTarget(): Promise<string | undefined> {
		const wanted = this.wanted;
		if (!wanted) return listSockets()[0];
		const bridge = (await probeBridges()).find((b) => sameProfile(b.profile, wanted));
		if (!bridge) {
			throw new Error(
				`No sitegeist browser bridge is running for ${describeProfile(wanted)}. Open that profile (profile_use opens it) and make sure the extension is loaded there.`,
			);
		}
		return bridge.path;
	}

	connect(path?: string): Promise<void> {
		if (this.connecting) return this.connecting;
		if (this.connected) return Promise.resolve();
		const attempt = this.openConnection(path, this.generation).finally(() => {
			if (this.connecting === attempt) this.connecting = undefined;
		});
		this.connecting = attempt;
		return attempt;
	}

	private assertGeneration(generation: number): void {
		if (this.generation !== generation) throw new Error("Bridge connection changed during operation");
	}

	private async openConnection(path: string | undefined, generation: number): Promise<void> {
		const target = path ?? (await this.findTarget());
		this.assertGeneration(generation);
		if (!target) {
			throw new Error(
				"No sitegeist browser bridge is running. Make sure the sitegeist extension is loaded in a Chromium browser and that `sitegeist install` has been run.",
			);
		}
		if (process.platform !== "win32") assertSecurePath(target, "socket");
		await new Promise<void>((resolve, reject) => {
			const socket = connect(target);
			const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
			let welcomed = false;
			const timer = setTimeout(() => socket.destroy(new Error("Bridge welcome timed out after 5000 ms")), 5000);
			socket.once("error", (err) => {
				if (!welcomed) reject(err);
			});
			socket.on("data", (chunk) => {
				if (this.socket !== socket) return;
				let messages: unknown[];
				try {
					messages = parser.push(chunk);
				} catch (err) {
					socket.destroy(err as Error);
					return;
				}
				for (const m of messages) {
					const msg = m as HostToClient;
					if (msg.type === "welcome") {
						welcomed = true;
						clearTimeout(timer);
						this.clientId = msg.clientId;
						this.extensionConnected = msg.extensionConnected;
						this.profile = msg.profile;
						resolve();
					} else this.onMessage(msg);
				}
			});
			socket.on("close", () => {
				clearTimeout(timer);
				if (!welcomed) reject(new Error("Bridge connection closed"));
				if (this.socket !== socket) return;
				this.socket = undefined;
				this.rejectPending();
			});
			this.socket = socket;
			const hello: ClientToHost = {
				type: "hello",
				client: { name: this.options.name, session: this.options.session, version: VERSION },
			};
			socket.write(encodeFrame(hello));
		});
	}

	private onMessage(msg: HostToClient): void {
		if (msg.type === "response") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new BridgeRpcError(msg.error));
			else p.resolve(msg.result);
		} else if (msg.type === "event") {
			this.options.onEvent?.(msg.event, msg.data);
		} else if (msg.type === "extension_status") {
			this.extensionConnected = msg.connected;
			this.profile = msg.profile;
			this.options.onExtensionStatus?.(msg.connected);
		}
	}

	/**
	 * Call with one transparent retry when the bridge itself dropped (extension reload,
	 * service worker restart, host respawn). The session key is stable, so the retry
	 * lands on the same tabs. RPC errors from the extension are never retried.
	 */
	async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		const generation = this.generation;
		try {
			return await this.callOnce<T>(method, params, timeoutMs, generation);
		} catch (err) {
			if (err instanceof BridgeRpcError || !isConnectionError(err)) throw err;
			// A profile switch or another reconnect superseded this call. Do not replay it
			// or close the replacement connection.
			if (this.generation !== generation) throw err;
			this.close();
			const retryGeneration = this.generation;
			await this.reconnect(40000, retryGeneration);
			return this.callOnce<T>(method, params, timeoutMs, retryGeneration);
		}
	}

	/** Wait for a live host socket (the browser respawns it after a reload) and dial it. */
	private async reconnect(budgetMs: number, generation: number): Promise<void> {
		const deadline = Date.now() + budgetMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			this.assertGeneration(generation);
			try {
				await this.connect();
				this.assertGeneration(generation);
				if (this.extensionConnected) return;
				// Host is up but the extension has not said hello yet; give it a moment.
				await new Promise((r) => setTimeout(r, 500));
				this.assertGeneration(generation);
				if (this.extensionConnected) return;
			} catch (err) {
				lastError = err;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		this.assertGeneration(generation);
		if (!this.connected) throw lastError instanceof Error ? lastError : new Error("Bridge unavailable");
	}

	private async callOnce<T>(method: string, params: Record<string, unknown>, timeoutMs: number | undefined, generation: number): Promise<T> {
		this.assertGeneration(generation);
		await this.connect();
		this.assertGeneration(generation);
		const socket = this.socket;
		if (!socket) throw new Error("Not connected");
		const id = ++this.seq;
		const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeout} ms`));
			}, timeout);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			const req: ClientToHost = { type: "request", id, method, params };
			socket.write(encodeFrame(req));
		});
	}

	private rejectPending(): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("Bridge connection closed"));
		}
		this.pending.clear();
	}

	close(): void {
		this.generation++;
		this.connecting = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.extensionConnected = false;
		this.profile = undefined;
		this.rejectPending();
	}
}
