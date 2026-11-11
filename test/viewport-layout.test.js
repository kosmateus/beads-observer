import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard viewport is shared by all views but excludes full-page details', async () => {
  const css = await readFile(
    new URL('../web/style.css', import.meta.url),
    'utf8',
  );
  assert.match(
    css,
    /#observer-app:has\(> main:not\(\.show-epic\):not\(\.show-issue\):not\(\.show-agent\)\) \{[^}]*height: 100dvh;[^}]*overflow: hidden;/,
  );
  assert.match(
    css,
    /#content > \.graph-scroll,\s*#content > \.view-scroll \{[^}]*min-height: 0;[^}]*overflow: auto;/,
  );
});

test('board, list and activity use content-only scrolling and retain scroll position', async () => {
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /options\s*\+\s*'<div class="view-scroll">'/);
  assert.match(app, /<div class="view-scroll">\$\{renderActivity\(rows\)\}/);
  assert.match(app, /<div class="view-scroll">\$\{renderBoard\(rows\)\}/);
  assert.match(app, /after\.scrollTop = pos\[1\]/);
  assert.match(app, /node\.scrollLeft = innerScroll\[index\]/);
});
