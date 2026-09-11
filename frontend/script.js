// Floating chat widget UI. Talks to the real backend's /api/chat.
// Change this if the backend isn't running on its default port, or before
// deploying the frontend to a different host than the backend.
const API_BASE = "https://cafebot1.vercel.app";

const chatToggle = document.getElementById("chat-toggle");
const chatWindow = document.getElementById("chat-window");
const chatClose = document.getElementById("chat-close");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");

const NETWORK_ERROR_REPLY = "Sorry, I'm having trouble connecting right now. Please try again in a moment.";
// Keeps the request small — the backend only needs recent context, not the full chat.
const MAX_HISTORY_MESSAGES = 10;

let conversationHistory = [];
let sessionId = null;

function addMessage(text, sender) {
  const message = document.createElement("div");
  message.className = `message ${sender}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  message.appendChild(bubble);
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

function showTypingIndicator() {
  const typing = addMessage("...", "bot");
  typing.classList.add("typing-indicator");
  return typing;
}

function openChat() {
  chatWindow.classList.add("open");
  chatWindow.setAttribute("aria-hidden", "false");
  chatToggle.setAttribute("aria-expanded", "true");
  chatInput.focus();
}

function closeChat() {
  chatWindow.classList.remove("open");
  chatWindow.setAttribute("aria-hidden", "true");
  chatToggle.setAttribute("aria-expanded", "false");
}

chatToggle.addEventListener("click", () => {
  if (chatWindow.classList.contains("open")) {
    closeChat();
  } else {
    openChat();
  }
});

chatClose.addEventListener("click", closeChat);

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, "customer");
  chatInput.value = "";

  const typing = showTypingIndicator();

  try {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: conversationHistory.slice(-MAX_HISTORY_MESSAGES),
        sessionId,
      }),
    });

    const data = await response.json();
    typing.remove();

    if (!response.ok) {
      addMessage(data.error || NETWORK_ERROR_REPLY, "bot");
      return;
    }

    sessionId = data.sessionId || sessionId;
    conversationHistory.push({ role: "user", content: text });
    conversationHistory.push({ role: "assistant", content: data.reply });

    addMessage(data.reply, "bot");
  } catch {
    typing.remove();
    addMessage(NETWORK_ERROR_REPLY, "bot");
  }
});
