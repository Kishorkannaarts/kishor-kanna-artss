(function () {
  var bubble = document.getElementById('kka-chat-bubble');
  var panel = document.getElementById('kka-chat-panel');
  var closeBtn = document.getElementById('kka-chat-close');
  var form = document.getElementById('kka-chat-form');
  var input = document.getElementById('kka-chat-input');
  var log = document.getElementById('kka-chat-log');
  if (!bubble || !panel || !form) return;

  // Backstop in case the model ever ignores the "no links" instruction:
  // strips markdown-style [label](url) down to just the label, and removes
  // any bare URL outright, so nothing clickable/linky ever reaches the DOM.
  function stripLinks(text) {
    return text
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1');
  }

  function addMessage(text, who) {
    var row = document.createElement('div');
    row.className = 'kka-chat-msg kka-chat-msg-' + who;
    row.textContent = who === 'bot' ? stripLinks(text) : text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function openPanel() {
    panel.classList.add('open');
    bubble.classList.add('hidden');
    if (!log.dataset.greeted) {
      addMessage("Hi! I'm here to help with questions or your custom art order. What would you like to know?", 'bot');
      log.dataset.greeted = '1';
    }
    input.focus();
  }

  bubble.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', function () {
    panel.classList.remove('open');
    bubble.classList.remove('hidden');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';
    input.disabled = true;

    var typing = document.createElement('div');
    typing.className = 'kka-chat-msg kka-chat-msg-bot kka-chat-typing';
    typing.textContent = '...';
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        addMessage(data.reply || "Sorry, something went wrong — please try again.", 'bot');
      })
      .catch(function () {
        typing.remove();
        addMessage("Sorry, I couldn't send that — please check your connection and try again.", 'bot');
      })
      .finally(function () {
        input.disabled = false;
        input.focus();
      });
  });
})();
