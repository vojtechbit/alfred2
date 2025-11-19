import test from 'node:test';
import assert from 'node:assert/strict';

// Provide dummy OAuth credentials so the Gmail client factory doesn't exit during tests
process.env.GOOGLE_CLIENT_ID ||= 'dummy-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'dummy-client-secret';
process.env.REDIRECT_URI ||= 'https://dummy.example/oauth';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { resolveLabelIdentifiers } = await import('../src/services/microsoftGraphService.js');

const baseLabels = [
  { id: 'Label_1', name: 'Účto škola', type: 'user', color: null },
  { id: 'Label_2', name: 'Rodina', type: 'user', color: null },
  { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', type: 'system', color: null }
];

test('resolveLabelIdentifiers matches labels with swapped words and diacritics', async () => {
  const result = await resolveLabelIdentifiers('test-user', ['skola ucto'], { labels: baseLabels });
  assert.equal(result.resolved.length, 1, 'expected one resolved match');
  assert.equal(result.resolved[0].label.id, 'Label_1');
  assert(result.resolved[0].confidence >= 0.86, 'confidence should indicate high certainty');
  assert.equal(result.requiresConfirmation, false);
});

test('resolveLabelIdentifiers recognises Gmail category aliases like Primary', async () => {
  const result = await resolveLabelIdentifiers('test-user', ['Primary'], { labels: baseLabels });
  assert.equal(result.resolved.length, 1, 'should resolve Primary alias');
  assert.equal(result.resolved[0].label.id, 'CATEGORY_PERSONAL');
});

test('resolveLabelIdentifiers flags ambiguous matches when multiple labels fit', async () => {
  const labels = baseLabels.concat([
    { id: 'Label_3', name: 'Finance School', type: 'user', color: null },
    { id: 'Label_4', name: 'School Finance', type: 'user', color: null }
  ]);

  const result = await resolveLabelIdentifiers('test-user', ['finance school'], { labels });
  assert.equal(result.resolved.length, 0, 'ambiguous inputs should not auto-resolve');
  assert.equal(result.ambiguous.length, 1, 'ambiguous array should contain entry for input');
  assert(result.ambiguous[0].options.length >= 2, 'ambiguous options should list competing labels');
  assert.equal(result.requiresConfirmation, true, 'ambiguous results require confirmation');
});
