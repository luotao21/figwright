import {
  PrivateResponsiveLayoutConfigSchema,
  resolveResponsiveLayoutConfig,
  ResponsiveLayoutConfigSchema,
} from '@figwright/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrivateResponsiveController } from '../src/private-responsive-controller.js';
import { createResponsiveFixture } from './responsive-layout-fixtures.js';

const legacyConfig = {
  fileName: 'test',
  pageId: 'p',
  mobileBelow: 768,
  gap: 16,
  rules: [
    { minWidth: 0, columns: 1, paddingX: 16, maxContentWidth: 1600 },
    { minWidth: 768, columns: 2, paddingX: 16, maxContentWidth: 1600 },
    { minWidth: 1024, columns: 3, paddingX: 24, maxContentWidth: 1600 },
    { minWidth: 1280, columns: 4, paddingX: 24, maxContentWidth: 1600 },
    { minWidth: 1800, columns: 5, paddingX: 24, maxContentWidth: 1680 },
  ],
  roots: [
    {
      rootId: 'r',
      mainId: 'main',
      bodyId: 'body',
      sectionIds: ['section'],
      gridIds: ['f'],
      sidebarId: 'sidebar',
      mobileHeaderId: 'header',
      navigation: {
        instanceId: 'nav',
        tabsNodeId: 'tabs',
        tabsProperty: 'Flag#1',
        selectProperty: 'Select#2',
      },
    },
  ],
};
const fixture = () => {
  const f = createResponsiveFixture('grid');
  Object.assign(f.api, { editorType: 'figma', mode: 'default' });
  Object.assign(f.api.root, { name: 'test' });
  f.root.parent = f.api.currentPage;
  const main = f.makeNode('main', 'FRAME', f.root);
  const body = f.makeNode('body', 'FRAME', main);
  const section = f.makeNode('section', 'FRAME', body);
  f.frame.parent = section;
  section.children.push(f.frame);
  const sidebar = f.makeNode('sidebar', 'INSTANCE', f.root);
  const header = f.makeNode('header', 'INSTANCE', body);
  const nav = f.makeNode('nav', 'INSTANCE', section);
  nav.componentProperties['Select#2'] = { type: 'BOOLEAN', value: false };
  const tabs = f.makeNode('tabs', 'INSTANCE', nav);
  tabs.width = 512;
  nav.width = 480;
  f.config.roots[0]!.base = [{ type: 'visibility', nodeId: 'i', values: { visible: false } }];
  f.writes.length = 0;
  const savePublic = (enabled: boolean) =>
    f.saved.set(
      'responsive_layout',
      JSON.stringify({
        version: 1,
        enabled,
        resolved: resolveResponsiveLayoutConfig(f.config),
      }),
    );
  const savePrivate = (enabled = true) =>
    f.saved.set('responsive_layout_v1', JSON.stringify({ enabled, config: legacyConfig }));
  const owner = (source: 'public' | 'private' | 'none') =>
    f.saved.set('responsive_layout_private_owner', JSON.stringify({ version: 1, source }));
  const tick = async () => {
    f.emitChange();
    await vi.advanceTimersByTimeAsync(120);
  };
  return {
    ...f,
    main,
    body,
    section,
    sidebar,
    header,
    nav,
    tabs,
    savePublic,
    savePrivate,
    owner,
    tick,
  };
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('private responsive ownership', () => {
  it('legacy values remain unchanged and are not accepted by the public parser', async () => {
    const f = fixture();
    expect(ResponsiveLayoutConfigSchema.safeParse(legacyConfig).success).toBe(false);
    expect(PrivateResponsiveLayoutConfigSchema.parse(legacyConfig).rules).toEqual(
      legacyConfig.rules,
    );
    f.savePrivate();
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await f.tick();
    expect(c.get()).toMatchObject({
      source: 'private',
      config: legacyConfig,
      roots: [{ status: 'active', columns: 2, navigation: 'select' }],
    });
    expect(f.frame.gridColumnCount).toBe(2);
    expect(f.section.paddingLeft).toBe(16);
    expect(f.body.maxWidth).toBe(1600);
    expect(f.saved.has('responsive_layout')).toBe(false);
    expect(f.saved.get('responsive_layout_v1')).toBe(
      JSON.stringify({ enabled: true, config: legacyConfig }),
    );
    c.dispose();
  });
  it.each([
    { publicEnabled: true, privateEnabled: true, source: 'public', visible: false, columns: 3 },
    { publicEnabled: false, privateEnabled: true, source: 'private', visible: true, columns: 2 },
    { publicEnabled: false, privateEnabled: false, source: 'none', visible: true, columns: 3 },
  ])(
    'only one controller owns writes with no saved owner: $source',
    async ({ publicEnabled, privateEnabled, source, visible, columns }) => {
      const f = fixture();
      f.savePublic(publicEnabled);
      f.savePrivate(privateEnabled);
      const c = createPrivateResponsiveController(f.api);
      c.start();
      c.start();
      await f.tick();
      expect(c.get()).toMatchObject({ source });
      expect(f.instance.visible).toBe(visible);
      expect(f.frame.gridColumnCount).toBe(columns);
      expect(f.listeners.get('nodechange')?.size ?? 0).toBe(source === 'none' ? 0 : 1);
      c.dispose();
      expect(f.listeners.get('nodechange')?.size ?? 0).toBe(0);
    },
  );
  it.each([
    { source: 'public' as const, visible: false, columns: 3 },
    { source: 'private' as const, visible: true, columns: 2 },
    { source: 'none' as const, visible: true, columns: 3 },
  ])('honors a recorded owner without fallback: $source', async ({ source, visible, columns }) => {
    const f = fixture();
    f.savePublic(true);
    f.savePrivate();
    f.owner(source);
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await f.tick();
    expect(c.get()).toMatchObject({ source });
    expect(f.instance.visible).toBe(visible);
    expect(f.frame.gridColumnCount).toBe(columns);
    c.dispose();
  });
  it.each(['public', 'private'] as const)(
    'disabling %s never revives the other saved configuration',
    async source => {
      const f = fixture();
      f.savePublic(true);
      f.savePrivate();
      f.owner(source);
      const c = createPrivateResponsiveController(f.api);
      c.start();
      await f.tick();
      await c.configure({ enabled: false });
      f.root.width = 390;
      f.writes.length = 0;
      await f.tick();
      expect(c.get()).toMatchObject({ source, enabled: false });
      expect(f.writes).toEqual([]);
      c.dispose();
      const reopened = createPrivateResponsiveController(f.api);
      reopened.start();
      await f.tick();
      expect(reopened.get()).toMatchObject({ source, enabled: false });
      expect(f.writes).toEqual([]);
      reopened.dispose();
    },
  );
  it.each(['{"version":99,"enabled":true}', '{broken'])(
    'bad public data does not fall back to enabled private rules: %s',
    async saved => {
      const f = fixture();
      f.savePrivate();
      f.saved.set('responsive_layout', saved);
      const c = createPrivateResponsiveController(f.api);
      c.start();
      await f.tick();
      expect(c.get()).toMatchObject({ source: 'public', enabled: false, error: { phase: 'load' } });
      expect(f.writes).toEqual([]);
      c.dispose();
    },
  );
  it('bad owner data disables all writes rather than guessing', async () => {
    const f = fixture();
    f.savePublic(true);
    f.savePrivate();
    f.saved.set('responsive_layout_private_owner', '{"version":99,"source":"private"}');
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await f.tick();
    expect(c.get()).toMatchObject({ source: 'none', enabled: false, error: { phase: 'load' } });
    expect(f.writes).toEqual([]);
    c.dispose();
  });
  it('public replacement cancels pending private node resolution', async () => {
    const f = fixture();
    f.savePrivate();
    const wait = f.deferLookup('main');
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await vi.advanceTimersByTimeAsync(120);
    await c.configure({ enabled: true, config: f.config });
    f.writes.length = 0;
    wait.release();
    await vi.advanceTimersByTimeAsync(120);
    expect(c.get()).toMatchObject({ source: 'public', enabled: true });
    expect(f.writes).toEqual([]);
    expect(f.saved.get('responsive_layout_private_owner')).toBe('{"version":1,"source":"public"}');
    c.dispose();
  });
  it('public replacement cancels pending private variable resolution', async () => {
    const f = fixture();
    f.savePrivate();
    f.saved.set(
      'responsive_layout_v1',
      JSON.stringify({ enabled: true, config: { ...legacyConfig, gapVariableId: 'v' } }),
    );
    const wait = deferred();
    f.api.variables.getVariableByIdAsync = async () => {
      await wait.promise;
      return {
        id: 'v',
        resolvedType: 'FLOAT',
        resolveForConsumer: () => ({ value: 16, resolvedType: 'FLOAT' }),
      } as unknown as Variable;
    };
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await vi.advanceTimersByTimeAsync(120);
    await c.configure({ enabled: true, config: f.config });
    f.writes.length = 0;
    wait.release();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.writes).toEqual([]);
    c.dispose();
  });
  it.each(['disable', 'page', 'dispose'] as const)(
    'pending private work cannot write after %s',
    async action => {
      const f = fixture();
      f.savePrivate();
      const wait = f.deferLookup('main');
      const c = createPrivateResponsiveController(f.api);
      c.start();
      await vi.advanceTimersByTimeAsync(120);
      if (action === 'disable') await c.configure({ enabled: false });
      if (action === 'page') f.switchPage('other');
      if (action === 'dispose') c.dispose();
      f.writes.length = 0;
      wait.release();
      await vi.advanceTimersByTimeAsync(120);
      expect(f.writes).toEqual([]);
      expect(f.listeners.get('nodechange')?.size ?? 0).toBe(0);
      c.dispose();
    },
  );
  it('preserves legacy boundaries and fit behavior across widths', async () => {
    const f = fixture();
    f.savePrivate();
    const c = createPrivateResponsiveController(f.api);
    c.start();
    const childIds = f.frame.children.map((n: SceneNode) => n.id);
    for (const [width, columns, padding, maxWidth, mobile] of [
      [767, 1, 16, 1600, true],
      [768, 2, 16, 1600, false],
      [1024, 3, 24, 1600, false],
      [1280, 4, 24, 1600, false],
      [1800, 5, 24, 1680, false],
      [390, 1, 16, 1600, true],
    ] as const) {
      f.root.width = width;
      await f.tick();
      expect(f.frame.gridColumnCount).toBe(columns);
      expect(f.section.paddingLeft).toBe(padding);
      expect(f.body.maxWidth).toBe(maxWidth);
      expect(f.sidebar.visible).toBe(!mobile);
      expect(f.header.visible).toBe(mobile);
      expect(f.nav.componentProperties['Select#2'].value).toBe(true);
      expect(f.frame.children.map((n: SceneNode) => n.id)).toEqual(childIds);
    }
    f.nav.width = 700;
    f.root.width = 900;
    await f.tick();
    expect(f.nav.componentProperties['Select#2'].value).toBe(false);
    c.dispose();
  });
  it('rejects legacy input without stopping its selected controller', async () => {
    const f = fixture();
    f.savePrivate();
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await f.tick();
    await expect(c.configure({ enabled: true, config: legacyConfig })).rejects.toThrow(Error);
    expect(c.get()).toMatchObject({ source: 'private', enabled: true });
    c.dispose();
  });
  it('an explicit none owner stays idle even if both saved configurations are enabled', async () => {
    const f = fixture();
    f.savePublic(true);
    f.savePrivate();
    f.owner('none');
    const lookup = vi.spyOn(f.api, 'getNodeByIdAsync');
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await c.configure({ enabled: false });
    await f.tick();
    expect(c.get()).toMatchObject({ source: 'none', enabled: false });
    expect(lookup).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    c.dispose();
  });
  it('can enable a saved disabled public config without falling back to private', async () => {
    const f = fixture();
    f.savePublic(false);
    f.savePrivate(false);
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await c.configure({ enabled: true });
    await f.tick();
    expect(c.get()).toMatchObject({ source: 'public', enabled: true });
    expect(f.instance.visible).toBe(false);
    expect(f.frame.gridColumnCount).toBe(3);
    c.dispose();
  });
  it('honors an explicit private owner even with an invalid unselected public save', async () => {
    const f = fixture();
    f.savePrivate();
    f.owner('private');
    f.saved.set('responsive_layout', '{broken');
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await f.tick();
    expect(c.get()).toMatchObject({
      source: 'private',
      enabled: true,
      roots: [{ status: 'active' }],
    });
    expect(f.frame.gridColumnCount).toBe(2);
    c.dispose();
  });
  it('private work checks cancellation before every subsequent setter', async () => {
    const f = fixture();
    f.savePrivate();
    const c = createPrivateResponsiveController(f.api);
    let horizontal = 'FIXED';
    Object.defineProperty(f.main, 'layoutSizingHorizontal', {
      get: () => horizontal,
      set: value => {
        horizontal = value;
        f.writes.length = 0;
        void c.configure({ enabled: false });
      },
    });
    c.start();
    await f.tick();
    expect(c.get()).toMatchObject({ source: 'private', enabled: false });
    expect(f.writes).toEqual([]);
    expect(f.frame.gridItemsPositioning).toBe('MANUAL');
    c.dispose();
  });
  it('a public replacement cancels a superseded public configuration', async () => {
    const f = fixture();
    f.owner('none');
    const c = createPrivateResponsiveController(f.api);
    c.start();
    const wait = f.deferLookup('r');
    const first = c.configure({ enabled: true, config: f.config });
    const rejection = first.then(
      () => 'resolved',
      error => String(error.message),
    );
    await c.configure({ enabled: false });
    wait.release();
    expect(await rejection).toMatch(/superseded/);
    await f.tick();
    expect(c.get()).toMatchObject({ source: 'none', enabled: false });
    expect(f.writes).toEqual([]);
    c.dispose();
  });
  it('a rejected owner switch never starts a previously unselected public save', async () => {
    const f = fixture();
    f.savePublic(true);
    f.savePrivate();
    f.owner('private');
    const c = createPrivateResponsiveController(f.api);
    c.start();
    await f.tick();
    f.writes.length = 0;
    await expect(
      c.configure({ enabled: true, config: { ...f.config, pageId: 'other' } }),
    ).rejects.toThrow(/current page/);
    await f.tick();
    expect(c.get()).toMatchObject({
      source: 'none',
      enabled: false,
      error: { phase: 'configure' },
    });
    expect(f.writes).toEqual([]);
    c.dispose();
    const reopened = createPrivateResponsiveController(f.api);
    reopened.start();
    await f.tick();
    expect(reopened.get()).toMatchObject({ source: 'none', enabled: false });
    expect(f.writes).toEqual([]);
    reopened.dispose();
  });
});
