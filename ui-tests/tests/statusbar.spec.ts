import { expect, test } from '@jupyterlab/galata';

/**
 * Verifies the packaging is right and the two status bar items reach the DOM
 * with live values. The items are constructed hidden and revealed only after
 * the first successful metrics poll resolves, so this fails if the server
 * extension, the endpoint, or the frontend wiring is broken - not just the JS.
 */
test('memory and CPU status items render live values', async ({ page }) => {
  const memory = page.locator('.jp-ResourceMonitor-memory');
  const cpu = page.locator('.jp-ResourceMonitor-cpu');

  // First sample plus first poll; allow generous slack for a cold server.
  await expect(memory).toBeVisible({ timeout: 30000 });
  await expect(cpu).toBeVisible({ timeout: 30000 });

  await expect(memory).toHaveText(/^Mem:.*\d.*\/.*(TB|GB|MB).*\d+%\)$/);
  await expect(cpu).toHaveText(/^CPU:\s*\d+%$/);
});

const GB = 1024 ** 3;

/**
 * The neighbour-nudge defect came back through four successive fixes (DEF-9,
 * 16, 21, 24, 25), so it gets a browser-level guard. The jest tests only pin
 * the column counts format.ts reserves; deleting `display: inline-block` from
 * `.jp-ResourceMonitor-column` or the inline width in index.ts would leave
 * every one of them green while the jitter returned. This drives the real
 * endpoint through both extremes and measures rendered pixels.
 */
test('status item widths hold across the value range', async ({ page }) => {
  let used = 3.4 * GB;
  let cpuPercent = 0;
  let tick = 0;

  // A fresh ts per response keeps the frontend's stale guard satisfied.
  await page.route('**/jupyterlab-resource-monitor-extension/metrics*', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        mem: {
          used_bytes: used,
          total_bytes: 512 * GB,
          limit_source: 'cgroup'
        },
        cpu: { percent: cpuPercent, cpu_count: 8 },
        ts: ++tick
      })
    })
  );

  const memory = page.locator('.jp-ResourceMonitor-memory');
  const cpu = page.locator('.jp-ResourceMonitor-cpu');

  await expect(memory).toHaveText('Mem: 3.4 / 512.0 GB (1%)', {
    timeout: 30000
  });
  await expect(cpu).toHaveText('CPU: 0%');
  const narrow = {
    memory: (await memory.boundingBox())!.width,
    cpu: (await cpu.boundingBox())!.width
  };

  used = 511.9 * GB;
  cpuPercent = 100;

  await expect(memory).toHaveText('Mem: 511.9 / 512.0 GB (100%)', {
    timeout: 30000
  });
  await expect(cpu).toHaveText('CPU: 100%');
  const wide = {
    memory: (await memory.boundingBox())!.width,
    cpu: (await cpu.boundingBox())!.width
  };

  expect(wide.memory).toEqual(narrow.memory);
  expect(wide.cpu).toEqual(narrow.cpu);

  // The reservation is in `ch`, which only holds the value if a digit's advance
  // really is 1ch - measure the widest reading against its box rather than
  // assume it.
  const overflow = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.jp-ResourceMonitor-column')).map(
      element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return (
          range.getBoundingClientRect().width -
          element.getBoundingClientRect().width
        );
      }
    )
  );
  expect(Math.max(...overflow)).toBeLessThanOrEqual(0);
});
