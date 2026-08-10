const MAX_MESSAGES = 60;

export class ChatPanel {
  constructor({ log, announcer }) {
    this.log = log;
    this.announcer = announcer;
  }

  push({ name, body, kind = "user", you = false, dead = false }) {
    const li = document.createElement("li");
    li.className = `msg msg--${kind}${dead ? " msg--dead" : ""}`;

    if (name) {
      const n = document.createElement("span");
      n.className = `msg__name${you ? " msg__name--you" : ""}`;
      n.textContent = `${name}: `;
      li.append(n);
    }
    const b = document.createElement("span");
    b.className = "msg__body";
    b.textContent = body;
    li.append(b);

    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    this.log.append(li);
    while (this.log.children.length > MAX_MESSAGES) this.log.firstElementChild.remove();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  announce(text) {
    this.announcer.textContent = text;
  }
}
