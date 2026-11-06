
export type StatusCategory = "todo" | "doing" | "done";

/** Normalized external ticket. Plugins return anything; the host validates and clamps it to this shape. */
export interface ExternalTask {
  sourceId: string;
  externalId: string;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  assignee?: string;
  priority?: string;
  url: string;
  updatedAt: string;
  fields: { label: string; value: string }[];
}

export interface TaskListPage { items: ExternalTask[]; nextCursor?: string }
export interface TaskSourceProvider {
  list(userId: string, opts: { query?: string; cursor?: string }): Promise<{ items: unknown[]; nextCursor?: string }>;
  get(userId: string, externalId: string): Promise<unknown | null>;
}

const clamp = (v: unknown, max: number): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
const CATEGORIES: StatusCategory[] = ["todo", "doing", "done"];

