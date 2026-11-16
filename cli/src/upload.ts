import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export function validateUploadPaths(paths: string[]): void {
	for (const path of paths) {
		if (!isAbsolute(path)) throw new Error(`Upload path must be absolute: ${path}`);
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat) throw new Error(`Upload path does not exist: ${path}`);
		if (!stat.isFile()) throw new Error(`Upload path must be a regular file: ${path}`);
	}
}
