import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverStaffWebhook, shapeStaffWebhookRequest } from "../src/index";

// STAFF_WEBHOOK_URL is the only push channel for fail-closed pauses (notifyStaff). Three
// production pauses sat file-only because it was never set; the operational fix points it at
// the on-call Telegram chat directly, so the delivery layer must speak Telegram's sendMessage
// shape ({chat_id, text}) when — and only when — the URL is a Bot API sendMessage endpoint.

const TG_URL = "https://api.telegram.org/botTOKEN123/sendMessage?chat_id=-100555";

test("generic endpoint gets the documented {scope, message, meta, ts} JSON", () => {
  const { url, body } = shapeStaffWebhookRequest("https://hooks.example/x", "drift", "under-backing", { d: -1 });
  assert.equal(url, "https://hooks.example/x");
  const parsed = JSON.parse(body);
  assert.equal(parsed.scope, "drift");
  assert.equal(parsed.message, "under-backing");
  assert.deepEqual(parsed.meta, { d: -1 });
  assert.equal(typeof parsed.ts, "number");
});

test("telegram sendMessage URL reshapes to {chat_id, text} and strips the query", () => {
  const { url, body } = shapeStaffWebhookRequest(TG_URL, "drift", "under-backing -3912500", { chain: "GRAM" });
  assert.equal(url, "https://api.telegram.org/botTOKEN123/sendMessage");
  const parsed = JSON.parse(body);
  assert.equal(parsed.chat_id, "-100555");
  assert.match(parsed.text, /\[drift\] under-backing -3912500/);
  assert.match(parsed.text, /"chain":"GRAM"/);
  assert.equal(parsed.scope, undefined);
});

test("telegram text is capped under the Bot API 4096-char limit", () => {
  const { body } = shapeStaffWebhookRequest(TG_URL, "drift", "x".repeat(10_000), {});
  assert.ok(JSON.parse(body).text.length <= 4000);
});

test("telegram host WITHOUT chat_id stays generic (nothing to reshape into)", () => {
  const { url, body } = shapeStaffWebhookRequest("https://api.telegram.org/botT/sendMessage", "drift", "m", {});
  assert.equal(url, "https://api.telegram.org/botT/sendMessage");
  assert.equal(JSON.parse(body).scope, "drift");
});

test("deliverStaffWebhook POSTs the reshaped request and returns true on 2xx", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const ok = await deliverStaffWebhook(TG_URL, "drift", "paused", { r: 1 }, {
    retryDelayMs: 0,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.telegram.org/botTOKEN123/sendMessage");
  assert.equal(JSON.parse(calls[0]!.body).chat_id, "-100555");
});

test("deliverStaffWebhook retries non-2xx then succeeds; exhausting retries returns false", async () => {
  let attempts = 0;
  const flaky = (async () => {
    attempts++;
    return new Response("err", { status: attempts < 3 ? 500 : 200 });
  }) as typeof fetch;
  assert.equal(
    await deliverStaffWebhook("https://hooks.example/x", "s", "m", {}, { retries: 3, retryDelayMs: 0, fetchImpl: flaky }),
    true,
  );
  assert.equal(attempts, 3);

  const dead = (async () => new Response("err", { status: 502 })) as typeof fetch;
  assert.equal(
    await deliverStaffWebhook("https://hooks.example/x", "s", "m", {}, { retries: 2, retryDelayMs: 0, fetchImpl: dead }),
    false,
  );
});
