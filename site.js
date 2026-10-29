// The site's few scripts: this year in the footer, and the contact page's form and "Copy".

for (const year of document.querySelectorAll(".year")) year.textContent = new Date().getFullYear();

// Copies text, or says it couldn't (no clipboard access).
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // older browsers, or a page opened without https
    const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    area.style.cssText = "position: fixed; opacity: 0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

const copyButton = document.getElementById("copy-address");
if (copyButton) {
  const address = document.getElementById("address");
  let reset = 0;
  copyButton.addEventListener("click", async () => {
    copyButton.style.minWidth = `${copyButton.offsetWidth}px`; // the same size whatever it says
    const copied = await copy(address.textContent.trim());
    copyButton.textContent = copied ? "Copied" : "Couldn’t copy";
    if (!copied) getSelection().selectAllChildren(address); // selected, to copy by hand
    clearTimeout(reset);
    reset = setTimeout(() => (copyButton.textContent = "Copy"), 2000);
  });
}

// The contact form: a name, an email address that looks real, and a message, each checked before
// anything is sent, then sent to the site's own contact form on Cloudflare (the form's action:
// contact-worker/), which emails it to me.
const form = document.getElementById("contact-form");
if (form) {
  const status = document.getElementById("form-status");
  const send = form.querySelector('[type="submit"]');
  const checks = {
    name: (value) => (value ? "" : "Please enter your name."),
    email: (value) =>
      !value ? "Please enter your email address."
      : /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? ""
      : "That email address doesn’t look right.",
    message: (value) => (value ? "" : "Please write a message."),
  };
  const fields = Object.keys(checks).map((name) => form.elements[name]);

  // Marks a field that's wrong, with a line under it saying why, and says whether it's fine.
  function check(field) {
    const problem = checks[field.name](field.value.trim());
    field.setAttribute("aria-invalid", problem ? "true" : "false");
    document.getElementById(`${field.id}-error`).textContent = problem;
    return !problem;
  }

  function say(text, isError = false) {
    status.replaceChildren(...[text].flat());
    status.classList.toggle("error", isError);
  }

  form.noValidate = true; // these checks instead of the browser's, which let "me@home" through
  for (const field of fields) {
    // once a field is marked, the mark goes as soon as it's fixed
    field.addEventListener("input", () => field.getAttribute("aria-invalid") === "true" && check(field));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const wrong = fields.filter((field) => !check(field));
    if (wrong.length) {
      say("");
      wrong[0].focus();
      return;
    }
    const data = Object.fromEntries(new FormData(form));
    if (data._honey) return; // a spam bot filled in the hidden field
    for (const field of fields) data[field.name] = data[field.name].trim();
    const subject = `A message from ${data.name} (oslohaggadone.com)`;

    send.disabled = true;
    say("Sending…");
    try {
      // as text/plain, which a page may send to another site without asking first
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error(result.message);
      form.reset();
      say(`Thanks, ${data.name}! Your message is on its way.`);
    } catch {
      // not sent: offer it in their own email app instead, already written out
      const mailto = Object.assign(document.createElement("a"), {
        href: `${document.getElementById("address").href}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(data.message)}`,
        textContent: "email it to me",
      });
      say(["It didn’t send. You can ", mailto, " instead."], true);
    } finally {
      send.disabled = false;
    }
  });
}
