import { describe, it, expect } from 'vitest';
import { renderSwipePage } from '../../../src/services/admin/adapters/fastify/web/pages/swipe.js';
import { renderProfilesPage } from '../../../src/services/admin/adapters/fastify/web/pages/profiles.js';

describe('mobile layout markup', () => {
  it('swipe card keeps all review content in one scroll area with a details link', () => {
    const html = renderSwipePage();
    expect(html).toContain('.swipe-body');
    expect(html).toContain('overflow-y: auto');
    expect(html).toContain('/admin/approvals/');
    expect(html).toContain('full details');
  });

  it('profiles catalogue is collapsible and keeps the editor title element', () => {
    const html = renderProfilesPage();
    expect(html).toContain('<details class="profiles-catalog-details" open>');
    expect(html).toContain('max-height: 30vh');
    expect(html).toContain('id="profile-editor-title"');
  });
});
