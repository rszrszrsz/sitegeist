import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeClient } from "../src/client.ts";
import { encodeFrame, FrameParser } from "../src/framing.ts";

const a = { browser: "Test", userDataDir: "/test", directory: "A" };
const b = { ...a, directory: "B" };
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

async function bridge(t, profile, onRequest, welcome = true) {
	const dir = mkdtempSync(join(tmpdir(), "sitegeist-test-"));
	const path = join(dir, "bridge.sock");
	const sockets = new Set();
	let connections = 0;
	const requests = [];
	const server = createServer((socket) => {
		connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		const parser = new FrameParser(100000);
		socket.on("data", (chunk) => {
			for (const msg of parser.push(chunk)) {
				if (msg.type === "hello") {
					if (welcome === "silent") continue;
					if (!welcome) {
						socket.end();
						continue;
					}
					socket.write(encodeFrame({ type: "welcome", clientId: "test", extensionConnected: true, profile }));
				} else if (msg.type === "request") {
					requests.push(msg);
					if (onRequest) onRequest(socket, msg);
					else socket.write(encodeFrame({ type: "response", id: msg.id, result: profile.directory }));
				}
			}
		});
	});
	await new Promise((resolve) => server.listen(path, resolve));
	chmodSync(path, 0o600);
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		path,
		requests,
		get connections() {
			return connections;
		},
	};
}

function clientFor(t, findTarget) {
	const client = new BridgeClient({ name: "test", requestTimeoutMs: 500 });
	// Control discovery delays without touching the user's live bridge directory.
	client.findTarget = findTarget;
	t.after(() => client.close());
	return client;
}

test("a superseded profile discovery cannot replace the newer connection", async (t) => {
	const first = await bridge(t, a);
	const second = await bridge(t, b);
	const entered = deferred();
	const release = deferred();
	let discoveries = 0;
	const client = clientFor(t, async () => {
		if (++discoveries === 1) {
			entered.resolve();
			await release.promise;
			return first.path;
		}
		return second.path;
	});
	const oldSwitch = client.useProfile(a).then(
		() => "connected",
		() => "cancelled",
	);
	await entered.promise;
	await client.useProfile(b);
	release.resolve();
	assert.equal(await oldSwitch, "cancelled");
	assert.equal(await client.call("read"), "B");
	assert.equal(first.connections, 0);
});

test("a retry waiting for discovery cannot replay into a switched profile", async (t) => {
	const first = await bridge(t, a, (socket) => socket.destroy());
	const second = await bridge(t, b);
	const entered = deferred();
	const release = deferred();
	let discoveries = 0;
	const client = clientFor(t, async () => {
		const n = ++discoveries;
		if (n === 2) {
			entered.resolve();
			await release.promise;
		}
		return n === 1 ? first.path : second.path;
	});
	await client.useProfile(a);
	const action = client.call("action").then(
		() => "replayed",
		() => "cancelled",
	);
	await entered.promise;
	await client.useProfile(b);
	release.resolve();
	assert.equal(await action, "cancelled");
	assert.equal(second.requests.length, 0);
	assert.equal(await client.call("read"), "B");
});

test("concurrent first calls share one connection and await its welcome", async (t) => {
	const host = await bridge(t, a);
	const client = clientFor(t, async () => host.path);
	assert.deepEqual(await Promise.all([client.call("one"), client.call("two")]), ["A", "A"]);
	assert.equal(host.connections, 1);
});

test("closing before welcome rejects connection instead of hanging discovery", async (t) => {
	const host = await bridge(t, a, undefined, false);
	const client = clientFor(t, async () => host.path);
	const result = await Promise.race([
		client.connect().then(
			() => "connected",
			() => "rejected",
		),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
	]);
	assert.equal(result, "rejected");
});

test("a delayed close from the old socket cannot reject a new profile's request", async (t) => {
	const first = await bridge(t, a);
	const entered = deferred();
	let reply;
	const second = await bridge(t, b, (socket, msg) => {
		reply = () => socket.write(encodeFrame({ type: "response", id: msg.id, result: "B" }));
		entered.resolve();
	});
	let discoveries = 0;
	const client = clientFor(t, async () => (++discoveries === 1 ? first.path : second.path));
	await client.useProfile(a);
	const oldSocket = client.socket;
	const emit = oldSocket.emit;
	const closed = deferred();
	let deliverClose;
	oldSocket.emit = function (event, ...args) {
		if (event === "close") {
			deliverClose = () => emit.call(this, event, ...args);
			closed.resolve();
			return true;
		}
		return emit.call(this, event, ...args);
	};
	await client.useProfile(b);
	await closed.promise;
	const request = client.call("read");
	await entered.promise;
	deliverClose();
	reply();
	assert.equal(await request, "B");
	assert.equal(second.connections, 1);
});

test("switching during an in-flight action cancels it without replay", async (t) => {
	const entered = deferred();
	const first = await bridge(t, a, () => entered.resolve());
	const second = await bridge(t, b);
	let discoveries = 0;
	const client = clientFor(t, async () => (++discoveries === 1 ? first.path : second.path));
	await client.useProfile(a);
	const action = client.call("action").then(
		() => "replayed",
		() => "cancelled",
	);
	await entered.promise;
	await client.useProfile(b);
	assert.equal(await action, "cancelled");
	assert.equal(second.requests.length, 0);
	assert.equal(await client.call("read"), "B");
});

test("a silent host cannot hang discovery indefinitely", async (t) => {
	const host = await bridge(t, a, undefined, "silent");
	const client = clientFor(t, async () => host.path);
	await assert.rejects(client.connect(), /welcome timed out/);
});

test("an ordinary dropped connection still retries on the selected profile", async (t) => {
	let attempts = 0;
	const host = await bridge(t, a, (socket, msg) => {
		if (++attempts === 1) socket.destroy();
		else socket.write(encodeFrame({ type: "response", id: msg.id, result: "A" }));
	});
	const client = clientFor(t, async () => host.path);
	await client.useProfile(a);
	assert.equal(await client.call("read"), "A");
	assert.equal(host.connections, 2);
	assert.equal(host.requests.length, 2);
});
