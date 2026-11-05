// Synopsist's feedback (POST /feedback), run here in Node with a stand-in for Email Routing's sending
// (env.EMAIL), so nothing is really emailed: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const SITE = "https://oslohaggadone.com";
const GOOD = { rating: 4, message: "Love the full-screen view.\n素晴らしい！", language: "ja", _honey: "" };
let connection = 0; // each test from its own address, so the limits of one don't touch another

function setup({ failing = false } = {}) {
  const sent = [];
  const env = {
    ORIGINS: SITE, CONTACT_TO: "inbox@example.com",
    EMAIL: { async send(message) { if (failing) throw new Error("down"); sent.push(message); return { messageId: "test" }; } },
  };
  const ip = `203.0.113.${++connection}`;
  const post = (fields, { path = "/feedback", origin = SITE, from = ip } = {}) => worker.fetch(new Request(`https://contact.test${path}`, {
    method: "POST",
    headers: { ...(origin ? { Origin: origin } : {}), "CF-Connecting-IP": from, "Content-Type": "text/plain;charset=UTF-8" },
    body: typeof fields === "string" ? fields : JSON.stringify(fields),
  }), env);
  return { sent, post };
}

test("feedback is emailed to the inbox anonymously: the stars and the words, with no one to reply to", async () => {
  const { sent, post } = setup();
  const response = await post(GOOD);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(sent.length, 1);
  const [email] = sent;
  assert.equal(email.to, "inbox@example.com");
  assert.deepEqual(email.from, { email: "form@oslohaggadone.com", name: "Synopsist" });
  assert.equal(email.replyTo, undefined);
  assert.equal(email.subject, "Synopsist feedback: ★★★★☆ (4/5)");
  assert.match(email.text, /^How satisfied: ★★★★☆ \(4 of 5\)\n\nLove the full-screen view\.\n素晴らしい！\n\n— Sent anonymously/);
  assert.match(email.text, /, in Japanese: there's no one to reply to\.\n$/);
  assert.doesNotMatch(email.text, /203\.0\.113/); // nothing about the connection
});

test("a rating alone is enough, and so are words alone; neither is turned away", async () => {
  const { sent, post } = setup();
  assert.equal((await post({ rating: 5 })).status, 200);
  assert.equal(sent[0].subject, "Synopsist feedback: ★★★★★ (5/5)");
  assert.match(sent[0].text, /\n\n\(no words\)\n/);
  assert.equal((await post({ message: "More songs please", rating: null })).status, 200);
  assert.equal(sent[1].subject, "Synopsist feedback");
  assert.match(sent[1].text, /^No rating\n\nMore songs please\n/);
  assert.doesNotMatch(sent[1].text, /, in /); // no language given
  assert.equal((await post({ rating: 3, language: "toString" })).status, 200);
  assert.doesNotMatch(sent[2].text, /, in /); // nor one it doesn't know
  for (const fields of [{}, { rating: null, message: "   " }, "not json"]) {
    const response = await post(fields);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal((await response.json()).success, false);
  }
  assert.equal(sent.length, 3);
});

test("a rating is a whole number of stars from 1 to 5, and the words have a limit", async () => {
  const { sent, post } = setup();
  for (const rating of [0, 6, 2.5, "five", -1, true]) {
    assert.equal((await post({ ...GOOD, rating })).status, 400, String(rating));
  }
  assert.equal((await post({ ...GOOD, message: "x".repeat(2001) })).status, 400);
  assert.equal((await post({ ...GOOD, message: "x".repeat(2000) })).status, 200);
  assert.equal((await post({ ...GOOD, rating: "3" })).status, 200); // as a form would send it
  assert.equal(sent.length, 2);
});

test("only the site's pages may send it, and a spam bot is told it worked", async () => {
  const { sent, post } = setup();
  assert.equal((await post(GOOD, { origin: "https://example.com" })).status, 403);
  assert.equal((await post(GOOD, { origin: null })).status, 403);
  assert.deepEqual(await (await post({ ...GOOD, _honey: "http://spam.example" })).json(), { success: true });
  assert.equal(sent.length, 0);
});

test("feedback has limits of its own: the sixth in ten minutes is turned away, and the contact form still works", async () => {
  const { sent, post } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await post(GOOD)).status, 200);
  assert.equal((await post(GOOD)).status, 429);
  const contact = { name: "Ada", email: "ada@example.com", message: "Hello!" };
  assert.equal((await post(contact, { path: "/" })).status, 200);
  assert.equal(sent.length, 6);
});

test("when it can't be sent, the page is told", async () => {
  const { post } = setup({ failing: true });
  const response = await post(GOOD);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).success, false);
});

test("other addresses aren't forms", async () => {
  const { sent, post } = setup();
  for (const path of ["/feedback/", "/toString", "/__proto__", "/other"]) assert.equal((await post(GOOD, { path })).status, 404, path);
  assert.equal(sent.length, 0);
});
