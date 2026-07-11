import { describe, it, expect } from 'vitest';
import { renderEvent } from './render.js';

describe('renderEvent', () => {
  it('produces a Discord content string containing the severity token and title', () => {
    const rendered = renderEvent({ severity: 'critical', kind: 'process.crash', title: 'Process crashed' });
    expect(rendered.discordContent).toContain('CRITICAL');
    expect(rendered.discordContent).toContain('Process crashed');
  });

  it('includes serialized detail in both text and discordContent', () => {
    const rendered = renderEvent({
      severity: 'warn',
      kind: 'job.dead_letter',
      title: 'Job failed',
      detail: { jobId: '123', attempts: 5 },
    });
    expect(rendered.text).toContain('jobId: "123"');
    expect(rendered.text).toContain('attempts: 5');
    expect(rendered.discordContent).toContain('jobId: "123"');
    expect(rendered.discordContent).toContain('attempts: 5');
  });

  it('omits the detail block entirely when detail is absent or empty', () => {
    const noDetail = renderEvent({ severity: 'info', kind: 'app.startup', title: 'Started' });
    expect(noDetail.text).toBe('[INFO] app.startup — Started');
    const emptyDetail = renderEvent({ severity: 'info', kind: 'app.startup', title: 'Started', detail: {} });
    expect(emptyDetail.text).toBe('[INFO] app.startup — Started');
  });
});
