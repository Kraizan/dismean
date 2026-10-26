import { useCallback, useEffect, useState } from "react";

const API = "/api";

type Stats = {
  workers: { total: number; idle: number; busy: number; dead: number };
  queue: { tasks_ready: number; tasks_unacked: number };
  jobs: Record<string, number>;
};

type Event = { id: number; at: string; type: string; message?: string };

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [afterId, setAfterId] = useState(0);
  const [f, setF] = useState(12);
  const [c, setC] = useState(5);

  const poll = useCallback(async () => {
    try {
      const s = await fetch(`${API}/stats`).then((r) => r.json());
      setStats(s);
      const ev = await fetch(`${API}/events?after_id=${afterId}&limit=50`).then(
        (r) => r.json(),
      );
      if (ev.events?.length) {
        setEvents((prev) => [...prev, ...ev.events].slice(-200));
        setAfterId(ev.events[ev.events.length - 1].id);
      }
    } catch {
      /* API down */
    }
  }, [afterId]);

  useEffect(() => {
    const t = setInterval(() => void poll(), 1000);
    void poll();
    return () => clearInterval(t);
  }, [poll]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`${API}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ f, c }),
    });
  }

  return (
    <main>
      <h1>dismean</h1>
      <form onSubmit={submit} className="card">
        <label>
          F <input type="number" value={f} onChange={(e) => setF(+e.target.value)} />
        </label>
        <label>
          C <input type="number" value={c} onChange={(e) => setC(+e.target.value)} />
        </label>
        <button type="submit">Submit job</button>
        <button type="button" onClick={() => void fetch(`${API}/cleanup`, { method: "POST" })}>
          Cleanup
        </button>
      </form>
      <div className="grid" style={{ marginTop: "1rem" }}>
        <section className="card">
          <h2>Workers</h2>
          {stats ? (
            <p>
              {stats.workers.busy} busy · {stats.workers.idle} idle · {stats.workers.dead} dead ·
              queue {stats.queue.tasks_ready}/{stats.queue.tasks_unacked}
            </p>
          ) : (
            <p>Connecting…</p>
          )}
          <h2>Jobs</h2>
          <pre>{stats ? JSON.stringify(stats.jobs, null, 2) : "—"}</pre>
        </section>
        <section className="card log">
          <h2>Events</h2>
          {events.map((ev) => (
            <div key={ev.id}>
              {ev.type} {ev.message ?? ""}
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
