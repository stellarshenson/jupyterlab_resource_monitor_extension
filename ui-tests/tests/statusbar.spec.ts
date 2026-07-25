import { expect, test } from '@jupyterlab/galata';

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

  // Default settings: flush text, and the percentage suffix is off - it lives
  // in the tooltip, which is asserted below.
  await expect(memory).toHaveText(/^Mem: [\d.]+ \/ [\d.]+ (TB|GB|MB)$/);
  await expect(cpu).toHaveText(/^CPU: \d+%$/);

  // The tooltip stays complete whatever the display settings hide.
  await expect(memory).toHaveAttribute(
    'title',
    /^Memory: .+ used of .+ (container limit|host RAM) \(\d+%\)/
  );
  await expect(cpu).toHaveAttribute('title', /^CPU: \d+% of [\d.]+ CPUs?$/);
});
