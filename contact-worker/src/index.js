// The portfolio's contact form on Cloudflare Workers, and Synopsist's feedback. Each is emailed to the
// inbox business@oslohaggadone.com forwards to (CONTACT_TO, a secret, so that address isn't in this
// public repository), through Email Routing, which sends to an inbox verified there for free, on any
// plan:
// - POST /: a message from the form at oslohaggadone.com/contact/, with the sender's address to reply
//   to. site.js sends the fields as JSON (as text/plain, which a page may send to another site without
//   asking first) and reads the answer; without JavaScript the form posts itself here and is sent back
//   to the contact page, to #sent or #not-sent. Each message is checked the way site.js checks it.
// - POST /feedback: anonymous feedback from Synopsist's feedback page (oslohaggadone.com/Synopsist/
//   #feedback, its js/feedback.js), the same way: a rating out of five, a few words, or both, and the
//   site's language. No name or address, so there's no one to reply to.
// Nothing is kept: no database and no logs (wrangler.toml); a connection's address is held in memory
// only for its ten minutes, to turn away floods (each form counts on its own).

const FROM = { email: "form@oslohaggadone.com", name: "oslohaggadone.com" };
const PAGE = "https://oslohaggadone.com/contact/"; // where a form posted without JavaScript goes back to
const FEEDBACK_PAGE = "https://oslohaggadone.com/Synopsist/#feedback";
const MAX_BODY_BYTES = 16 * 1024;
const LONGEST = { name: 100, email: 254, message: 5000, feedback: 2000 }; // the forms' maxlength
const LANGUAGES = { en: "English", zh: "Chinese", ja: "Japanese", ko: "Korean" }; // Synopsist's (its js/i18n.js)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/; // name@domain.tld, as site.js checks it
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOW_MS = 10 * 60_000;
const PER_CONNECTION = 5; // messages from one connection in WINDOW_MS
const IN_ALL = 30; // from everyone, on each of Cloudflare's servers (each counts on its own)

const counts = new Map(); // a form ("/" or "/feedback") -> its messages within WINDOW_MS: { recent, everyone }

function allowedOrigins(env) {
  return (env.ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
}

function cors(request, env) {
  const origin = request.headers.get("Origin");
  return origin && allowedOrigins(env).includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

// Whether there's room for one more message to this form from this connection, counting it if there is
function withinLimits(form, address, now = Date.now()) {
  if (!counts.has(form)) counts.set(form, { recent: new Map(), everyone: [] }); // connection -> its times; everyone's
  const count = counts.get(form);
  count.everyone = count.everyone.filter((time) => now - time < WINDOW_MS);
  for (const [key, times] of count.recent) if (times.every((time) => now - time >= WINDOW_MS)) count.recent.delete(key);
  const mine = (count.recent.get(address) ?? []).filter((time) => now - time < WINDOW_MS);
  if (mine.length >= PER_CONNECTION || count.everyone.length >= IN_ALL) return false;
  mine.push(now);
  count.everyone.push(now);
  count.recent.set(address, mine);
  return true;
}

// The fields of either kind of post: a form's (name=…&email=…), or site.js's JSON
function readFields(text, fromForm) {
  if (fromForm) return Object.fromEntries(new URLSearchParams(text));
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// One line of text: no control characters (a line break could start a new header), spaces evened out
const oneLine = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
// Lines of text, as written: its line breaks kept, nothing else that isn't text
const lines = (value) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();

// The contact form's message as it's emailed, or why it can't be
function check(data) {
  const name = oneLine(data.name);
  const email = String(data.email ?? "").trim();
  const message = lines(data.message);
  if (!name || name.length > LONGEST.name) return { problem: "Please enter your name." };
  if (email.length > LONGEST.email || !EMAIL.test(email) || CONTROL.test(email)) return { problem: "That email address doesn’t look right." };
  if (!message || message.length > LONGEST.message) return { problem: "Please write a message (5,000 characters at most)." };
  return { name, email, message };
}

function contactEmail({ name, email, message }) {
  return {
    from: FROM,
    replyTo: { email, name },
    subject: `A message from ${name} (oslohaggadone.com)`,
    text: `${message}\n\n— ${name} <${email}>\nSent with the contact form on oslohaggadone.com: reply to this email to answer them.\n`,
  };
}

// Synopsist's feedback as it's emailed (a rating from 1 to 5, words, or both), or why it can't be
function checkFeedback(data) {
  const given = data.rating; // a number, or a form's "4"
  const rating = given == null || given === "" ? null : ["number", "string"].includes(typeof given) ? Number(given) : NaN;
  const message = lines(data.message);
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { problem: "A rating is 1 to 5 stars." };
  if (message.length > LONGEST.feedback) return { problem: "Please keep it to 2,000 characters." };
  if (rating === null && !message) return { problem: "Choose a rating, or write a few words." };
  return { rating, message, language: Object.hasOwn(LANGUAGES, data.language) ? LANGUAGES[data.language] : null };
}

function feedbackEmail({ rating, message, language }) {
  const stars = rating && `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
  return {
    from: { ...FROM, name: "Synopsist" },
    subject: rating ? `Synopsist feedback: ${stars} (${rating}/5)` : "Synopsist feedback",
    text: `${rating ? `How satisfied: ${stars} (${rating} of 5)` : "No rating"}\n\n${message || "(no words)"}\n\n`
      + `— Sent anonymously with Synopsist's feedback page${language ? `, in ${language}` : ""}: there's no one to reply to.\n`,
  };
}

const FORMS = {
  "/": { check, email: contactEmail, sentTo: (success) => PAGE + (success ? "#sent" : "#not-sent") },
  "/feedback": { check: checkFeedback, email: feedbackEmail, sentTo: () => FEEDBACK_PAGE },
};

function answer(body, status, request, env) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(request, env) } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors(request, env), "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return answer({ service: "oslohaggadone.com's contact form, and Synopsist's feedback", messages: "POST /", feedback: "POST /feedback" }, 200, request, env);
    }
    const form = Object.hasOwn(FORMS, url.pathname) ? FORMS[url.pathname] : null;
    if (request.method !== "POST" || !form) return answer({ success: false, message: "Nothing here." }, 404, request, env);

    // a form posted without JavaScript goes back to the page; the page's script gets an answer it can read
    const fromForm = (request.headers.get("Content-Type") ?? "").includes("application/x-www-form-urlencoded");
    const reply = (status, body) => fromForm
      ? new Response(null, { status: 303, headers: { Location: form.sentTo(body.success) } })
      : answer(body, status, request, env);

    if (!allowedOrigins(env).includes(request.headers.get("Origin"))) return reply(403, { success: false, message: "Not from the site." });
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return reply(413, { success: false, message: "That's too long." });
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply(413, { success: false, message: "That's too long." });
    const data = readFields(text, fromForm);
    if (data._honey) return reply(200, { success: true }); // a spam bot filled in the hidden field: it's told it worked
    const checked = form.check(data);
    if (checked.problem) return reply(400, { success: false, message: checked.problem });
    if (!env.CONTACT_TO) return reply(503, { success: false, message: "The form isn't set up yet." });
    if (!withinLimits(url.pathname, request.headers.get("CF-Connecting-IP") ?? "")) {
      return reply(429, { success: false, message: "Too many messages at once. Please try again later." });
    }

    try {
      await env.EMAIL.send({ to: env.CONTACT_TO, ...form.email(checked) });
    } catch {
      return reply(502, { success: false, message: "It couldn't be sent just now." });
    }
    return reply(200, { success: true });
  },
};
