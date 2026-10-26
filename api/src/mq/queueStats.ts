import type { Config } from "../config.js";

export interface TasksQueueDepth {
  ready: number;
  unacked: number;
}

function parseMgmtUrl(rawUrl: string): { baseUrl: string; authHeader: string | null } {
  try {
    const parsed = new URL(rawUrl);
    let authHeader: string | null = null;
    if (parsed.username || parsed.password) {
      const user = decodeURIComponent(parsed.username);
      const pass = decodeURIComponent(parsed.password);
      authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      parsed.username = "";
      parsed.password = "";
    }
    return { baseUrl: parsed.toString().replace(/\/$/, ""), authHeader };
  } catch {
    return { baseUrl: rawUrl.replace(/\/$/, ""), authHeader: null };
  }
}

export async function getTasksQueueDepth(config: Config): Promise<TasksQueueDepth> {
  try {
    const { baseUrl, authHeader } = parseMgmtUrl(config.RABBITMQ_MGMT_URL);
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    const res = await fetch(`${baseUrl}/api/queues/%2F/${encodeURIComponent("dm.tasks")}`, {
      headers,
    });
    if (!res.ok) return { ready: 0, unacked: 0 };
    const data = (await res.json()) as {
      messages_ready?: number;
      messages_unacknowledged?: number;
    };
    return {
      ready: data.messages_ready ?? 0,
      unacked: data.messages_unacknowledged ?? 0,
    };
  } catch {
    return { ready: 0, unacked: 0 };
  }
}
