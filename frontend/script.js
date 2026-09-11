// Floating chat widget UI. Mock replies only — not wired to the backend yet.

const chatToggle = document.getElementById("chat-toggle");
const chatWindow = document.getElementById("chat-window");
const chatClose = document.getElementById("chat-close");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");

const MOCK_REPLY = "Hi! I'm CafeBot. My AI brain isn't connected yet.";

function addMessage(text, sender) {
  const message = document.createElement("div");
  message.className = `message ${sender}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  message.appendChild(bubble);
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
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

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, "customer");
  chatInput.value = "";

  addMessage(MOCK_REPLY, "bot");
});
