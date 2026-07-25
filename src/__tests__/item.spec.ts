import { ResourceItem } from '../item';

describe('ResourceItem', () => {
  it('is inactive until it has something to show', () => {
    // the status bar owns visibility - registerStatusItem hides an inactive
    // item itself, so the item never calls show()/hide()
    const item = new ResourceItem('cpu');
    expect(item.active).toBe(false);
  });

  describe('active', () => {
    it('signals the status bar to re-evaluate on change', () => {
      // the status bar owns visibility and only re-asks isActive() when this
      // signal fires, so a silent flag change would never reach the DOM
      const item = new ResourceItem('cpu');
      let emitted = 0;
      item.activeChanged.connect(() => {
        emitted += 1;
      });

      item.active = true;
      expect(emitted).toEqual(1);
      expect(item.active).toBe(true);

      item.active = false;
      expect(emitted).toEqual(2);
    });

    it('does not signal when the value is unchanged', () => {
      const item = new ResourceItem('cpu');
      let emitted = 0;
      item.activeChanged.connect(() => {
        emitted += 1;
      });
      item.active = false;
      item.active = true;
      item.active = true;
      expect(emitted).toEqual(1);
    });

    it('clears the reading when it goes inactive', () => {
      // otherwise a stale number could be re-displayed by a layout change
      // before the next poll replaces it
      const item = new ResourceItem('memory');
      item.text = 'Mem: 3.4 / 16.0 GB';
      item.active = true;
      item.active = false;
      expect(item.node.textContent).toEqual('');
    });
  });

  it('carries its kind and an accessible role', () => {
    const item = new ResourceItem('memory');
    expect(item.hasClass('jp-ResourceMonitor-item')).toBe(true);
    expect(item.hasClass('jp-ResourceMonitor-memory')).toBe(true);
    // without a role, screen readers may ignore the aria-label
    expect(item.node.getAttribute('role')).toEqual('img');
  });

  it('mirrors the tooltip into title and aria-label', () => {
    const item = new ResourceItem('cpu');
    item.tooltip = 'CPU: 7% of 8 CPUs';
    expect(item.node.title).toEqual('CPU: 7% of 8 CPUs');
    expect(item.node.getAttribute('aria-label')).toEqual('CPU: 7% of 8 CPUs');
  });

  it('toggles only the class its level names', () => {
    const item = new ResourceItem('memory');
    item.level = 'warn';
    expect(item.hasClass('jp-ResourceMonitor-warn')).toBe(true);
    expect(item.hasClass('jp-ResourceMonitor-danger')).toBe(false);

    item.level = 'danger';
    expect(item.hasClass('jp-ResourceMonitor-warn')).toBe(false);
    expect(item.hasClass('jp-ResourceMonitor-danger')).toBe(true);

    item.level = 'normal';
    expect(item.hasClass('jp-ResourceMonitor-warn')).toBe(false);
    expect(item.hasClass('jp-ResourceMonitor-danger')).toBe(false);
  });

  describe('setBar', () => {
    const fill = (item: ResourceItem): HTMLElement =>
      item.node.querySelector('.jp-ResourceMonitor-barFill') as HTMLElement;

    it('builds a label plus an outlined bar', () => {
      const item = new ResourceItem('cpu');
      item.setBar('CPU:', 0.4);
      expect(item.node.textContent).toEqual('CPU:');
      expect(
        item.node.querySelectorAll('.jp-ResourceMonitor-bar')
      ).toHaveLength(1);
      expect(fill(item).style.height).toEqual('40%');
    });

    it('carries no trailing space in the label', () => {
      // the item is a flex container, which trims a trailing space, so the gap
      // must come from CSS - a label ending in a space would be a silent no-op
      const item = new ResourceItem('cpu');
      item.setBar('CPU:', 0.4);
      expect(item.node.textContent).not.toMatch(/\s$/);
    });

    it('updates the fill in place rather than rebuilding the DOM', () => {
      const item = new ResourceItem('cpu');
      item.setBar('CPU:', 0.1);
      const first = fill(item);
      item.setBar('CPU:', 0.9);
      expect(fill(item)).toBe(first);
      expect(first.style.height).toEqual('90%');
      expect(
        item.node.querySelectorAll('.jp-ResourceMonitor-bar')
      ).toHaveLength(1);
    });

    it('renders the extremes as an empty and a full bar', () => {
      const item = new ResourceItem('cpu');
      item.setBar('CPU:', 0);
      expect(fill(item).style.height).toEqual('0%');
      item.setBar('CPU:', 1);
      expect(fill(item).style.height).toEqual('100%');
    });

    it('rebuilds after the item is switched back to text', () => {
      // switching cpuMode away and back must not leave the setter writing to a
      // detached fill node
      const item = new ResourceItem('cpu');
      item.setBar('CPU:', 0.5);
      item.text = 'CPU: 50%';
      expect(item.node.querySelector('.jp-ResourceMonitor-bar')).toBeNull();

      item.setBar('CPU:', 0.5);
      expect(fill(item).style.height).toEqual('50%');
      // the rebuilt fill must live in the item's current subtree, not be a
      // leftover the setter is writing to after textContent detached it
      expect(item.node.contains(fill(item))).toBe(true);
      expect(item.node.textContent).toEqual('CPU:');
    });
  });

  it('drops the bar when plain text is set', () => {
    const item = new ResourceItem('cpu');
    item.setBar('CPU:', 0.5);
    item.text = 'CPU: 50%';
    expect(item.node.textContent).toEqual('CPU: 50%');
    expect(item.node.querySelectorAll('span')).toHaveLength(0);
  });
});
