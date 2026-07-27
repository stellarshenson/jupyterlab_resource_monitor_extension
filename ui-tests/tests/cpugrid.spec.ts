import { expect, galata, test } from '@jupyterlab/galata';

/**
 * The grid is almost entirely geometry and CSS, and jsdom does no layout - so
 * jest can prove the cell values are right but cannot see whether the square is
 * a square, whether the cells are visible, or what colour they resolve to.
 * Deleting the `.jp-ResourceMonitor-grid` block from `style/base.css` leaves
 * every other tier green while the mode renders as nothing.
 *
 * This is also the live reintroduction path for DEF-8 (CPU borrowing the memory
 * item's alarm vocabulary) and DEF-17 (a colour that fails contrast), both of
 * which were found by hand and neither of which had a test.
 */
test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    'jupyterlab_resource_monitor_extension:plugin': { cpuMode: 'grid' }
  }
});

/**
 * Serve a fixed snapshot rather than the runner's real CPU count, so the
 * assertions describe the mode and not whatever hardware CI happens to give us.
 * `ts` is stamped per request because an unchanging timestamp is exactly what
 * the staleness guard hides the item for.
 */
const mockMetrics = (page: import('@playwright/test').Page, cpu: object) =>
  page.route('**/jupyterlab-resource-monitor-extension/metrics*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mem: {
          used_bytes: 4 * 1024 ** 3,
          total_bytes: 16 * 1024 ** 3,
          limit_source: 'host'
        },
        cpu,
        ts: Date.now() / 1000
      })
    })
  );

/**
 * Squeeze the CPU item below its content width and measure one of its children.
 *
 * Fixed-size children are flex items, and at the default `flex-shrink: 1` they
 * absorb the pressure - `min-width: auto` resolves through the grid's `1fr`
 * tracks to zero, so nothing stops the collapse. This is the reproduction the
 * dev box could not otherwise produce: its status bar is never full enough.
 */
const squeezeAndMeasure = (
  page: import('@playwright/test').Page,
  selector: string
): Promise<{ w: number; h: number }> =>
  page.evaluate(sel => {
    const item = document.querySelector(
      '.jp-ResourceMonitor-cpu'
    ) as HTMLElement;
    const previous = item.style.cssText;
    item.style.width = '24px';
    item.style.minWidth = '0';
    item.style.maxWidth = '24px';
    const r = document.querySelector(sel)!.getBoundingClientRect();
    const box = { w: r.width, h: r.height };
    item.style.cssText = previous;
    return box;
  }, selector);

test('grid mode renders a square of square cells', async ({ page }) => {
  // 16 assigned cores is a 4x4, the densest grid the mode ever draws and the
  // only size where cells reach the 2px floor.
  await mockMetrics(page, {
    percent: 25,
    cpu_count: 16,
    // cores 0-3 saturated, the rest idle - one core per cell, so exactly
    // four cells burn
    per_core: Array.from({ length: 16 }, (_unused, i) => (i < 4 ? 100 : 0))
  });

  const grid = page.locator('.jp-ResourceMonitor-grid');
  await expect(grid).toBeVisible({ timeout: 30000 });

  // The route is registered after the page has loaded, so the first render can
  // still carry the runner's own CPU count. Wait for the mocked snapshot to
  // reach the DOM before measuring anything, or the assertions below describe
  // whatever hardware the test happens to run on.
  const cells = page.locator('.jp-ResourceMonitor-gridCell');
  await expect(cells).toHaveCount(16, { timeout: 30000 });
  await expect(page.locator('.jp-ResourceMonitor-gridCellHot')).toHaveCount(4, {
    timeout: 30000
  });

  // Square, in both senses: the box is as tall as it is wide, and it is the
  // 14px the cell arithmetic depends on.
  const box = await grid.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toEqual(box!.height);
  expect(box!.width).toBeCloseTo(14, 0);

  // Each cell square and above the sub-pixel floor. Dropping the inline column
  // count lays them out as one row; dropping `grid-auto-rows: 1fr` makes them
  // non-square. Both are invisible to jsdom.
  const cell = await cells.first().boundingBox();
  expect(cell!.width).toEqual(cell!.height);
  expect(cell!.width).toBeGreaterThanOrEqual(3);

  // The cells tile the square edge to edge, so every core busy lights it as one
  // solid block rather than a lattice. Nothing above can see a seam: reinstating
  // a 1px gap keeps the box 14px and the cells square, only smaller.
  const seams = await page.evaluate(() => {
    const r = Array.from(
      document.querySelectorAll('.jp-ResourceMonitor-gridCell')
    ).map(c => c.getBoundingClientRect());
    // cell 1 sits beside cell 0, cell 4 directly below it in a 4x4
    return { across: r[1].left - r[0].right, down: r[4].top - r[0].bottom };
  });
  expect(seams.across).toBeCloseTo(0, 1);
  expect(seams.down).toBeCloseTo(0, 1);

  const rendered = await page.evaluate(() => {
    const item = document.querySelector('.jp-ResourceMonitor-cpu')!;
    const all = Array.from(
      document.querySelectorAll('.jp-ResourceMonitor-gridCell')
    );
    const hot = all.filter(c =>
      c.classList.contains('jp-ResourceMonitor-gridCellHot')
    );
    const cool = all.filter(
      c => !c.classList.contains('jp-ResourceMonitor-gridCellHot')
    );
    return {
      itemColour: getComputedStyle(item).color,
      coolColour: getComputedStyle(cool[0]).backgroundColor,
      hotColour: getComputedStyle(hot[0]).backgroundColor,
      hotCount: hot.length,
      label: item.getAttribute('aria-label'),
      warnClass:
        item.classList.contains('jp-ResourceMonitor-warn') ||
        item.classList.contains('jp-ResourceMonitor-danger')
    };
  });

  // The cells are the load on cores this server shares, not its own usage per
  // core - only the tooltip can say so, and only this tier proves the render
  // path actually asks for that wording when a grid is what got drawn.
  expect(rendered.label).toEqual(
    'CPU: 25% of 16 CPUs; grid shows load on each core assigned to this server'
  );

  // Cells take the item's own foreground, so the grid reads as typography
  // rather than as a coloured indicator.
  expect(rendered.coolColour).toEqual(rendered.itemColour);
  // The burn is a real rendered difference, not just a class that toggles.
  expect(rendered.hotColour).not.toEqual(rendered.coolColour);
  // Four saturated cores, one core per cell.
  expect(rendered.hotCount).toEqual(4);
  // DEF-8: sustained 100% CPU is normal during compute, so the CPU item never
  // wears the memory item's warn/danger vocabulary.
  expect(rendered.warnClass).toBe(false);
});

test('grid mode falls back to the bar when there are no cores to draw', async ({
  page
}) => {
  // `per_core: null` is what the sampler sends under a quota narrower than the
  // cores it runs on - a slice of time, which no arrangement of cells can
  // represent. Nothing at any tier guarded this branch: jest has no spec
  // matching index.ts, and both surviving mutations here (rendering plain text
  // instead of the bar, and dropping the fallback wording from the tooltip)
  // left jest 103/103 and the other Galata cases green.
  await mockMetrics(page, { percent: 40, cpu_count: 2, per_core: null });

  const bar = page.locator('.jp-ResourceMonitor-bar');
  await expect(bar).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.jp-ResourceMonitor-grid')).toHaveCount(0);

  // The tooltip has to say why a bar turned up in grid mode, and it must not
  // name a quota - the readings equally go missing on an unreadable /proc/stat.
  await expect(page.locator('.jp-ResourceMonitor-cpu')).toHaveAttribute(
    'aria-label',
    'CPU: 40% of 2 CPUs; no per-core readings here, so the bar shows the share of the CPU allowance in use'
  );

  // The bar carries the same flex exposure as the grid and needs its own
  // measurement: the grid's squeeze case runs in grid mode, where no bar node
  // exists, so it cannot reach this declaration. Without it the bar renders
  // 2px wide under the same pressure - and `bar` is a mode users pick outright,
  // not only the grid's fallback.
  const barBox = await squeezeAndMeasure(page, '.jp-ResourceMonitor-bar');
  expect(barBox.w).toBeCloseTo(6, 0);
  expect(barBox.h).toBeCloseTo(9, 0);
});

test('the grid keeps its shape when the status bar runs out of room', async ({
  page
}) => {
  // The user-reported rectangle. The grid is a flex item, and at the default
  // flex-shrink: 1 a crowded status bar compresses it horizontally while
  // height: 14px holds - min-width: auto resolves through the 1fr tracks to
  // zero, so nothing stops it collapsing. Squeezing the item below its content
  // width reproduces that pressure deterministically.
  await mockMetrics(page, {
    percent: 25,
    cpu_count: 16,
    per_core: Array.from({ length: 16 }, () => 0)
  });

  await expect(page.locator('.jp-ResourceMonitor-gridCell')).toHaveCount(16, {
    timeout: 30000
  });

  const squeezed = await squeezeAndMeasure(page, '.jp-ResourceMonitor-grid');

  expect(squeezed.w).toEqual(squeezed.h);
  expect(squeezed.w).toBeCloseTo(14, 0);
});
