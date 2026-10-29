// The contact form's Worker, run here in Node with a stand-in for Email Routing's sending (env.EMAIL),
// so nothing is really emailed: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const SITE = "https://oslohaggadone.com";
const GOOD = { name: "Ada", email: "ada@example.com", message: "Hello!\nI love the music.", _honey: "" };
let connection = 0; // each test from its own address, so the limits of one don't touch another

function setup({ failing = false, to = "inbox@example.com" } = {}) {
  const sent = [];
  const env = {
    ORIGINS: SITE, CONTACT_TO: to,
    EMAIL: { async send(message) { if (failing) throw Object.assign(new Error("down"), { code: "E_INTERNAL_SERVER_ERROR" }); sent.push(message); return { messageId: "test" }; } },
  };
  const ip = `192.0.2.${++connection}`;
  const post = (fields, { origin = SITE, form = false, from = ip } = {}) => worker.fetch(new Request("https://contact.test/", {
    method: "POST",
    headers: { ...(origin ? { Origin: origin } : {}), "CF-Connecting-IP": from,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "text/plain;charset=UTF-8" },
    body: typeof fields === "string" ? fields : form ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
  }), env);
  return { env, sent, post };
}

test("a message from the site is emailed to the inbox, to reply to its sender", async () => {
  const { sent, post } = setup();
  const response = await post(GOOD);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(sent.length, 1);
  const [email] = sent;
  assert.equal(email.to, "inbox@example.com");
  assert.deepEqual(email.from, { email: "form@oslohaggadone.com", name: "oslohaggadone.com" });
  assert.deepEqual(email.replyTo, { email: "ada@example.com", name: "Ada" });
  assert.equal(email.subject, "A message from Ada (oslohaggadone.com)");
  assert.match(email.text, /^Hello!\nI love the music\.\n\n— Ada <ada@example\.com>\n/);
});

test("without JavaScript, the form is sent back to the page: #sent, or #not-sent", async () => {
  const { sent, post } = setup();
  const sentBack = await post(GOOD, { form: true });
  assert.equal(sentBack.status, 303);
  assert.equal(sentBack.headers.get("Location"), `${SITE}/contact/#sent`);
  assert.equal(sent.length, 1);
  const wrong = await post({ ...GOOD, email: "me@home" }, { form: true });
  assert.equal(wrong.headers.get("Location"), `${SITE}/contact/#not-sent`);
  assert.equal(sent.length, 1);
});

test("other websites' pages, and requests from no page, are turned away", async () => {
  const { sent, post } = setup();
  assert.equal((await post(GOOD, { origin: "https://example.com" })).status, 403);
  assert.equal((await post(GOOD, { origin: null })).status, 403);
  assert.equal((await post(GOOD, { origin: "http://oslohaggadone.com" })).status, 403);
  assert.equal(sent.length, 0);
});

test("each field is checked as the page checks it", async () => {
  const { sent, post } = setup();
  for (const fields of [
    { ...GOOD, name: "  " }, { ...GOOD, email: "me@home" }, { ...GOOD, email: "a b@example.com" },
    { ...GOOD, email: "ada@example.com\r\nBcc: someone@example.com" }, { ...GOOD, message: "" },
    { ...GOOD, name: "x".repeat(101) }, { ...GOOD, message: "x".repeat(5001) }, {}, "not json",
  ]) {
    const response = await post(fields);
    assert.equal(response.status, 400, JSON.stringify(fields).slice(0, 80));
    assert.equal((await response.json()).success, false);
  }
  assert.equal(sent.length, 0);
});

test("a line break in the name can't start a header of its own", async () => {
  const { sent, post } = setup();
  assert.equal((await post({ ...GOOD, name: "Ada\r\nBcc: someone@example.com" })).status, 200);
  assert.equal(sent[0].subject, "A message from Ada Bcc: someone@example.com (oslohaggadone.com)");
  assert.doesNotMatch(sent[0].subject + sent[0].replyTo.name, /[\r\n]/);
});

test("a spam bot that fills in the hidden field is told it worked, and nothing is sent", async () => {
  const { sent, post } = setup();
  const response = await post({ ...GOOD, _honey: "http://spam.example" });
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(sent.length, 0);
});

test("too much at once is turned away: a long post, or many messages from one connection", async () => {
  const { sent, post } = setup();
  assert.equal((await post({ ...GOOD, message: "x".repeat(20_000) })).status, 413);
  for (let i = 0; i < 5; i++) assert.equal((await post(GOOD)).status, 200);
  assert.equal((await post(GOOD)).status, 429); // the sixth in ten minutes
  assert.equal((await post(GOOD, { from: "198.51.100.7" })).status, 200); // someone else still can
  assert.equal(sent.length, 6);
});

test("when it can't be sent, the page is told, so it can offer the email address instead", async () => {
  const { post } = setup({ failing: true });
  const response = await post(GOOD);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).success, false);
  assert.equal((await post(GOOD, { form: true })).headers.get("Location"), `${SITE}/contact/#not-sent`);
  const notSetUp = setup({ to: "" });
  assert.equal((await notSetUp.post(GOOD)).status, 503);
});

test("asking first from the site is answered; from elsewhere it isn't", async () => {
  const { env } = setup();
  const ask = (origin) => worker.fetch(new Request("https://contact.test/", {
    method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } }), env);
  assert.equal((await ask(SITE)).headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal((await ask("https://example.com")).headers.get("Access-Control-Allow-Origin"), null);
});
