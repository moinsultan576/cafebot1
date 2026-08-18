// Mock-only chat interface. No AI API, database, or auth is connected here.

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");

// Canned replies used only to demonstrate the bot bubble style.
const MOCK_REPLIES = [
  "Got it! Anything else I can help with?",
  "Sounds good — I've noted that down.",
  "Great choice! Would you like to add anything else?",
  "Thanks for letting me know!",
];

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

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, "customer");
  chatInput.value = "";

  const reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
  setTimeout(() => addMessage(reply, "bot"), 500);
});
