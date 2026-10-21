import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

test("the installed host survives replacing Node behind its PATH symlink", { skip: process.platform === "win32" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "sitegeist-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const dir of ["bin", "old", "new", "home"]) mkdirSync(join(root, dir));
	if (process.platform === "darwin") symlinkSync(join(dirname(process.execPath), "..", "lib"), join(root, "lib"));
	const oldNode = join(root, "old", "node");
	const newNode = join(root, "new", "node");
	const stableNode = join(root, "bin", "node");
	copyFileSync(process.execPath, oldNode);
	copyFileSync(process.execPath, newNode);
	symlinkSync(oldNode, stableNode);
	const script = join(root, "host.mjs");
	writeFileSync(script, 'console.log(process.argv[2]);\n');
	const installer = join(root, "install.mjs");
	writeFileSync(installer, `import { install } from ${JSON.stringify(new URL("../src/install.ts", import.meta.url).href)};\nprocess.argv[1] = ${JSON.stringify(script)};\ninstall();\n`);
	const env = { ...process.env, HOME: join(root, "home"), PATH: [join(root, "old"), join(root, "bin")].join(delimiter) };
	execFileSync(stableNode, [installer], { env });
	unlinkSync(stableNode);
	symlinkSync(newNode, stableNode);
	rmSync(join(root, "old"), { recursive: true });
	const result = spawnSync(join(root, "home", ".config", "sitegeist", "host"), [], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "host");
});

test("an outdated launcher is detected and repaired with an unchanged manifest", { skip: process.platform === "win32" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "sitegeist-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "Library", "Application Support", "Google", "Chrome"), { recursive: true });
	mkdirSync(join(root, ".config", "google-chrome"), { recursive: true });
	const script = join(root, "repair.mjs");
	writeFileSync(script, `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { install, isInstalled } from ${JSON.stringify(new URL("../src/install.ts", import.meta.url).href)};
const { launcher } = install();
assert.equal(isInstalled(), true);
const expected = readFileSync(launcher, "utf8");
writeFileSync(launcher, '#!/bin/sh\\nexec /missing/old-node host\\n');
assert.equal(isInstalled(), false, "obsolete launcher must trigger installation");
if (!isInstalled()) install();
assert.equal(isInstalled(), true);
assert.equal(readFileSync(launcher, "utf8"), expected);
`);
	execFileSync(process.execPath, [script], { env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config") } });
});
