import http from "node:http";
import url from "node:url";
import { exec } from "node:child_process";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { createStore } from "./storage.js";
import type { Implementer } from "./storage.js";

// Focus a terminal window by name using AppleScript (macOS)
function focusTerminalWindow(windowName: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve({ success: false, error: "Focus only supported on macOS" });
      return;
    }

    // Try to find and focus a Terminal window that contains the implementer name
    const script = `
      tell application "Terminal"
        set windowList to every window
        repeat with w in windowList
          try
            set tabList to every tab of w
            repeat with t in tabList
              if custom title of t contains "${windowName}" then
                set frontmost of w to true
                activate
                return "found"
              end if
            end repeat
          end try
        end repeat
      end tell
      return "not found"
    `;

    exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, (error, stdout) => {
      if (error) {
        resolve({ success: false, error: error.message });
      } else if (stdout.trim() === "not found") {
        resolve({ success: false, error: "Terminal window not found" });
      } else {
        resolve({ success: true });
      }
    });
  });
}

// Check if a process is still running by PID
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 doesn't kill, just checks if process exists
    return true;
  } catch {
    return false;
  }
}

// Clean up implementers whose processes have died
async function cleanupDeadImplementers(
  store: ReturnType<typeof createStore>,
  implementers: Implementer[]
): Promise<Implementer[]> {
  const results: Implementer[] = [];
  for (const impl of implementers) {
    if (impl.status === "active" && impl.pid) {
      if (!isProcessRunning(impl.pid)) {
        // Process is dead, mark as stopped
        console.log(`Implementer ${impl.name} (PID ${impl.pid}) is dead, marking as stopped`);
        const updated = await store.updateImplementer(impl.id, "stopped");
        results.push(updated);
      } else {
        results.push(impl);
      }
    } else {
      results.push(impl);
    }
  }
  return results;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lockstep MCP</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");

      :root {
        /* Palantir Blueprint Dark Theme */
        --bg-base: #111418;
        --bg-elevated: #1C2127;
        --bg-card: #252A31;
        --bg-hover: #2F343C;
        --border: #383E47;
        --border-light: #404854;

        /* Text */
        --text-primary: #F6F7F9;
        --text-secondary: #ABB3BF;
        --text-muted: #738091;

        /* Accent Colors */
        --blue: #4C90F0;
        --blue-dim: #2D72D2;
        --blue-glow: rgba(76, 144, 240, 0.15);
        --green: #32A467;
        --green-dim: #238551;
        --green-glow: rgba(50, 164, 103, 0.15);
        --orange: #EC9A3C;
        --orange-glow: rgba(236, 154, 60, 0.15);
        --red: #E76A6E;
        --red-glow: rgba(231, 106, 110, 0.15);
        --violet: #9D7FEA;
        --violet-glow: rgba(157, 127, 234, 0.15);
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--text-primary);
        background: var(--bg-base);
        min-height: 100vh;
        line-height: 1.5;
      }

      /* Header */
      header {
        padding: 24px 32px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-base) 100%);
      }

      h1 {
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.02em;
        background: linear-gradient(135deg, var(--text-primary) 0%, var(--blue) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .status-badge {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 20px;
        font-size: 13px;
        color: var(--text-secondary);
      }

      .status-badge.connected {
        border-color: var(--green-dim);
        background: var(--green-glow);
        color: var(--green);
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--orange);
        box-shadow: 0 0 8px var(--orange);
      }

      .status-badge.connected .status-dot {
        background: var(--green);
        box-shadow: 0 0 8px var(--green);
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      /* Stats Grid */
      .stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
        padding: 24px 32px;
      }

      .stat {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 20px;
        transition: all 0.2s ease;
      }

      .stat:hover {
        border-color: var(--border-light);
        background: var(--bg-card);
      }

      .stat .label {
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        margin-bottom: 8px;
      }

      .stat .value {
        font-size: 32px;
        font-weight: 700;
        letter-spacing: -0.02em;
        background: linear-gradient(135deg, var(--text-primary) 0%, var(--text-secondary) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .stat .value.status-in_progress { color: var(--blue); -webkit-text-fill-color: var(--blue); }
      .stat .value.status-complete { color: var(--green); -webkit-text-fill-color: var(--green); }
      .stat .value.status-stopped { color: var(--red); -webkit-text-fill-color: var(--red); }

      /* Main Grid */
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 16px;
        padding: 0 32px 32px;
      }

      .panel {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .panel.wide { grid-column: span 2; }
      .panel.full { grid-column: span 3; }

      .panel-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--bg-card);
      }

      .panel-header h2 {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 500;
      }

      .pill.blue { background: var(--blue-glow); color: var(--blue); }
      .pill.green { background: var(--green-glow); color: var(--green); }
      .pill.orange { background: var(--orange-glow); color: var(--orange); }

      .list {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 400px;
        overflow-y: auto;
        flex: 1;
      }

      .list::-webkit-scrollbar { width: 6px; }
      .list::-webkit-scrollbar-track { background: transparent; }
      .list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

      /* Cards */
      .card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 14px;
        transition: all 0.15s ease;
      }

      .card:hover {
        border-color: var(--border-light);
        transform: translateY(-1px);
      }

      .card-title {
        font-weight: 600;
        font-size: 13px;
        color: var(--text-primary);
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .card-desc {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 10px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .card-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }

      .tag {
        padding: 3px 8px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
        font-family: "JetBrains Mono", monospace;
      }

      .tag.todo { background: var(--bg-hover); color: var(--text-muted); }
      .tag.in_progress { background: var(--blue-glow); color: var(--blue); }
      .tag.review { background: var(--violet-glow); color: var(--violet); }
      .tag.done { background: var(--green-glow); color: var(--green); }
      .tag.active { background: var(--green-glow); color: var(--green); }
      .tag.stopped { background: var(--red-glow); color: var(--red); }
      .tag.terminated { background: var(--red-glow); color: var(--red); }
      .tag.worktree { background: var(--violet-glow); color: var(--violet); }
      .tag.shared { background: var(--bg-hover); color: var(--text-muted); }
      .tag.branch { background: var(--violet-glow); color: var(--violet); font-size: 9px; }

      /* Implementer task summary */
      .impl-tasks {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--border);
      }
      .impl-task {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        margin-bottom: 4px;
      }
      .impl-task:last-child { margin-bottom: 0; }
      .impl-task .task-title {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      .impl-task-summary {
        font-size: 10px;
        color: var(--text-muted);
        margin-top: 4px;
      }

      /* Clickable implementer cards */
      .card.clickable {
        cursor: pointer;
        position: relative;
      }
      .card.clickable:hover {
        border-color: var(--blue);
        background: var(--bg-hover);
      }
      .card.clickable::after {
        content: "Click to focus";
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        color: var(--text-muted);
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .card.clickable:hover::after {
        opacity: 1;
      }

      .mono {
        font-family: "JetBrains Mono", monospace;
        font-size: 11px;
        color: var(--text-muted);
      }

      .empty {
        color: var(--text-muted);
        font-size: 13px;
        text-align: center;
        padding: 32px 16px;
      }

      /* Context Panel */
      .context-content {
        padding: 16px 20px;
      }

      .context-item {
        margin-bottom: 12px;
      }

      .context-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-muted);
        margin-bottom: 4px;
      }

      .context-value {
        font-size: 13px;
        color: var(--text-secondary);
      }

      /* Note Cards */
      .note-card {
        background: var(--bg-card);
        border-left: 3px solid var(--blue);
        border-radius: 0 8px 8px 0;
        padding: 12px 14px;
      }

      .note-card.system {
        border-left-color: var(--violet);
      }

      .note-author {
        font-size: 12px;
        font-weight: 600;
        color: var(--blue);
        margin-bottom: 4px;
      }

      .note-card.system .note-author {
        color: var(--violet);
      }

      .note-text {
        font-size: 12px;
        color: var(--text-secondary);
        line-height: 1.5;
      }

      .note-time {
        font-size: 10px;
        color: var(--text-muted);
        margin-top: 6px;
        font-family: "JetBrains Mono", monospace;
      }

      /* Footer */
      footer {
        padding: 16px 32px;
        border-top: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 11px;
        display: flex;
        justify-content: space-between;
      }

      @media (max-width: 1024px) {
        .stats { grid-template-columns: repeat(2, 1fr); }
        .grid { grid-template-columns: 1fr; }
        .panel.wide, .panel.full { grid-column: span 1; }
      }

      /* Progress Bar */
      .progress-section {
        padding: 0 32px 16px;
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .progress-bar-container {
        flex: 1;
        height: 8px;
        background: var(--bg-card);
        border-radius: 4px;
        overflow: hidden;
        border: 1px solid var(--border);
      }

      .progress-bar {
        height: 100%;
        background: linear-gradient(90deg, var(--green-dim) 0%, var(--green) 100%);
        border-radius: 4px;
        transition: width 0.3s ease;
        width: 0%;
      }

      .progress-text {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        min-width: 100px;
        text-align: right;
      }

      /* Activity Feed */
      .activity-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        background: var(--bg-card);
        border-radius: 6px;
        border-left: 3px solid var(--border);
      }

      .activity-item.task-claimed { border-left-color: var(--blue); }
      .activity-item.task-completed { border-left-color: var(--green); }
      .activity-item.task-review { border-left-color: var(--violet); }
      .activity-item.lock-acquired { border-left-color: var(--orange); }
      .activity-item.lock-released { border-left-color: var(--text-muted); }

      .activity-icon {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        flex-shrink: 0;
      }

      .activity-icon.claim { background: var(--blue-glow); color: var(--blue); }
      .activity-icon.complete { background: var(--green-glow); color: var(--green); }
      .activity-icon.review { background: var(--violet-glow); color: var(--violet); }
      .activity-icon.lock { background: var(--orange-glow); color: var(--orange); }

      .activity-content {
        flex: 1;
        min-width: 0;
      }

      .activity-text {
        font-size: 12px;
        color: var(--text-secondary);
        line-height: 1.4;
      }

      .activity-text strong {
        color: var(--text-primary);
        font-weight: 500;
      }

      .activity-time {
        font-size: 10px;
        color: var(--text-muted);
        font-family: "JetBrains Mono", monospace;
        margin-top: 2px;
      }

      /* Filter Bar */
      .filter-bar {
        display: flex;
        gap: 8px;
        padding: 12px;
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }

      .filter-btn {
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 500;
        background: var(--bg-card);
        border: 1px solid var(--border);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .filter-btn:hover {
        border-color: var(--border-light);
        color: var(--text-primary);
      }

      .filter-btn.active {
        background: var(--blue-glow);
        border-color: var(--blue);
        color: var(--blue);
      }

      .filter-btn.active.green {
        background: var(--green-glow);
        border-color: var(--green);
        color: var(--green);
      }

      /* Reset Button */
      .reset-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        background: var(--bg-card);
        border: 1px solid var(--border);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .reset-btn:hover {
        border-color: var(--red);
        color: var(--red);
        background: var(--red-glow);
      }

      .reset-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Confirmation Modal */
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .modal {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        max-width: 400px;
        width: 90%;
      }

      .modal h3 {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 12px;
        color: var(--text-primary);
      }

      .modal p {
        font-size: 13px;
        color: var(--text-secondary);
        margin-bottom: 20px;
        line-height: 1.5;
      }

      .modal-actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }

      .modal-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .modal-btn.cancel {
        background: var(--bg-card);
        border: 1px solid var(--border);
        color: var(--text-secondary);
      }

      .modal-btn.cancel:hover {
        border-color: var(--border-light);
        color: var(--text-primary);
      }

      .modal-btn.danger {
        background: var(--red-glow);
        border: 1px solid var(--red);
        color: var(--red);
      }

      .modal-btn.danger:hover {
        background: var(--red);
        color: white;
      }

      /* Toggle Switch */
      .toggle-container {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border);
      }

      .toggle-label {
        font-size: 11px;
        color: var(--text-muted);
      }

      .toggle {
        width: 36px;
        height: 20px;
        background: var(--bg-hover);
        border-radius: 10px;
        position: relative;
        cursor: pointer;
        transition: background 0.2s ease;
        border: 1px solid var(--border);
      }

      .toggle.active {
        background: var(--blue-glow);
        border-color: var(--blue);
      }

      .toggle::after {
        content: "";
        position: absolute;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--text-muted);
        top: 2px;
        left: 2px;
        transition: all 0.2s ease;
      }

      .toggle.active::after {
        left: 18px;
        background: var(--blue);
      }

      @media (max-width: 640px) {
        header, .stats, .grid, footer, .progress-section { padding-left: 16px; padding-right: 16px; }
        .stats { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Lockstep MCP</h1>
      <div style="display: flex; align-items: center; gap: 16px;">
        <button class="reset-btn" id="reset-btn" title="Reset session for fresh start">Reset Session</button>
        <div class="status-badge" id="status-badge">
          <div class="status-dot" id="status-dot"></div>
          <span id="status">Connecting</span>
        </div>
      </div>
    </header>

    <section class="stats">
      <div class="stat">
        <div class="label">Project Status</div>
        <div class="value" id="project-status">--</div>
      </div>
      <div class="stat">
        <div class="label">Total Tasks</div>
        <div class="value" id="task-count">0</div>
      </div>
      <div class="stat">
        <div class="label">Active Implementers</div>
        <div class="value" id="implementer-count">0</div>
      </div>
      <div class="stat">
        <div class="label">Active Locks</div>
        <div class="value" id="lock-count">0</div>
      </div>
    </section>

    <section class="progress-section">
      <div class="progress-bar-container">
        <div class="progress-bar" id="progress-bar"></div>
      </div>
      <div class="progress-text" id="progress-text">0% complete</div>
    </section>

    <section class="grid">
      <div class="panel">
        <div class="panel-header">
          <h2>Project Context</h2>
        </div>
        <div id="project-context" class="context-content">
          <div class="empty">No project context set</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Implementers</h2>
          <span class="pill green" id="impl-meta">0 active</span>
        </div>
        <div class="list" id="implementer-list"></div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Locks</h2>
          <span class="pill orange" id="lock-meta">0 active</span>
        </div>
        <div class="toggle-container">
          <span class="toggle-label">Show resolved</span>
          <div class="toggle" id="show-resolved-toggle"></div>
        </div>
        <div class="list" id="lock-list"></div>
      </div>
      <div class="panel wide">
        <div class="panel-header">
          <h2>Tasks</h2>
          <span class="pill blue" id="task-meta">0 total</span>
        </div>
        <div class="filter-bar">
          <button class="filter-btn active" data-filter="all">All</button>
          <button class="filter-btn" data-filter="in_progress">In Progress</button>
          <button class="filter-btn" data-filter="review">Review</button>
          <button class="filter-btn" data-filter="todo">Todo</button>
          <button class="filter-btn green" data-filter="done">Done</button>
        </div>
        <div class="list" id="task-list"></div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Activity</h2>
        </div>
        <div class="list" id="activity-list"></div>
      </div>
      <div class="panel full">
        <div class="panel-header">
          <h2>Notes</h2>
        </div>
        <div class="list" id="note-list"></div>
      </div>
    </section>

    <footer>
      <span>Lockstep MCP - Multi-agent coordination</span>
      <span>Updates via WebSocket</span>
    </footer>

    <script>
      const statusEl = document.getElementById("status");
      const statusBadge = document.getElementById("status-badge");
      const projectStatusEl = document.getElementById("project-status");
      const projectContextEl = document.getElementById("project-context");
      const implementerList = document.getElementById("implementer-list");
      const taskList = document.getElementById("task-list");
      const lockList = document.getElementById("lock-list");
      const noteList = document.getElementById("note-list");
      const activityList = document.getElementById("activity-list");
      const taskCount = document.getElementById("task-count");
      const implementerCount = document.getElementById("implementer-count");
      const lockCount = document.getElementById("lock-count");
      const taskMeta = document.getElementById("task-meta");
      const lockMeta = document.getElementById("lock-meta");
      const implMeta = document.getElementById("impl-meta");
      const progressBar = document.getElementById("progress-bar");
      const progressText = document.getElementById("progress-text");
      const showResolvedToggle = document.getElementById("show-resolved-toggle");
      const filterBtns = document.querySelectorAll(".filter-btn");

      // State
      let showResolvedLocks = false;
      let currentTaskFilter = "all";
      let allTasks = [];
      let allLocks = [];
      let activityLog = [];

      // Toggle resolved locks
      showResolvedToggle.addEventListener("click", () => {
        showResolvedLocks = !showResolvedLocks;
        showResolvedToggle.classList.toggle("active", showResolvedLocks);
        renderLocks(allLocks);
      });

      // Task filter buttons
      filterBtns.forEach(btn => {
        btn.addEventListener("click", () => {
          filterBtns.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          currentTaskFilter = btn.dataset.filter;
          renderTasks(allTasks);
        });
      });

      // Reset session button
      const resetBtn = document.getElementById("reset-btn");
      resetBtn.addEventListener("click", () => {
        showResetModal();
      });

      function showResetModal() {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = \`
          <div class="modal">
            <h3>Reset Session?</h3>
            <p>This will clear all tasks, locks, notes, and archive discussions. Use this when starting a new project or when data from previous sessions is cluttering the dashboard.</p>
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 12px; color: var(--text-secondary);">
              <input type="checkbox" id="keep-context-checkbox">
              Keep project description (only reset tasks and data)
            </label>
            <div class="modal-actions">
              <button class="modal-btn cancel" id="cancel-reset">Cancel</button>
              <button class="modal-btn danger" id="confirm-reset">Reset Session</button>
            </div>
          </div>
        \`;
        document.body.appendChild(overlay);

        document.getElementById("cancel-reset").addEventListener("click", () => {
          overlay.remove();
        });

        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) overlay.remove();
        });

        document.getElementById("confirm-reset").addEventListener("click", async () => {
          const keepContext = document.getElementById("keep-context-checkbox").checked;
          overlay.remove();
          await resetSession(keepContext);
        });
      }

      async function resetSession(keepProjectContext) {
        resetBtn.disabled = true;
        resetBtn.textContent = "Resetting...";
        try {
          const response = await fetch("/api/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keepProjectContext })
          });
          const result = await response.json();
          if (result.success) {
            // Clear local state
            activityLog = [];
            prevTaskStates = {};
            prevLockStates = {};
            // Refresh the dashboard
            await fetchState();
            alert("Session reset complete!\\n\\n" + result.message);
          } else {
            alert("Reset failed: " + (result.error || "Unknown error"));
          }
        } catch (err) {
          alert("Reset failed: " + err.message);
        } finally {
          resetBtn.disabled = false;
          resetBtn.textContent = "Reset Session";
        }
      }

      function escapeHtml(text) {
        const map = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        };
        return text.replace(/[&<>"']/g, (char) => map[char]);
      }

      function formatTime(isoString) {
        const date = new Date(isoString);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }

      function renderTasks(tasks) {
        allTasks = tasks; // Store for filtering
        taskList.innerHTML = "";

        // Apply filter
        let filtered = tasks;
        if (currentTaskFilter !== "all") {
          filtered = tasks.filter(t => t.status === currentTaskFilter);
        }

        if (!filtered.length) {
          const msg = currentTaskFilter === "all" ? "No tasks yet" : "No " + currentTaskFilter.replace("_", " ") + " tasks";
          taskList.innerHTML = '<div class="empty">' + msg + '</div>';
          return;
        }
        // Sort: in_progress first, then review, then todo, then done
        const order = { in_progress: 0, review: 1, todo: 2, done: 3 };
        const sorted = [...filtered].sort((a, b) => (order[a.status] || 99) - (order[b.status] || 99));
        sorted.forEach(task => {
          const card = document.createElement("div");
          card.className = "card";
          const desc = task.description
            ? '<div class="card-desc">' + escapeHtml(task.description.substring(0, 150)) + (task.description.length > 150 ? '...' : '') + "</div>"
            : "";
          // Show isolation mode if set to worktree
          const isolationTag = task.isolation === "worktree"
            ? '<span class="tag worktree">worktree</span>'
            : '';
          card.innerHTML =
            '<div class="card-title">' +
            '<span class="tag ' + task.status + '">' + task.status.replace('_', ' ') + '</span>' +
            escapeHtml(task.title) +
            "</div>" +
            desc +
            '<div class="card-meta">' +
            (task.owner ? '<span class="mono">@' + escapeHtml(task.owner) + '</span>' : '') +
            (task.complexity ? '<span class="tag">' + task.complexity + '</span>' : '') +
            isolationTag +
            '<span class="mono">' + formatTime(task.updatedAt) + '</span>' +
            "</div>";
          taskList.appendChild(card);
        });
      }

      function renderLocks(locks) {
        allLocks = locks; // Store for toggle
        lockList.innerHTML = "";

        // Filter based on toggle
        let filtered = showResolvedLocks ? locks : locks.filter(l => l.status === "active");

        if (!filtered.length) {
          const msg = showResolvedLocks ? "No locks" : "No active locks";
          lockList.innerHTML = '<div class="empty">' + msg + '</div>';
          return;
        }

        // Sort: active first, then by updatedAt desc
        filtered = [...filtered].sort((a, b) => {
          if (a.status === "active" && b.status !== "active") return -1;
          if (a.status !== "active" && b.status === "active") return 1;
          return b.updatedAt.localeCompare(a.updatedAt);
        });

        filtered.forEach(lock => {
          const card = document.createElement("div");
          card.className = "card";
          const fileName = lock.path.split('/').pop();
          card.innerHTML =
            '<div class="card-title">' +
            '<span class="tag ' + lock.status + '">' + lock.status + '</span>' +
            escapeHtml(fileName) +
            "</div>" +
            '<div class="card-desc mono">' + escapeHtml(lock.path) + '</div>' +
            '<div class="card-meta">' +
            (lock.owner ? '<span class="mono">@' + escapeHtml(lock.owner) + '</span>' : '') +
            '<span class="mono">' + formatTime(lock.updatedAt) + '</span>' +
            "</div>";
          lockList.appendChild(card);
        });
      }

      function renderNotes(notes) {
        noteList.innerHTML = "";
        if (!notes.length) {
          noteList.innerHTML = '<div class="empty">No notes yet</div>';
          return;
        }
        const sorted = [...notes].reverse().slice(0, 10);
        sorted.forEach(note => {
          const card = document.createElement("div");
          const isSystem = note.author === "system";
          card.className = "note-card" + (isSystem ? " system" : "");
          card.innerHTML =
            '<div class="note-author">' + (note.author ? escapeHtml(note.author) : "Anonymous") + '</div>' +
            '<div class="note-text">' + escapeHtml(note.text) + '</div>' +
            '<div class="note-time">' + formatTime(note.createdAt) + '</div>';
          noteList.appendChild(card);
        });
      }

      // Track previous state for activity detection
      let prevTaskStates = {};
      let prevLockStates = {};

      function detectActivity(tasks, locks) {
        const newActivities = [];
        const now = new Date().toISOString();

        // Detect task state changes
        tasks.forEach(task => {
          const prev = prevTaskStates[task.id];
          if (prev && prev !== task.status) {
            if (task.status === "in_progress" && prev === "todo") {
              newActivities.push({
                type: "task-claimed",
                icon: "claim",
                text: '<strong>' + escapeHtml(task.owner || "Someone") + '</strong> claimed <strong>' + escapeHtml(task.title) + '</strong>',
                time: now
              });
            } else if (task.status === "done") {
              newActivities.push({
                type: "task-completed",
                icon: "complete",
                text: '<strong>' + escapeHtml(task.title) + '</strong> completed',
                time: now
              });
            } else if (task.status === "review") {
              newActivities.push({
                type: "task-review",
                icon: "review",
                text: '<strong>' + escapeHtml(task.title) + '</strong> submitted for review',
                time: now
              });
            }
          }
          prevTaskStates[task.id] = task.status;
        });

        // Detect lock changes
        locks.forEach(lock => {
          const prev = prevLockStates[lock.path];
          if (!prev && lock.status === "active") {
            newActivities.push({
              type: "lock-acquired",
              icon: "lock",
              text: '<strong>' + escapeHtml(lock.owner || "Someone") + '</strong> locked <strong>' + escapeHtml(lock.path.split("/").pop()) + '</strong>',
              time: now
            });
          } else if (prev === "active" && lock.status === "resolved") {
            newActivities.push({
              type: "lock-released",
              icon: "lock",
              text: '<strong>' + escapeHtml(lock.path.split("/").pop()) + '</strong> released',
              time: now
            });
          }
          prevLockStates[lock.path] = lock.status;
        });

        // Add to activity log (keep last 50)
        activityLog = [...newActivities, ...activityLog].slice(0, 50);
      }

      function renderActivity() {
        activityList.innerHTML = "";
        if (!activityLog.length) {
          activityList.innerHTML = '<div class="empty">No recent activity</div>';
          return;
        }
        activityLog.slice(0, 15).forEach(activity => {
          const item = document.createElement("div");
          item.className = "activity-item " + activity.type;
          item.innerHTML =
            '<div class="activity-icon ' + activity.icon + '">' +
            (activity.icon === "claim" ? "→" : activity.icon === "complete" ? "✓" : activity.icon === "review" ? "?" : "🔒") +
            '</div>' +
            '<div class="activity-content">' +
            '<div class="activity-text">' + activity.text + '</div>' +
            '<div class="activity-time">' + formatTime(activity.time) + '</div>' +
            '</div>';
          activityList.appendChild(item);
        });
      }

      // Compute dynamic status based on tasks and implementers
      function computeDynamicStatus(context, tasks, implementers) {
        const activeImpls = (implementers || []).filter(i => i.status === "active").length;
        const todoTasks = tasks.filter(t => t.status === "todo" || t.status === "in_progress" || t.status === "review").length;
        const allDone = tasks.length > 0 && todoTasks === 0;

        if (allDone) {
          return { text: "Complete", className: "status-complete" };
        }
        if (activeImpls === 0 && tasks.length > 0) {
          return { text: "Paused", className: "status-stopped" };
        }
        if (context && context.status) {
          return { text: context.status.replace('_', ' '), className: "status-" + context.status };
        }
        return { text: "--", className: "" };
      }

      function renderProjectContext(context, tasks, implementers) {
        if (!context) {
          projectContextEl.innerHTML = '<div class="empty">No project context set</div>';
          const dynamicStatus = computeDynamicStatus(null, tasks || [], implementers || []);
          projectStatusEl.textContent = dynamicStatus.text;
          projectStatusEl.className = "value " + dynamicStatus.className;
          return;
        }
        const dynamicStatus = computeDynamicStatus(context, tasks || [], implementers || []);
        projectStatusEl.textContent = dynamicStatus.text;
        projectStatusEl.className = "value " + dynamicStatus.className;

        let html = '';
        html += '<div class="context-item"><div class="context-label">Description</div>';
        html += '<div class="context-value">' + escapeHtml(context.description || "No description") + '</div></div>';

        html += '<div class="context-item"><div class="context-label">End State</div>';
        html += '<div class="context-value">' + escapeHtml(context.endState || "Not defined") + '</div></div>';

        if (context.techStack && context.techStack.length) {
          html += '<div class="context-item"><div class="context-label">Tech Stack</div>';
          html += '<div class="context-value">' + context.techStack.map(escapeHtml).join(", ") + '</div></div>';
        }
        if (context.implementationPlan && context.implementationPlan.length) {
          html += '<div class="context-item"><div class="context-label">Plan Steps</div>';
          html += '<div class="context-value">' + context.implementationPlan.length + ' steps defined</div></div>';
        }
        if (context.preferredImplementer) {
          html += '<div class="context-item"><div class="context-label">Implementer Type</div>';
          html += '<div class="context-value">' + context.preferredImplementer + '</div></div>';
        }
        projectContextEl.innerHTML = html;
      }

      async function focusImplementer(implId) {
        try {
          const response = await fetch("/api/focus/" + encodeURIComponent(implId), { method: "POST" });
          const result = await response.json();
          if (!result.success) {
            console.error("Failed to focus:", result.error);
          }
        } catch (err) {
          console.error("Failed to focus implementer:", err);
        }
      }

      function renderImplementers(implementers, tasks) {
        implementerList.innerHTML = "";
        if (!implementers || !implementers.length) {
          implementerList.innerHTML = '<div class="empty">No implementers launched</div>';
          return;
        }
        tasks = tasks || [];
        implementers.forEach(impl => {
          const card = document.createElement("div");
          const isActive = impl.status === "active";
          const isWorktree = impl.isolation === "worktree";
          card.className = "card" + (isActive ? " clickable" : "");

          // Build isolation/branch display
          let isolationHtml = '';
          if (isWorktree && impl.branchName) {
            isolationHtml = '<span class="tag worktree">worktree</span>' +
              '<span class="tag branch">' + escapeHtml(impl.branchName) + '</span>';
          } else if (impl.isolation) {
            isolationHtml = '<span class="tag ' + impl.isolation + '">' + impl.isolation + '</span>';
          }

          // Get tasks for this implementer
          const implTasks = tasks.filter(t => t.owner === impl.name);
          const currentTask = implTasks.find(t => t.status === "in_progress");
          const reviewTasks = implTasks.filter(t => t.status === "review");
          const doneTasks = implTasks.filter(t => t.status === "done");

          // Build task summary HTML
          let tasksHtml = '';
          if (implTasks.length > 0) {
            tasksHtml = '<div class="impl-tasks">';
            if (currentTask) {
              tasksHtml += '<div class="impl-task">' +
                '<span class="tag in_progress">working</span>' +
                '<span class="task-title">' + escapeHtml(currentTask.title) + '</span>' +
                '</div>';
            }
            reviewTasks.forEach(t => {
              tasksHtml += '<div class="impl-task">' +
                '<span class="tag review">review</span>' +
                '<span class="task-title">' + escapeHtml(t.title) + '</span>' +
                '</div>';
            });
            if (doneTasks.length > 0 && !currentTask && reviewTasks.length === 0) {
              // Show most recent done task if no active work
              const recentDone = doneTasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
              tasksHtml += '<div class="impl-task">' +
                '<span class="tag done">done</span>' +
                '<span class="task-title">' + escapeHtml(recentDone.title) + '</span>' +
                '</div>';
            }
            tasksHtml += '<div class="impl-task-summary">' + doneTasks.length + ' completed, ' +
              (implTasks.length - doneTasks.length) + ' remaining</div>';
            tasksHtml += '</div>';
          }

          card.innerHTML =
            '<div class="card-title">' +
            '<span class="tag ' + impl.status + '">' + impl.status + '</span>' +
            escapeHtml(impl.name) +
            '</div>' +
            '<div class="card-meta">' +
            '<span class="tag">' + impl.type + '</span>' +
            isolationHtml +
            '<span class="mono">' + formatTime(impl.createdAt) + '</span>' +
            "</div>" +
            tasksHtml;
          if (isActive) {
            card.addEventListener("click", () => focusImplementer(impl.id));
          }
          implementerList.appendChild(card);
        });
      }

      function updateState(state, config, projectContext, implementers) {
        taskCount.textContent = state.tasks.length;
        const activeLocks = state.locks.filter(lock => lock.status === "active").length;
        lockCount.textContent = activeLocks; // Show ACTIVE locks only
        const activeImpls = (implementers || []).filter(i => i.status === "active").length;
        implementerCount.textContent = activeImpls;

        const todoTasks = state.tasks.filter(t => t.status === "todo").length;
        const inProgressTasks = state.tasks.filter(t => t.status === "in_progress").length;
        const reviewTasks = state.tasks.filter(t => t.status === "review").length;
        const doneTasks = state.tasks.filter(t => t.status === "done").length;
        taskMeta.textContent = todoTasks + " todo / " + inProgressTasks + " active / " + reviewTasks + " review / " + doneTasks + " done";

        lockMeta.textContent = activeLocks + " active" + (state.locks.length > activeLocks ? " / " + state.locks.length + " total" : "");
        implMeta.textContent = activeImpls + " active";

        // Update progress bar
        const totalTasks = state.tasks.length;
        const completedTasks = doneTasks;
        const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
        progressBar.style.width = progressPercent + "%";
        progressText.textContent = progressPercent + "% complete (" + completedTasks + "/" + totalTasks + ")";

        // Detect activity changes
        detectActivity(state.tasks, state.locks);
        renderActivity();

        renderProjectContext(projectContext, state.tasks, implementers);
        renderImplementers(implementers, state.tasks);
        renderTasks(state.tasks);
        renderLocks(state.locks);
        renderNotes(state.notes);
      }

      async function fetchState() {
        try {
          const response = await fetch("/api/state");
          const data = await response.json();
          console.log("Fetched state:", data);
          updateState(data.state, data.config, data.projectContext, data.implementers);
        } catch (err) {
          console.error("Failed to fetch state:", err);
          statusEl.textContent = "Error loading data - check console";
        }
      }

      function connect() {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const wsUrl = protocol + "://" + window.location.host + "/ws";
        console.log("Connecting to WebSocket:", wsUrl);
        const socket = new WebSocket(wsUrl);

        socket.addEventListener("open", () => {
          console.log("WebSocket connected");
          statusEl.textContent = "Live";
          statusBadge.classList.add("connected");
        });

        socket.addEventListener("message", (event) => {
          const payload = JSON.parse(event.data);
          console.log("WebSocket message:", payload.type);
          if (payload.type === "snapshot" || payload.type === "state") {
            updateState(payload.state, payload.config, payload.projectContext, payload.implementers);
          }
        });

        socket.addEventListener("error", (event) => {
          console.error("WebSocket error:", event);
          statusBadge.classList.remove("connected");
        });

        socket.addEventListener("close", (event) => {
          console.log("WebSocket closed:", event.code, event.reason);
          statusEl.textContent = "Reconnecting";
          statusBadge.classList.remove("connected");
          setTimeout(connect, 2000);
        });
      }

      // Load initial data immediately, then connect for live updates
      fetchState().then(() => {
        console.log("Initial fetch complete");
      });
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
  const pollMsIdle = options.pollMs ?? 1500;
  const pollMsActive = 500; // Faster polling during active work

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url || "");

    // Handle focus implementer API
    const focusMatch = parsed.pathname?.match(/^\/api\/focus\/(.+)$/);
    if (focusMatch && req.method === "POST") {
      const implId = decodeURIComponent(focusMatch[1]);
      const implementers = await store.listImplementers();
      const impl = implementers.find(i => i.id === implId);

      if (!impl) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Implementer not found" }));
        return;
      }

      if (impl.status !== "active") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Implementer is not active" }));
        return;
      }

      const result = await focusTerminalWindow(impl.name);
      res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Handle session reset API
    if (parsed.pathname === "/api/reset" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body || "{}");
          const keepProjectContext = data.keepProjectContext ?? false;
          const projectRoot = config.roots[0] ?? process.cwd();

          const result = await store.resetSession(projectRoot, { keepProjectContext });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            ...result,
            message: `Cleared ${result.tasksCleared} tasks, ${result.locksCleared} locks, ${result.notesCleared} notes. Reset ${result.implementersReset} implementers, archived ${result.discussionsArchived} discussions.`
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: message }));
        }
      });
      return;
    }

    if (parsed.pathname === "/api/state") {
      const state = await store.status();
      // Get ALL project contexts and implementers (not filtered by root)
      const allContexts = await store.listAllProjectContexts();
      // Use the most recently updated context, or first one
      const projectContext = allContexts.length > 0
        ? allContexts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
        : null;
      // Get implementers and clean up any dead processes
      const rawImplementers = await store.listImplementers();
      const implementers = await cleanupDeadImplementers(store, rawImplementers);
      const payload = {
        state,
        projectContext,
        allContexts,
        implementers,
        config: {
          mode: config.mode,
          storage: config.storage,
          roots: config.roots,
          dataDir: config.dataDir,
          logDir: config.logDir,
        },
      };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
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
    const allContexts = await store.listAllProjectContexts();
    const projectContext = allContexts.length > 0
      ? allContexts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      : null;
    const rawImplementers = await store.listImplementers();
    const implementers = await cleanupDeadImplementers(store, rawImplementers);
    broadcast({
      type: "snapshot",
      state,
      projectContext,
      allContexts,
      implementers,
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

  let lastHash = "";
  let lastActiveCount = 0;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  const poll = async () => {
    const state = await store.status();
    const allContexts = await store.listAllProjectContexts();
    const projectContext = allContexts.length > 0
      ? allContexts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      : null;
    const rawImplementers = await store.listImplementers();
    const implementers = await cleanupDeadImplementers(store, rawImplementers);

    // Check if we should use fast or slow polling
    const activeImpls = implementers.filter(i => i.status === "active").length;
    const activeTasks = state.tasks.filter(t => t.status === "in_progress" || t.status === "review").length;
    const activeLocks = state.locks.filter(l => l.status === "active").length;
    const isActive = activeImpls > 0 || activeTasks > 0 || activeLocks > 0;

    // Adjust poll interval if activity level changed
    if ((isActive && lastActiveCount === 0) || (!isActive && lastActiveCount > 0)) {
      const newPollMs = isActive ? pollMsActive : pollMsIdle;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
      pollInterval = setInterval(() => {
        poll().catch(() => undefined);
      }, newPollMs);
      console.log(`Poll interval: ${newPollMs}ms (${isActive ? "active" : "idle"})`);
    }
    lastActiveCount = isActive ? 1 : 0;

    const next = JSON.stringify({ state, projectContext, implementers });
    if (next !== lastHash) {
      lastHash = next;
      broadcast({
        type: "state",
        state,
        projectContext,
        allContexts,
        implementers,
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
  // Start with idle polling, will switch to active if needed
  pollInterval = setInterval(() => {
    poll().catch(() => undefined);
  }, pollMsIdle);

  server.listen(port, host, () => {
    process.stdout.write(`Dashboard running at http://${host}:${port}\n`);
  });
}
