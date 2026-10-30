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
    '@stellarshenson/jupyterlab-resource-monitor-extension:plugin': {
      cpuMode: 'grid'
    }
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
        // deliberately in the danger band: the CPU item must not wear the
        // memory item's vocabulary, and that only means anything while the
        // memory item is actually wearing it. Against a calm 25% snapshot the
        // assertion holds even if the CPU item is handed the memory level.
        mem: {
          used_bytes: 15.5 * 1024 ** 3,
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
  // 64 cores rather than 16, though both draw the same 4x4: the cell count is
  // then `GRID_MAX`-dependent, so raising the cap - which puts cells under the
  // 3px floor the box arithmetic is built on - fails this test outright. At 16
  // cores `gridSize` returns 4 whatever the cap is, and the whole geometry
  // suite would stay green through it.
  await mockMetrics(page, {
    percent: 25,
    cpu_count: 64,
    // cores 0-15 saturated, the rest idle - four cores per cell, so exactly
    // the first four cells burn
    per_core: Array.from({ length: 64 }, (_unused, i) => (i < 16 ? 100 : 0))
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
  // solid block rather than a lattice. This is not the floor assertion in other
  // words: a plain `gap: 1px` shrinks the cells to 2.25px and the floor above
  // catches it, but a seam that leaves the cells at 3px passes every assertion
  // before this one.
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
    const memory = document.querySelector('.jp-ResourceMonitor-memory')!;
    const all = Array.from(
      document.querySelectorAll('.jp-ResourceMonitor-gridCell')
    );
    const hot = all.filter(c =>
      c.classList.contains('jp-ResourceMonitor-gridCellHot')
    );
    const cool = all.filter(
      c => !c.classList.contains('jp-ResourceMonitor-gridCellHot')
    );
    // resolve the theme's own tokens through a throwaway node, so the hot
    // colour can be checked against what it must be and what it must not be
    // rather than only against the cool one
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const token = (name: string): string => {
      probe.style.backgroundColor = `var(${name})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const tokens = {
      brightest: token('--jp-ui-font-color0'),
      warn: token('--jp-warn-color1'),
      error: token('--jp-error-color1')
    };
    probe.remove();
    const pressure = (el: Element): boolean =>
      el.classList.contains('jp-ResourceMonitor-warn') ||
      el.classList.contains('jp-ResourceMonitor-danger');
    return {
      itemColour: getComputedStyle(item).color,
      coolColour: getComputedStyle(cool[0]).backgroundColor,
      hotColour: getComputedStyle(hot[0]).backgroundColor,
      hotCount: hot.length,
      label: item.getAttribute('aria-label'),
      tokens,
      warnClass: pressure(item),
      memoryPressure: pressure(memory)
    };
  });

  // The cells are the load on cores this server shares, not its own usage per
  // core - only the tooltip can say so, and only this tier proves the render
  // path actually asks for that wording when a grid is what got drawn.
  expect(rendered.label).toEqual(
    'CPU: 25% of 64 CPUs; grid shows load on each core assigned to this server'
  );

  // Cells take the item's own foreground, so the grid reads as typography
  // rather than as a coloured indicator.
  expect(rendered.coolColour).toEqual(rendered.itemColour);
  // The burn is a real rendered difference, not just a class that toggles.
  expect(rendered.hotColour).not.toEqual(rendered.coolColour);
  // DEF-8/DEF-17 at the colour level, which "hot differs from cool" cannot see:
  // the burn is the brightest UI foreground, and repainting it in the alarm
  // palette would satisfy every assertion above while the grid turns orange
  // under ordinary compute.
  expect(rendered.hotColour).toEqual(rendered.tokens.brightest);
  expect(rendered.hotColour).not.toEqual(rendered.tokens.warn);
  expect(rendered.hotColour).not.toEqual(rendered.tokens.error);
  // Four saturated cell groups.
  expect(rendered.hotCount).toEqual(4);
  // DEF-8 at the class level. The memory item is deliberately mocked into the
  // danger band, so this is a live discriminator: handing the CPU item the same
  // level makes it fail, which against a calm snapshot it would not.
  expect(rendered.memoryPressure).toBe(true);
  expect(rendered.warnClass).toBe(false);
});

test('the 3x3 grid divides exactly too', async ({ page }) => {
  // Every geometry assertion otherwise runs at 4x4, the one edge where 12px of
  // cells divides into whole pixels no matter how the tracks are declared.
  // Fixing the row height to the 4x4 cell size leaves that case square and this
  // one 4px by 3px, so the middle edge is what proves the tracks are relative.
  await mockMetrics(page, {
    percent: 50,
    cpu_count: 9,
    per_core: Array.from({ length: 9 }, () => 50)
  });

  const cells = page.locator('.jp-ResourceMonitor-gridCell');
  await expect(cells).toHaveCount(9, { timeout: 30000 });

  const cell = await cells.first().boundingBox();
  expect(cell!.width).toEqual(cell!.height);
  expect(cell!.width).toBeCloseTo(4, 1);

  const box = await page.locator('.jp-ResourceMonitor-grid').boundingBox();
  expect(box!.width).toEqual(box!.height);
  expect(box!.width).toBeCloseTo(14, 0);
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
