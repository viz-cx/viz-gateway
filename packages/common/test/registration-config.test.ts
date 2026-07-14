import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";

test("registration defaults", () => {
  delete process.env.REGISTRATION_LEASE_MS;
  delete process.env.REGISTRATION_HEARTBEAT_MS;
  delete process.env.REGISTRATION_NONCE_TTL_MS;
  delete process.env.SIGNER_ADVERTISE_URL;
  const cfg = loadConfig();
  assert.equal(cfg.registration.leaseMs, 60000);
  assert.equal(cfg.registration.heartbeatMs, 20000);
  assert.equal(cfg.registration.nonceTtlMs, 30000);
  assert.equal(cfg.signerAdvertiseUrl, "");
});

test("registration + advertise url from env", () => {
  process.env.REGISTRATION_LEASE_MS = "90000";
  process.env.SIGNER_ADVERTISE_URL = "http://op-2-host:8090";
  const cfg = loadConfig();
  assert.equal(cfg.registration.leaseMs, 90000);
  assert.equal(cfg.signerAdvertiseUrl, "http://op-2-host:8090");
  delete process.env.REGISTRATION_LEASE_MS;
  delete process.env.SIGNER_ADVERTISE_URL;
});
