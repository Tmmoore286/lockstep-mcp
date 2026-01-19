import http from "node:http";
import url from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { createStore } from "./storage.js";

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lockstep MCP Dashboard</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap");

      :root {
        --bg: #f3efe6;
        --panel: #fff8ee;
        --ink: #1f2533;
        --muted: #5f6470;
        --accent: #d07a1f;
        --accent-2: #2a7f75;
        --line: #e2d8c7;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Helvetica Neue", sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at 10% 10%, #fff6e0 0%, var(--bg) 50%, #f0e7d6 100%);
      }

      header {
        padding: 28px 32px 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      h1 {
        margin: 0;
        font-size: 28px;
        letter-spacing: -0.02em;
      }

      .subtitle {
        color: var(--muted);
        font-size: 14px;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        padding: 0 32px 20px;
      }

      .stat {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .stat .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .stat .value {
        font-size: 20px;
        font-weight: 600;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
        padding: 0 32px 40px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 16px;
        min-height: 240px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .panel h2 {
        margin: 0;
        font-size: 18px;
        letter-spacing: -0.01em;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        background: #f7e7d0;
        color: var(--accent);
      }

      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 480px;
        overflow: auto;
        padding-right: 6px;
      }

      .card {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px;
        background: #fffdf8;
      }

      .card-title {
        font-weight: 600;
        font-size: 14px;
        margin-bottom: 4px;
      }

      .card-meta {
        font-size: 12px;
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .mono {
        font-family: "IBM Plex Mono", "Courier New", monospace;
        font-size: 12px;
      }

      .empty {
        color: var(--muted);
        font-size: 13px;
      }

      footer {
        padding: 0 32px 30px;
        color: var(--muted);
        font-size: 12px;
      }

      @media (max-width: 640px) {
        header, .stats, .grid, footer {
          padding-left: 18px;
          padding-right: 18px;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Lockstep MCP Dashboard</h1>
      <div class="subtitle" id="status">Connecting...</div>
    </header>

    <section class="stats">
      <div class="stat">
        <div class="label">Tasks</div>
        <div class="value" id="task-count">0</div>
      </div>
      <div class="stat">
        <div class="label">Locks</div>
        <div class="value" id="lock-count">0</div>
      </div>
      <div class="stat">
        <div class="label">Notes</div>
        <div class="value" id="note-count">0</div>
      </div>
      <div class="stat">
        <div class="label">Storage</div>
        <div class="value" id="storage">sqlite</div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Tasks <span class="pill" id="task-meta">0 total</span></h2>
        <div class="list" id="task-list"></div>
      </div>
      <div class="panel">
        <h2>Locks <span class="pill" id="lock-meta">0 active</span></h2>
        <div class="list" id="lock-list"></div>
      </div>
      <div class="panel">
        <h2>Notes</h2>
        <div class="list" id="note-list"></div>
      </div>
    </section>

    <footer>
      Live view of Lockstep MCP tasks, locks, and notes. Updates stream via WebSocket.
    </footer>

    <script>
      const statusEl = document.getElementById("status");
      const taskList = document.getElementById("task-list");
      const lockList = document.getElementById("lock-list");
      const noteList = document.getElementById("note-list");
      const taskCount = document.getElementById("task-count");
      const lockCount = document.getElementById("lock-count");
      const noteCount = document.getElementById("note-count");
      const storageEl = document.getElementById("storage");
      const taskMeta = document.getElementById("task-meta");
      const lockMeta = document.getElementById("lock-meta");

      function escapeHtml(text) {
        return text.replace(/[&<>\"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "\"": "&quot;",
          "'": "&#39;"
        }[char]));
      }

      function renderTasks(tasks) {
        taskList.innerHTML = "";
        if (!tasks.length) {
          taskList.innerHTML = '<div class="empty">No tasks yet.</div>';
          return;
        }
        tasks.forEach(task => {
          const card = document.createElement("div");
          card.className = "card";
          const desc = task.description
            ? '<div class="card-meta">' + escapeHtml(task.description) + "</div>"
            : "";
          const tags = task.tags && task.tags.length ? " | tags: " + task.tags.join(", ") : "";
          card.innerHTML =
            '<div class="card-title">' + escapeHtml(task.title) + "</div>" +
            desc +
            '<div class="card-meta mono">' +
            task.status +
            (task.owner ? " | owner: " + task.owner : "") +
            tags +
            "</div>" +
            '<div class="card-meta mono">updated: ' + task.updatedAt + "</div>";
          taskList.appendChild(card);
        });
      }

      function renderLocks(locks) {
        lockList.innerHTML = "";
        if (!locks.length) {
          lockList.innerHTML = '<div class="empty">No locks.</div>';
          return;
        }
        locks.forEach(lock => {
          const card = document.createElement("div");
          card.className = "card";
          card.innerHTML =
            '<div class="card-title">' + escapeHtml(lock.path) + "</div>" +
            '<div class="card-meta mono">' +
            lock.status +
            (lock.owner ? " | owner: " + lock.owner : "") +
            "</div>" +
            '<div class="card-meta mono">updated: ' + lock.updatedAt + "</div>";
          lockList.appendChild(card);
        });
      }

      function renderNotes(notes) {
        noteList.innerHTML = "";
        if (!notes.length) {
          noteList.innerHTML = '<div class="empty">No notes yet.</div>';
          return;
        }
        notes.forEach(note => {
          const card = document.createElement("div");
          card.className = "card";
          card.innerHTML =
            '<div class="card-title">' +
            (note.author ? escapeHtml(note.author) : "Anonymous") +
            "</div>" +
            '<div class="card-meta">' +
            escapeHtml(note.text) +
            "</div>" +
            '<div class="card-meta mono">' + note.createdAt + "</div>";
          noteList.appendChild(card);
        });
      }

      function updateState(state, config) {
        taskCount.textContent = state.tasks.length;
        lockCount.textContent = state.locks.length;
        noteCount.textContent = state.notes.length;
        storageEl.textContent = config?.storage || "sqlite";
        taskMeta.textContent = state.tasks.length + " total";
        const activeLocks = state.locks.filter(lock => lock.status === "active").length;
        lockMeta.textContent = activeLocks + " active";
        renderTasks(state.tasks);
        renderLocks(state.locks);
        renderNotes(state.notes);
      }

      async function fetchState() {
        const response = await fetch("/api/state");
        const data = await response.json();
        updateState(data.state, data.config);
      }

      function connect() {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(protocol + "://" + window.location.host + "/ws");

        socket.addEventListener("open", () => {
          statusEl.textContent = "Connected";
        });

        socket.addEventListener("message", (event) => {
          const payload = JSON.parse(event.data);
          if (payload.type === "snapshot" || payload.type === "state") {
            updateState(payload.state, payload.config);
          }
        });

        socket.addEventListener("close", () => {
          statusEl.textContent = "Disconnected - retrying...";
          setTimeout(connect, 1000);
        });
      }

      fetchState();
      connect();
    </script>
  </body>
</html>
`;

type DashboardOptions = {
  port?: number;
  host?: string;
  pollMs?: number;
};

export async function startDashboard(options: DashboardOptions = {}) {
  const config = loadConfig();
  const store = createStore(config);
  await store.init();

  const port = options.port ?? 8787;
  const host = options.host ?? "127.0.0.1";
  const pollMs = options.pollMs ?? 1500;

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url || "");
    if (parsed.pathname === "/api/state") {
      const state = await store.status();
      const payload = {
        state,
        config: {
          mode: config.mode,
          storage: config.storage,
          roots: config.roots,
          dataDir: config.dataDir,
          logDir: config.logDir,
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (payload: unknown) => {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  };

  const sendSnapshot = async () => {
    const state = await store.status();
    broadcast({
      type: "snapshot",
      state,
      config: {
        mode: config.mode,
        storage: config.storage,
        roots: config.roots,
        dataDir: config.dataDir,
        logDir: config.logDir,
      },
    });
  };

  wss.on("connection", () => {
    sendSnapshot().catch(() => undefined);
  });

  let lastState = "";
  const poll = async () => {
    const state = await store.status();
    const next = JSON.stringify(state);
    if (next !== lastState) {
      lastState = next;
      broadcast({
        type: "state",
        state,
        config: {
          mode: config.mode,
          storage: config.storage,
          roots: config.roots,
          dataDir: config.dataDir,
          logDir: config.logDir,
        },
      });
    }
  };

  await poll();
  setInterval(() => {
    poll().catch(() => undefined);
  }, pollMs);

  server.listen(port, host, () => {
    process.stdout.write(`Dashboard running at http://${host}:${port}\n`);
  });
}
