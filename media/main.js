// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const statusEl = document.getElementById("status");
  const formEl = document.getElementById("composer");
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const sendEl = /** @type {HTMLButtonElement} */ (document.getElementById("send"));

  // The assistant streams in chunks; keep a handle to the current bubble so we
  // can append to it rather than creating a new one per chunk.
  let currentAssistant = null;
  let busy = false;

  // Tool calls arrive as tool_call -> tool_call_update sharing one toolCallId.
  // Track each row by id so updates mutate it in place instead of stacking.
  const toolEls = new Map();

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = "message message-" + role;
    const body = document.createElement("div");
    body.className = "bubble";
    body.textContent = text;
    el.appendChild(body);
    messagesEl.appendChild(el);
    scrollToBottom();
    return body;
  }

  function appendAssistant(text) {
    if (!currentAssistant) {
      currentAssistant = addMessage("assistant", "");
    }
    currentAssistant.textContent += text;
    scrollToBottom();
  }

  function endAssistant() {
    currentAssistant = null;
  }

  function parsePercent(title) {
    const m = /\((\d+)%\)/.exec(title || "");
    if (!m) {
      return null;
    }
    const n = parseInt(m[1], 10);
    return isNaN(n) ? null : Math.max(0, Math.min(100, n));
  }

  function stripPercent(title) {
    return (title || "").replace(/\s*\(\d+%\)/, "").trim();
  }

  // Render (or update in place) a tool-call row keyed by toolCallId. A title
  // like "Downloading … (42%)" is shown as a label plus a progress bar.
  function renderTool(message) {
    const key = message.toolCallId || null;
    let entry = key ? toolEls.get(key) : null;

    if (!entry) {
      const el = document.createElement("div");
      el.className = "message message-tool";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      const labelEl = document.createElement("div");
      labelEl.className = "tool-label";
      const progress = document.createElement("div");
      progress.className = "tool-progress";
      progress.hidden = true;
      const bar = document.createElement("div");
      bar.className = "tool-progress-bar";
      progress.appendChild(bar);
      bubble.appendChild(labelEl);
      bubble.appendChild(progress);
      el.appendChild(bubble);
      messagesEl.appendChild(el);
      entry = { el, labelEl, progress, bar, title: "", status: "" };
      if (key) {
        toolEls.set(key, entry);
      }
    }

    // Updates may omit fields; only overwrite what we were given.
    if (typeof message.title === "string" && message.title) {
      entry.title = message.title;
    }
    if (typeof message.status === "string" && message.status) {
      entry.status = message.status;
    }

    const pct = parsePercent(entry.title);
    const text = (pct === null ? entry.title : stripPercent(entry.title)) || "tool";
    entry.labelEl.textContent = text + (entry.status ? " — " + entry.status : "");
    entry.el.className = "message message-tool" + (entry.status ? " tool-" + entry.status : "");

    if (pct === null) {
      entry.progress.hidden = true;
    } else {
      entry.progress.hidden = false;
      entry.bar.style.width = pct + "%";
    }
    scrollToBottom();
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setBusy(value) {
    busy = value;
    sendEl.disabled = value;
    sendEl.textContent = value ? "…" : "Send";
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || busy) {
      return;
    }
    endAssistant();
    vscode.postMessage({ type: "prompt", text });
    inputEl.value = "";
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  inputEl.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "user":
        endAssistant();
        addMessage("user", message.text);
        break;
      case "assistant":
        appendAssistant(message.text || "");
        break;
      case "thought":
        addMessage("thought", message.text || "");
        break;
      case "tool":
        renderTool(message);
        break;
      case "status":
        setStatus(message.text || "");
        break;
      case "error":
        endAssistant();
        addMessage("error", message.text || "Error");
        break;
      case "log":
        // Agent stderr — surface quietly in the status line.
        if (message.text) {
          setStatus(String(message.text).trim().split("\n").pop() || "");
        }
        break;
      case "busy":
        setBusy(!!message.busy);
        break;
      case "turnEnd":
        endAssistant();
        setBusy(false);
        break;
      case "clear":
        messagesEl.innerHTML = "";
        toolEls.clear();
        endAssistant();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
