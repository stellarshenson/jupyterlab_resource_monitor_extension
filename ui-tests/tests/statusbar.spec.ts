import { expect, galata, test } from '@jupyterlab/galata';

/**
 * Verifies the packaging is right and the two status bar items carry live
 * values. `toBeVisible` only waits for an item to reach the DOM - visibility is
 * granted by the status bar itself; the text assertions are what prove the
 * server extension, the endpoint and the frontend wiring are all working.
 */
test('memory and CPU status items render live values', async ({ page }) => {
  const memory = page.locator('.jp-ResourceMonitor-memory');
  const cpu = page.locator('.jp-ResourceMonitor-cpu');

  // First sample plus first poll; allow generous slack for a cold server.
  await expect(memory).toBeVisible({ timeout: 30000 });
  await expect(cpu).toBeVisible({ timeout: 30000 });

  // Default settings: plain text in reserved-width boxes, and the percentage
  // suffix is off - it lives in the tooltip, which is asserted below.
  await expect(memory).toHaveText(/^Mem: [\d.]+ \/ [\d.]+ (TB|GB|MB)$/);
  await expect(cpu).toHaveText(/^CPU: \d+%$/);

  // The tooltip stays complete whatever the display settings hide.
  await expect(memory).toHaveAttribute(
    'title',
    /^Memory: .+ used of .+ (container limit|host RAM) \(\d+%\)/
  );
  await expect(cpu).toHaveAttribute('title', /^CPU: \d+% of [\d.]+ CPUs?$/);
});

test.describe('stable status item width', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      '@stellarshenson/jupyterlab-resource-monitor-extension:plugin': {
        cpuMode: 'aggregate'
      }
    }
  });

  test('the item widths do not change as the readings change', async ({
    page
  }) => {
    const memory = page.locator('.jp-ResourceMonitor-memory');
    const cpu = page.locator('.jp-ResourceMonitor-cpu');

    // Two low reads before the high one, so the first wait cannot race past
    // the snapshot it is looking for. `ts` is stamped per request because an
    // unchanged timestamp is exactly what the staleness guard hides the items
    // for.
    let requests = 0;
    await page.route(
      '**/jupyterlab-resource-monitor-extension/metrics*',
      route => {
        requests += 1;
        const low = requests <= 2;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            mem: {
              used_bytes: (low ? 3.4 : 34.9) * 1024 ** 3,
              total_bytes: 503.2 * 1024 ** 3,
              limit_source: 'host'
            },
            cpu: {
              percent: low ? 5 : 90,
              cpu_count: 64,
              per_core: null
            },
            ts: Date.now() / 1000
          })
        });
      }
    );

    await expect(memory).toBeVisible({ timeout: 30000 });
    // 5% of 64 cores in aggregate mode is 320%
    await expect(cpu).toContainText('320%', { timeout: 30000 });
    const memoryLow = (await memory.boundingBox())!;
    const cpuLow = (await cpu.boundingBox())!;

    // 90% of 64 cores is 5760% - both readings one digit wider than the first
    await expect(cpu).toContainText('5760%', { timeout: 30000 });
    const memoryHigh = (await memory.boundingBox())!;
    const cpuHigh = (await cpu.boundingBox())!;

    // The two item widths are the user-visible promise: a reading that gains a
    // digit must not move the audio controls beside them.
    expect(memoryHigh.width).toBeCloseTo(memoryLow.width, 1);
    expect(cpuHigh.width).toBeCloseTo(cpuLow.width, 1);
  });
});
