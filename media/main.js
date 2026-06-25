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
      case "tool": {
        const label = message.title + (message.status ? " — " + message.status : "");
        addMessage("tool", label);
        break;
      }
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
        endAssistant();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
