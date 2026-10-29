// The portfolio's contact form on Cloudflare Workers: the form at oslohaggadone.com/contact/ posts
// here, and each message is emailed to the inbox business@oslohaggadone.com forwards to (CONTACT_TO, a
// secret, so that address isn't in this public repository), with the sender's address to reply to.
// It's sent through Email Routing, which sends to an inbox verified there for free, on any plan.
//
// site.js sends the fields as JSON (as text/plain, which a page may send to another site without
// asking first) and reads the answer; without JavaScript the form posts itself here and is sent back
// to the contact page, to #sent or #not-sent. Each message is checked the way site.js checks it.
// Nothing is kept: no database and no logs (wrangler.toml); a connection's address is held in memory
// only for its ten minutes, to turn away floods.

const FROM = { email: "form@oslohaggadone.com", name: "oslohaggadone.com" };
const PAGE = "https://oslohaggadone.com/contact/"; // where a form posted without JavaScript goes back to
const MAX_BODY_BYTES = 16 * 1024;
const LONGEST = { name: 100, email: 254, message: 5000 }; // the form's maxlength
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/; // name@domain.tld, as site.js checks it
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOW_MS = 10 * 60_000;
const PER_CONNECTION = 5; // messages from one connection in WINDOW_MS
const IN_ALL = 30; // from everyone, on each of Cloudflare's servers (each counts on its own)

const recent = new Map(); // connection -> the times of its messages, within WINDOW_MS
let everyone = []; // the times of everyone's messages, within WINDOW_MS

function allowedOrigins(env) {
  return (env.ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
}

function cors(request, env) {
  const origin = request.headers.get("Origin");
  return origin && allowedOrigins(env).includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

// Whether there's room for one more message from this connection, counting it if there is
function withinLimits(address, now = Date.now()) {
  everyone = everyone.filter((time) => now - time < WINDOW_MS);
  for (const [key, times] of recent) if (times.every((time) => now - time >= WINDOW_MS)) recent.delete(key);
  const mine = (recent.get(address) ?? []).filter((time) => now - time < WINDOW_MS);
  if (mine.length >= PER_CONNECTION || everyone.length >= IN_ALL) return false;
  mine.push(now);
  everyone.push(now);
  recent.set(address, mine);
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

// The message as it's emailed, or why it can't be
function check(data) {
  const name = oneLine(data.name);
  const email = String(data.email ?? "").trim();
  const message = String(data.message ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!name || name.length > LONGEST.name) return { problem: "Please enter your name." };
  if (email.length > LONGEST.email || !EMAIL.test(email) || CONTROL.test(email)) return { problem: "That email address doesn’t look right." };
  if (!message || message.length > LONGEST.message) return { problem: "Please write a message (5,000 characters at most)." };
  return { name, email, message };
}

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
      return answer({ service: "oslohaggadone.com's contact form", messages: "POST /" }, 200, request, env);
    }
    if (request.method !== "POST" || url.pathname !== "/") return answer({ success: false, message: "Nothing here." }, 404, request, env);

    // a form posted without JavaScript goes back to the page; site.js gets an answer it can read
    const fromForm = (request.headers.get("Content-Type") ?? "").includes("application/x-www-form-urlencoded");
    const reply = (status, body) => fromForm
      ? new Response(null, { status: 303, headers: { Location: PAGE + (body.success ? "#sent" : "#not-sent") } })
      : answer(body, status, request, env);

    if (!allowedOrigins(env).includes(request.headers.get("Origin"))) return reply(403, { success: false, message: "Not from the site." });
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return reply(413, { success: false, message: "That's too long." });
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply(413, { success: false, message: "That's too long." });
    const data = readFields(text, fromForm);
    if (data._honey) return reply(200, { success: true }); // a spam bot filled in the hidden field: it's told it worked
    const checked = check(data);
    if (checked.problem) return reply(400, { success: false, message: checked.problem });
    if (!env.CONTACT_TO) return reply(503, { success: false, message: "The form isn't set up yet." });
    if (!withinLimits(request.headers.get("CF-Connecting-IP") ?? "")) {
      return reply(429, { success: false, message: "Too many messages at once. Please try again later." });
    }

    const { name, email, message } = checked;
    try {
      await env.EMAIL.send({
        to: env.CONTACT_TO,
        from: FROM,
        replyTo: { email, name },
        subject: `A message from ${name} (oslohaggadone.com)`,
        text: `${message}\n\n— ${name} <${email}>\nSent with the contact form on oslohaggadone.com: reply to this email to answer them.\n`,
      });
    } catch {
      return reply(502, { success: false, message: "It couldn't be sent just now." });
    }
    return reply(200, { success: true });
  },
};
