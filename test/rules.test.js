import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, verdictFor } from "../public/rules.js";

const ids = (t) => analyze(t).flags.map((f) => f.id);

test("fake delivery smish scores as a scam", () => {
  const r = analyze("USPS: Your package could not be delivered. Pay the $1.99 redelivery fee within 24 hours: https://usps-redelivery-help.top/track");
  assert.equal(verdictFor(r.score), "scam");
  assert.ok(ids("USPS: package on hold https://usps-help.top/x").includes("lookalike"));
});

test("spoofed sender and credential grab", () => {
  const f = ids("From: PayPal <service@paypa1-secure.com>\nVerify your account immediately: http://paypa1-secure.com/login");
  for (const id of ["sender_spoof", "credentials", "lookalike", "urgency"]) assert.ok(f.includes(id), id);
});

test("brand writing from free mail is flagged", () => {
  assert.ok(ids("From: Netflix Billing <netflix.billing@gmail.com>\nYour payment failed.").includes("sender_spoof"));
});

test("shortener, IP links and punycode", () => {
  assert.ok(ids("Claim here bit.ly/abc").includes("shortener"));
  assert.ok(ids("Login at http://192.168.4.20/bank").includes("ip_link"));
  assert.ok(ids("Visit https://xn--pypal-4ve.com").includes("punycode"));
});

test("official links and normal messages stay clean", () => {
  assert.equal(analyze("Your Amazon order shipped. Track: https://www.amazon.com/gp/your-account/orders").score, 0);
  assert.equal(analyze("Are we still on for dinner at 7?").score, 0);
  assert.equal(verdictFor(analyze("Hi Sam, confirming your dental cleaning Thursday at 2:30pm.").score), "probably_legit");
});

test("highlight spans point at the matched text", () => {
  const text = "Pay with gift cards now";
  const f = analyze(text).flags.find((x) => x.id === "weird_payment");
  assert.equal(text.slice(f.spans[0].start, f.spans[0].end).toLowerCase(), "gift cards");
});

test("email anchors: link text that lies about its destination", () => {
  const r = analyze("From: PayPal <service@paypal-review.com>\nLog in now", {
    anchors: [{ text: "www.paypal.com/signin", href: "https://paypa1-resolution.xyz/signin" }],
  });
  assert.ok(r.flags.some((f) => f.id === "link_text_lies"));
  assert.equal(verdictFor(r.score), "scam");
});

test("email anchors: official sender with tracking links stays clean", () => {
  const r = analyze("From: Netflix <info@mailer.netflix.com>\nYour new bill is ready.", {
    anchors: [{ text: "View bill", href: "https://click.sendgrid.net/ls/click?u=1" }],
  });
  assert.equal(r.score, 0);
});

test("inbox rows (sender + subject + preview) separate risky from normal mail", () => {
  const row = (name, email, subject, snippet) => `From: ${name} <${email}>\nSubject: ${subject}\n\n${snippet}`;
  const risky = [
    row("PayPal Service", "service@paypal-account-review.com", "Your account has been limited", "Verify your account within 24 hours to avoid suspension."),
    row("USPS", "usps.tracking.center@gmail.com", "Package delivery failed", "Pay the $1.99 redelivery fee today."),
    row("Prize Center", "winner@lucky-draw.top", "Congratulations! You've won", "Claim your prize: a $1000 gift card is waiting."),
  ];
  const normal = [
    row("Netflix", "info@mailer.netflix.com", "Your November bill", "Your payment of $15.49 was successful."),
    row("Mom", "mom.jones@gmail.com", "Dinner Sunday?", "Are you coming over? Dad is making lasagna."),
    row("GitHub", "noreply@github.com", "[GitHub] A new SSH key was added to your account", "If you believe this key was added in error, review your keys."),
  ];
  for (const t of risky) assert.notEqual(verdictFor(analyze(t).score), "probably_legit", t);
  for (const t of normal) assert.equal(verdictFor(analyze(t).score), "probably_legit", t);
});
