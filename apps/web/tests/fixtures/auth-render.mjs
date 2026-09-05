import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import React from 'react';
import { renderToPipeableStream } from 'next/dist/compiled/react-server-dom-webpack/server.node.js';

// Substitute only the auth module's external boundaries, using the real React
// Server Component renderer/cache so request isolation is exercised, not mocked.
const state = globalThis.authRenderTest = {
  session: { userId: 'owner', email: 'owner@example.com' },
  user: { id: 'owner', email: 'owner@example.com', role: 'user', onboardingCompletedAt: 'today' },
  sessions: 0, lookups: 0, promotions: 0,
};
const contexts = globalThis.authRenderContexts = new AsyncLocalStorage();
const boundary = `data:text/javascript,${encodeURIComponent(`
const s = globalThis.authRenderTest;
export async function getSessionUserFromCookies() { s.sessions++; return (globalThis.authRenderContexts.getStore() ?? s).session; }
export async function getUserById() { s.lookups++; if (s.failLookup) throw new Error('lookup failed'); return (globalThis.authRenderContexts.getStore() ?? s).user; }
export async function reconcileConfiguredOwner() { s.promotions++; return {...s.user, role: 'owner'}; }
export function canAccessAdmin(role) { return role === 'admin' || role === 'owner'; }
export function isOwnerRole(role) { return role === 'owner'; }
export function getServerEnv() { return { adminOwnerEmails: ['owner@example.com'] }; }
export function redirect(url) { throw new Error('redirect:' + url); }
export function notFound() { throw new Error('notFound'); }
`)}`;
const source = await readFile(new URL('../../lib/auth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/from "([^"]+)"/g, (_, name) =>
  `from ${JSON.stringify(name === 'react' ? import.meta.resolve('react') : boundary)}`);
const auth = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
async function render() {
  const outcomes = [];
  async function Consumer() {
    try { outcomes.push((await auth.requireAdminUser()).role); }
    catch (error) { outcomes.push(error.message); }
    return null;
  }
  const stream = new PassThrough();
  const done = new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  stream.resume();
  renderToPipeableStream(React.createElement(React.Fragment, null,
    React.createElement(Consumer), React.createElement(Consumer)), {}).pipe(stream);
  await done;
  return outcomes;
}
assert.deepEqual(await render(), ['owner', 'owner']);
assert.deepEqual([state.sessions, state.lookups, state.promotions], [1, 1, 1]);
// The next request must see role revocation and cannot reuse the promoted owner.
state.user = { ...state.user, email: 'ordinary@example.com', role: 'user' };
assert.deepEqual(await render(), ['notFound', 'notFound']);
assert.deepEqual([state.sessions, state.lookups, state.promotions], [2, 2, 1]);
state.session = null;
assert.deepEqual(await render(), ['redirect:/api/auth/logout?expired=1', 'redirect:/api/auth/logout?expired=1']);
assert.equal(state.sessions, 3);
assert.equal(state.lookups, 2);
// Route handlers / ordinary calls have no render cache and stay fresh.
await auth.getCurrentAppUser();
await auth.getCurrentAppUser();
assert.equal(state.sessions, 5);
const simultaneous = await Promise.all([
  contexts.run({session: {userId: 'admin'}, user: {id: 'admin', email: 'admin@example.com', role: 'admin'}}, render),
  contexts.run({session: null}, render),
]);
assert.deepEqual(simultaneous, [['admin', 'admin'], ['redirect:/api/auth/logout?expired=1', 'redirect:/api/auth/logout?expired=1']]);
state.session = {userId: 'deleted'};
state.user = null;
assert.deepEqual(await render(), ['redirect:/api/auth/logout?expired=1', 'redirect:/api/auth/logout?expired=1']);
state.failLookup = true;
assert.deepEqual(await render(), ['lookup failed', 'lookup failed']);
state.failLookup = false;
state.user = {id: 'admin', email: 'admin@example.com', role: 'admin'};
assert.deepEqual(await render(), ['admin', 'admin']);
console.log('Real RSC renders: one lookup/promotion per render; next-request revocation/logout fresh; uncached outside render.');
