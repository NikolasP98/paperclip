import { describe, expect, it } from 'vitest';
import { createProjectSchema, updateProjectSchema } from './project.js';

describe('project metadata contracts', () => {
  it('accepts stable portfolio grouping and routing metadata', () => {
    const parsed = createProjectSchema.parse({
      name: 'Workforce/Projects',
      metadata: {
        minionSeedKey: 'minion-code:project:workforce-projects',
        repositoryKey: 'minion-hub',
        groupKey: 'minion_hub',
        routing: {
          scopes: ['workforce', 'core'],
          pathPrefixes: ['src/lib/workforce'],
          isRepositoryDefault: false,
          intakeFallback: false,
        },
        operatorNote: 'Preserved extension field',
      },
    });

    expect(parsed.metadata).toMatchObject({
      repositoryKey: 'minion-hub',
      groupKey: 'minion_hub',
      operatorNote: 'Preserved extension field',
    });
  });

  it('rejects malformed stable routing fields while allowing null metadata', () => {
    expect(() => updateProjectSchema.parse({ metadata: { routing: { scopes: [''] } } })).toThrow();
    expect(updateProjectSchema.parse({ metadata: null }).metadata).toBeNull();
  });
});
