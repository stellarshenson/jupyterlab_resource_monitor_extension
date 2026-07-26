import { ISignal, Signal } from '@lumino/signaling';

import { Widget } from '@lumino/widgets';

import { GRID_HOT, MemLevel } from './format';

/**
 * A plain-text status bar item that carries a memory-pressure level, and can
 * render its reading as a filled bar instead of a number.
 *
 * Visibility is expressed through `active`, not by calling `show()`/`hide()`:
 * the status bar owns the widget's visibility, re-deciding it from `isActive()`
 * on every layout change, so a direct `hide()` here would be undone the next
 * time a tab opens. `activeChanged` is what tells the status bar to re-ask.
 */
export class ResourceItem extends Widget {
  constructor(kind: string) {
    super();
    this.addClass('jp-ResourceMonitor-item');
    this.addClass(`jp-ResourceMonitor-${kind}`);
    // role="img" makes the aria-label the element's accessible name; without a
    // role, screen readers may ignore aria-label on a generic div.
    this.node.setAttribute('role', 'img');
  }

  /**
   * Whether the item currently has something worth showing.
   */
  get active(): boolean {
    return this._active;
  }
  set active(value: boolean) {
    if (value === this._active) {
      return;
    }
    this._active = value;
    if (!value) {
      // drop the reading with the visibility, so nothing stale can be
      // re-displayed if the item becomes active again before the next poll
      this.text = '';
    }
    this._activeChanged.emit();
  }

  /**
   * Emitted when `active` changes, so the status bar re-evaluates `isActive`.
   */
  get activeChanged(): ISignal<this, void> {
    return this._activeChanged;
  }

  set text(value: string) {
    this._reset(value);
  }

  /**
   * Replace the item's contents with a plain label and drop every cached node.
   *
   * Writing textContent detaches whatever the previous display mode built, so
   * the caches have to go with it - otherwise the next setBar or setGrid finds
   * a live-looking reference and writes into a node no longer in the document.
   */
  private _reset(label: string): void {
    this.node.textContent = label;
    this._bar = null;
    this._grid = null;
  }

  set tooltip(value: string) {
    // title serves mouse hover; with role="img" the aria-label is the element's
    // accessible name, so screen-reader and touch-explore users reach the same
    // detail (the item is not in the tab order, so keyboard focus does not).
    this.node.title = value;
    this.node.setAttribute('aria-label', value);
  }

  set level(value: MemLevel) {
    this.toggleClass('jp-ResourceMonitor-warn', value === 'warn');
    this.toggleClass('jp-ResourceMonitor-danger', value === 'danger');
  }

  /**
   * Render the reading as a label plus a vertical outlined bar filled to
   * `fraction` - full only when every core is saturated. The outline and fill
   * both take the item's own text colour, so the bar reads as part of the
   * status bar's typography rather than as a coloured indicator.
   *
   * The label carries no trailing space: the item is a flex container, which
   * trims one, so the gap before the bar comes from the bar's own margin.
   */
  setBar(label: string, fraction: number): void {
    if (!this._bar) {
      this._reset(label);
      const bar = document.createElement('span');
      bar.className = 'jp-ResourceMonitor-bar';
      const fill = document.createElement('span');
      fill.className = 'jp-ResourceMonitor-barFill';
      bar.appendChild(fill);
      this.node.appendChild(bar);
      this._bar = fill;
    }
    this._bar.style.height = `${Math.round(fraction * 100)}%`;
  }

  /**
   * Render the reading as a label plus a square grid of cells, one cell per
   * group of cores, each gaining opacity with its own usage and switching to
   * the brighter foreground once past `GRID_HOT`.
   *
   * Brightness rather than a warn colour is deliberate: sustained 100% CPU is
   * ordinary during legitimate compute, so the CPU item never borrows the
   * alarm vocabulary the memory item uses for pressure.
   *
   * The cell nodes are built once and only their opacity is written on later
   * polls; the grid is rebuilt solely when the core count changes its shape.
   */
  setGrid(label: string, cells: number[], size: number): void {
    if (!this._grid || this._grid.length !== cells.length) {
      this._reset(label);
      const grid = document.createElement('span');
      grid.className = 'jp-ResourceMonitor-grid';
      grid.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
      this._grid = cells.map(() => {
        const cell = document.createElement('span');
        cell.className = 'jp-ResourceMonitor-gridCell';
        grid.appendChild(cell);
        return cell;
      });
      this.node.appendChild(grid);
    }
    const nodes = this._grid;
    cells.forEach((value, i) => {
      nodes[i].style.opacity = `${value}`;
      nodes[i].classList.toggle(
        'jp-ResourceMonitor-gridCellHot',
        value > GRID_HOT
      );
    });
  }

  // The bar's fill element while the item is in bar mode, so a poll updates
  // the height instead of rebuilding the DOM; null when showing plain text.
  private _bar: HTMLElement | null = null;
  // The grid's cell elements while the item is in grid mode, for the same
  // reason; null when showing plain text or a bar.
  private _grid: HTMLElement[] | null = null;
  private _active = false;
  private _activeChanged = new Signal<this, void>(this);
}
