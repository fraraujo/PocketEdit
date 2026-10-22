import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor, document } = loadApp();

test('withUISuppression sets the flag and restores the previous value', () => {
  const ed = makeEditor();
  ed.isApplyingState = false; // set by the constructor in the browser
  let seen = null;
  ed.withUISuppression(() => { seen = ed.isApplyingState; });
  assert.equal(seen, true, 'flag set while applying');
  assert.equal(ed.isApplyingState, false, 'flag restored');

  ed.isApplyingState = true;
  ed.withUISuppression(() => {});
  assert.equal(ed.isApplyingState, true, 'nested suppression keeps the outer value');
});

test('showToast delegates to the page-level toast helper', () => {
  const ed = makeEditor();
  const container = document.getElementById('toast-container');
  container.innerHTML = '';
  ed.showToast('hello <b>world</b>', 'error');
  assert.equal(container.children.length, 1, 'one toast appended');
  const toast = container.children[0];
  assert.equal(toast.className, 'toast error');
  assert.equal(toast.textContent, 'hello <b>world</b>', 'rendered as text, not markup');
  assert.equal(toast.getAttribute('role'), 'alert');
});
