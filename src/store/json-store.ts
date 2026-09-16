import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { IncidentRecord } from "../pipeline/types.js";

export class JsonIncidentStore {
  constructor(private readonly path: string) {}

  async list(): Promise<IncidentRecord[]> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error(`Incident store is not an array: ${this.path}`);
      }
      return parsed as IncidentRecord[];
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async put(record: IncidentRecord): Promise<void> {
    const records = await this.list();
    const index = records.findIndex(
      (existing) => existing.input.id === record.input.id,
    );
    if (index >= 0) records[index] = record;
    else records.push(record);

    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

export function defaultStore(cwd: string): JsonIncidentStore {
  return new JsonIncidentStore(
    resolve(cwd, ".incident-orchestrator", "incidents.json"),
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
