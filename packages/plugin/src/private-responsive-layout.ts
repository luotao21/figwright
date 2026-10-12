import {
  PrivateResponsiveLayoutConfigSchema,
  type PrivateResponsiveLayoutConfig,
} from '@figwright/shared';
import { z } from 'zod';

import { withInstanceIdLookup } from './node-lookup.js';

const KEY = 'responsive_layout_v1';
const SavedSchema = z.object({ enabled: z.boolean(), config: PrivateResponsiveLayoutConfigSchema });
type RootConfig = PrivateResponsiveLayoutConfig['roots'][number];
const COPY_KEY = 'responsive_layout_copy';
const CopyTemplateSchema = z.object({
  version: z.literal(1),
  fileName: z.string(),
  pageId: z.string(),
  root: PrivateResponsiveLayoutConfigSchema.shape.roots.element,
  paths: z.record(
    z.string(),
    z.array(
      z.object({
        index: z.number().int().nonnegative(),
        type: z.string(),
        name: z.string(),
      }),
    ),
  ),
});
const targetIds = (c: RootConfig): string[] => [
  ...new Set([
    c.rootId,
    c.mainId,
    c.bodyId,
    ...c.sectionIds,
    ...c.gridIds,
    ...(c.sidebarId === undefined ? [] : [c.sidebarId]),
    ...(c.mobileHeaderId === undefined ? [] : [c.mobileHeaderId]),
    ...(c.navigation === undefined ? [] : [c.navigation.instanceId, c.navigation.tabsNodeId]),
  ]),
];
const remapRoot = (c: RootConfig, ids: Map<string, string>): RootConfig => {
  const id = (old: string): string => {
    const next = ids.get(old);
    if (next === undefined) throw new Error(`Missing copied target ${old}`);
    return next;
  };
  return {
    ...c,
    rootId: id(c.rootId),
    mainId: id(c.mainId),
    bodyId: id(c.bodyId),
    sectionIds: c.sectionIds.map(id),
    gridIds: c.gridIds.map(id),
    ...(c.sidebarId === undefined ? {} : { sidebarId: id(c.sidebarId) }),
    ...(c.mobileHeaderId === undefined ? {} : { mobileHeaderId: id(c.mobileHeaderId) }),
    ...(c.navigation === undefined
      ? {}
      : {
          navigation: {
            ...c.navigation,
            instanceId: id(c.navigation.instanceId),
            tabsNodeId: id(c.navigation.tabsNodeId),
          },
        }),
  };
};

interface RootState {
  rootId: string;
  status: 'active' | 'paused' | 'error' | 'disabled';
  viewportWidth?: number;
  columns?: number;
  contentWidth?: number;
  navigation?: 'tabs' | 'select';
  lastAppliedAt?: number;
  error?: string;
}

const isWithin = (node: BaseNode, ancestor: BaseNode): boolean => {
  let parent: BaseNode | null = node;
  while (parent !== null) {
    if (parent === ancestor) return true;
    parent = parent.parent;
  }
  return false;
};

/** Only plain, explicitly registered frames are writable; never descend into an instance. */
const assertPlainFrame = (node: BaseNode | null, root?: FrameNode): FrameNode => {
  if (node?.type !== 'FRAME' || node.removed)
    throw new Error(`responsive layout: ${node?.id ?? 'missing'} is not a FRAME`);
  let parent = node.parent;
  while (parent !== null && parent !== root) {
    if (
      parent.type === 'INSTANCE' ||
      parent.type === 'COMPONENT' ||
      parent.type === 'COMPONENT_SET'
    ) {
      throw new Error(`responsive layout: ${node.id} is inside a component`);
    }
    parent = parent.parent;
  }
  if (root !== undefined && !isWithin(node, root))
    throw new Error(`responsive layout: ${node.id} is outside ${root.id}`);
  return node;
};

const validateRules = (cfg: PrivateResponsiveLayoutConfig): void => {
  if (
    cfg.rules[0]?.minWidth !== 0 ||
    cfg.rules.some((r, i) => i > 0 && r.minWidth <= cfg.rules[i - 1]!.minWidth)
  )
    throw new Error('responsive layout: rules must start at 0 and increase strictly');
  const ids = cfg.roots.map(c => c.rootId);
  if (new Set(ids).size !== ids.length)
    throw new Error('responsive layout: duplicate registered root');
};

export const createPrivateResponsiveLayoutController = (figmaApi: typeof figma) => {
  const figmaCtx = withInstanceIdLookup(figmaApi);
  let config: PrivateResponsiveLayoutConfig | null = null;
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const pendingRoots = new Set<string>();
  const pendingCopies = new Set<FrameNode>();
  const copyErrors = new Map<string, string>();
  let started = false;
  let disposed = false;
  let generation = 0;
  let watchedPage: PageNode | undefined;
  let loadError: string | undefined;
  const states = new Map<string, RootState>();
  // Only referenced nodes and existing token definitions are cached, not entire pages.
  const refs = new Map<string, BaseNode>();
  const tokens = new Map<string, Variable>();
  const desktopVisibility = new Map<string, boolean>();

  const node = async (id: string): Promise<BaseNode | null> => {
    const cached = refs.get(id);
    if (cached !== undefined && !cached.removed) return cached;
    const epoch = generation;
    const found = await figmaCtx.getNodeByIdAsync(id);
    if (found !== null && !disposed && epoch === generation) refs.set(id, found);
    return found;
  };
  const token = async (id: string | undefined): Promise<Variable | null> => {
    if (id === undefined) return null;
    const cached = tokens.get(id);
    if (cached !== undefined) return cached;
    const epoch = generation;
    const found = await figmaCtx.variables.getVariableByIdAsync(id);
    if (found === null || found.resolvedType !== 'FLOAT')
      throw new Error(`responsive layout: ${id} is not an existing FLOAT variable`);
    if (!disposed && epoch === generation) tokens.set(id, found);
    return found;
  };

  const current = (epoch: number, cfg: PrivateResponsiveLayoutConfig): boolean =>
    !disposed &&
    enabled &&
    epoch === generation &&
    config === cfg &&
    figmaCtx.currentPage.id === cfg.pageId;
  const invalidate = (): void => {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pendingRoots.clear();
    pendingCopies.clear();
    running = undefined;
  };
  const collectCopies = (): void => {
    if (config === null || !current(generation, config)) return;
    const registered = new Set(config.roots.map(c => c.rootId));
    for (const candidate of figmaCtx.currentPage.children)
      if (
        candidate.type === 'FRAME' &&
        !registered.has(candidate.id) &&
        candidate.getPluginData(COPY_KEY) !== ''
      )
        pendingCopies.add(candidate);
  };
  const inheritCopies = (cfg: PrivateResponsiveLayoutConfig, epoch: number): void => {
    for (const candidate of pendingCopies) {
      pendingCopies.delete(candidate);
      if (!current(epoch, cfg)) return;
      if (
        candidate.removed ||
        candidate.parent?.id !== cfg.pageId ||
        cfg.roots.some(c => c.rootId === candidate.id)
      )
        continue;
      try {
        const template = CopyTemplateSchema.parse(JSON.parse(candidate.getPluginData(COPY_KEY)));
        if (
          template.fileName !== cfg.fileName ||
          template.pageId !== cfg.pageId ||
          template.root.rootId === candidate.id
        )
          continue;
        const ids = new Map<string, string>();
        for (const oldId of targetIds(template.root)) {
          const path = template.paths[oldId];
          if (path === undefined) throw new Error(`Missing copied path for ${oldId}`);
          let found: BaseNode = candidate;
          for (const step of path) {
            const next: BaseNode | undefined =
              'children' in found ? found.children[step.index] : undefined;
            if (next === undefined || next.type !== step.type || next.name !== step.name)
              throw new Error(`Copied structure no longer matches ${oldId}`);
            found = next;
          }
          if (found.removed) throw new Error(`Copied target ${oldId} was removed`);
          ids.set(oldId, found.id);
        }
        const inherited = { ...remapRoot(template.root, ids), copiedFrom: template.root.rootId };
        const next = PrivateResponsiveLayoutConfigSchema.parse({
          ...cfg,
          roots: [...cfg.roots, inherited],
        });
        validateRules(next);
        // Persist new identities before applying. Only provenance-bearing copies on the owned page qualify.
        if (!current(epoch, cfg)) return;
        figmaCtx.root.setPluginData(KEY, JSON.stringify({ enabled, config: next }));
        cfg.roots = next.roots;
        pendingRoots.add(candidate.id);
        copyErrors.delete(candidate.id);
      } catch (error) {
        if (current(epoch, cfg))
          copyErrors.set(candidate.id, error instanceof Error ? error.message : String(error));
      }
    }
  };
  const saveCopyTemplate = async (
    root: FrameNode,
    c: RootConfig,
    cfg: PrivateResponsiveLayoutConfig,
    epoch: number,
  ): Promise<void> => {
    const paths: z.infer<typeof CopyTemplateSchema>['paths'] = {};
    for (const id of targetIds(c)) {
      // eslint-disable-next-line no-await-in-loop -- references are already cached by validation
      let target = await node(id);
      const path: z.infer<typeof CopyTemplateSchema>['paths'][string] = [];
      while (target !== root) {
        if (target === null || target.parent === null || !('children' in target.parent))
          throw new Error(`Cannot locate copied target ${id}`);
        const index = target.parent.children.indexOf(target as SceneNode);
        if (index < 0) throw new Error(`Cannot locate copied target ${id}`);
        path.unshift({ index, type: target.type, name: target.name });
        target = target.parent;
      }
      paths[id] = path;
    }
    if (!current(epoch, cfg)) return;
    const value = JSON.stringify({
      version: 1,
      fileName: cfg.fileName,
      pageId: cfg.pageId,
      root: c,
      paths,
    });
    if (root.getPluginData(COPY_KEY) !== value) root.setPluginData(COPY_KEY, value);
  };
  const applyRoot = async (
    c: RootConfig,
    cfg: PrivateResponsiveLayoutConfig,
    epoch: number,
  ): Promise<void> => {
    const write = <T, K extends keyof T>(target: T, key: K, value: T[K]): void => {
      if (!current(epoch, cfg)) throw new Error('Responsive operation cancelled');
      if (target[key] !== value) target[key] = value;
    };
    const spacing = (
      frame: FrameNode,
      field: VariableBindableNodeField & keyof FrameNode,
      value: number,
      variable: Variable | null,
    ): void => {
      if (!current(epoch, cfg)) throw new Error('Responsive operation cancelled');
      const binding = frame.boundVariables?.[
        field as keyof NonNullable<FrameNode['boundVariables']>
      ] as VariableAlias | undefined;
      if (variable !== null) {
        if (binding?.id !== variable.id) frame.setBoundVariable(field, variable);
      } else {
        if (binding !== undefined) frame.setBoundVariable(field, null);
        write(frame, field, value as FrameNode[typeof field]);
      }
    };
    const previous = states.get(c.rootId);
    if (previous?.status === 'error') return; // explicit reconfigure is required after a failure
    if (figmaCtx.currentPage.id !== cfg.pageId) {
      states.set(c.rootId, { ...previous, rootId: c.rootId, status: 'paused' });
      return;
    }
    let phase = 'resolve root';
    try {
      if (
        figmaCtx.root.name !== cfg.fileName ||
        figmaCtx.editorType !== 'figma' ||
        figmaCtx.mode === 'inspect'
      ) {
        throw new Error(
          'responsive layout: file/editor is not the configured writable Figma Design file',
        );
      }
      const root = assertPlainFrame(await node(c.rootId));
      if (root.parent?.id !== cfg.pageId)
        throw new Error(`responsive layout: ${root.id} is not a top-level frame on ${cfg.pageId}`);
      phase = 'resolve layout frames';
      const main = assertPlainFrame(await node(c.mainId), root);
      const body = assertPlainFrame(await node(c.bodyId), root);
      if (main.parent !== root || body.parent !== main)
        throw new Error('responsive layout: expected root > main > body');
      const sections = await Promise.all(
        c.sectionIds.map(async id => assertPlainFrame(await node(id), root)),
      );
      const grids = await Promise.all(
        c.gridIds.map(async id => assertPlainFrame(await node(id), root)),
      );
      if (sections.some(s => s.parent !== body))
        throw new Error('responsive layout: sections must be direct body children');
      if (grids.some(g => g.layoutMode !== 'GRID' || !sections.some(s => isWithin(g, s))))
        throw new Error('responsive layout: each GRID must be within a registered section');
      if (grids.some(g => !('gridItemsPositioning' in g) || !('gridAutoTracks' in g)))
        throw new Error('responsive layout: this Figma runtime lacks native automatic grid flow');
      if (
        grids.some(g =>
          g.children.some(
            child =>
              !('gridRowSpan' in child) ||
              child.gridRowSpan !== 1 ||
              child.gridColumnSpan !== 1 ||
              child.layoutPositioning === 'ABSOLUTE',
          ),
        )
      ) {
        throw new Error(
          'responsive layout: uniform card grids require single-cell in-flow children',
        );
      }
      phase = 'resolve shell';
      const sidebar = c.sidebarId === undefined ? null : await node(c.sidebarId);
      const header = c.mobileHeaderId === undefined ? null : await node(c.mobileHeaderId);
      if (sidebar !== null && (sidebar.type !== 'INSTANCE' || sidebar.parent !== root))
        throw new Error('responsive layout: sidebar must be a complete direct root instance');
      if (header !== null && (header.type !== 'INSTANCE' || header.parent !== body))
        throw new Error('responsive layout: mobile header must be a complete direct body instance');
      if (
        (c.sidebarId !== undefined && sidebar === null) ||
        (c.mobileHeaderId !== undefined && header === null)
      )
        throw new Error('responsive layout: a registered shell instance is missing');
      phase = 'resolve navigation';
      const nav = c.navigation === undefined ? null : await node(c.navigation.instanceId);
      const tabs = c.navigation === undefined ? null : await node(c.navigation.tabsNodeId);
      if (
        c.navigation !== undefined &&
        (nav?.type !== 'INSTANCE' ||
          !isWithin(nav, body) ||
          tabs === null ||
          !isWithin(tabs, nav) ||
          !('width' in tabs))
      )
        throw new Error('responsive layout: invalid navigation instance/tabs measurement');
      if (nav?.type === 'INSTANCE' && c.navigation !== undefined) {
        for (const key of [c.navigation.tabsProperty, c.navigation.selectProperty]) {
          if (nav.componentProperties[key]?.type !== 'BOOLEAN')
            throw new Error(`responsive layout: ${key} is not a public BOOLEAN`);
        }
      }
      let rule = cfg.rules[0]!;
      for (const candidate of cfg.rules) {
        if (candidate.minWidth > root.width) break;
        rule = candidate;
      }
      phase = 'resolve spacing tokens';
      const [paddingToken, gapToken] = await Promise.all([
        token(rule.paddingVariableId),
        token(cfg.gapVariableId),
      ]);
      if (
        paddingToken !== null &&
        sections.some(s => paddingToken.resolveForConsumer(s).value !== rule.paddingX)
      )
        throw new Error(
          'responsive layout: padding token does not resolve to the configured value',
        );
      if (gapToken !== null && grids.some(g => gapToken.resolveForConsumer(g).value !== cfg.gap))
        throw new Error('responsive layout: gap token does not resolve to the configured value');
      // All validation/resolution is complete before writes. No children are removed/recreated.
      if (!current(epoch, cfg)) return;
      phase = 'apply layout';
      const mobile = root.width < cfg.mobileBelow;
      if (sidebar?.type === 'INSTANCE') {
        if (previous?.viewportWidth === undefined)
          desktopVisibility.set(root.id, mobile ? true : sidebar.visible);
        if (previous?.viewportWidth !== undefined && previous.viewportWidth >= cfg.mobileBelow)
          desktopVisibility.set(root.id, sidebar.visible);
        write(sidebar, 'visible', mobile ? false : (desktopVisibility.get(root.id) ?? true));
      }
      if (header?.type === 'INSTANCE') write(header, 'visible', mobile);
      write(root, 'layoutSizingVertical', 'HUG');
      write(main, 'layoutSizingHorizontal', 'FILL');
      write(main, 'layoutSizingVertical', 'HUG');
      write(main, 'counterAxisAlignItems', 'CENTER');
      write(body, 'layoutSizingHorizontal', 'FILL');
      write(body, 'layoutSizingVertical', 'HUG');
      write(body, 'maxWidth', rule.maxContentWidth);
      for (const section of sections) {
        write(section, 'layoutSizingHorizontal', 'FILL');
        write(section, 'layoutSizingVertical', 'HUG');
        spacing(section, 'paddingLeft', rule.paddingX, paddingToken);
        spacing(section, 'paddingRight', rule.paddingX, paddingToken);
      }
      for (const grid of grids) {
        // The legacy controller owns sizing; leave HUG before automatic rows can grow.
        if (
          grid.layoutSizingVertical === 'HUG' &&
          (grid.gridColumnCount !== rule.columns || grid.gridAutoTracks !== 'ROWS')
        )
          write(grid, 'layoutSizingVertical', 'FIXED');
        // Native automatic flow releases occupied-column anchors before changing the count.
        // ROWS owns row count; writing gridRowCount here would throw, even for the same value.
        write(grid, 'gridItemsPositioning', 'ROW_AUTO_FLOW');
        write(grid, 'gridAutoTracks', 'ROWS');
        write(grid, 'gridColumnCount', rule.columns);
        for (const track of grid.gridColumnSizes) {
          write(track, 'type', 'FLEX');
          write(track, 'value', 1);
        }
        for (const track of grid.gridRowSizes) write(track, 'type', 'HUG');
        spacing(grid, 'gridRowGap', cfg.gap, gapToken);
        spacing(grid, 'gridColumnGap', cfg.gap, gapToken);
        write(grid, 'layoutSizingHorizontal', 'FILL');
        write(grid, 'layoutSizingVertical', 'HUG');
      }
      let navigation: RootState['navigation'];
      if (
        nav?.type === 'INSTANCE' &&
        tabs !== null &&
        'width' in tabs &&
        c.navigation !== undefined
      ) {
        const compact = mobile || nav.width < tabs.width;
        const values = {
          [c.navigation.tabsProperty]: !compact,
          [c.navigation.selectProperty]: compact,
        };
        if (
          Object.entries(values).some(
            ([key, value]) => nav.componentProperties[key]?.value !== value,
          )
        ) {
          if (!current(epoch, cfg)) return;
          nav.setProperties(values);
        }
        navigation = compact ? 'select' : 'tabs';
      }
      if (!current(epoch, cfg)) return;
      phase = 'save copy template';
      await saveCopyTemplate(root, c, cfg, epoch);
      if (!current(epoch, cfg)) return;
      states.set(c.rootId, {
        rootId: c.rootId,
        status: 'active',
        viewportWidth: root.width,
        columns: rule.columns,
        contentWidth: body.width,
        ...(navigation === undefined ? {} : { navigation }),
        lastAppliedAt: Date.now(),
      });
    } catch (error) {
      if (!current(epoch, cfg)) return;
      states.set(c.rootId, {
        ...previous,
        rootId: c.rootId,
        status: 'error',
        error: `${phase}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const apply = (): Promise<void> => {
    if (running !== undefined) return running;
    const epoch = generation;
    const work = (async () => {
      const initial = config;
      if (initial !== null && current(epoch, initial)) {
        const surviving = await Promise.all(
          initial.roots.map(async c => {
            if (c.copiedFrom === undefined) return c;
            const found = await node(c.rootId);
            return found === null || found.removed ? null : c;
          }),
        );
        if (!current(epoch, initial)) return;
        if (surviving.some(c => c === null)) {
          const next = { ...initial, roots: surviving.filter((c): c is RootConfig => c !== null) };
          figmaCtx.root.setPluginData(KEY, JSON.stringify({ enabled, config: next }));
          initial.roots = next.roots;
        }
      }
      // Document-change notifications from our writes may request one more pass. Equality guards
      // make that pass a no-op; no timer loop and no user edits are swallowed.
      while (pendingRoots.size > 0 || pendingCopies.size > 0) {
        const cfg = config;
        if (cfg === null || !current(epoch, cfg)) break;
        inheritCopies(cfg, epoch);
        const ids = new Set(pendingRoots);
        pendingRoots.clear();
        for (const root of cfg.roots) {
          if (!ids.has(root.rootId)) continue;
          // eslint-disable-next-line no-await-in-loop -- serialize Figma writes
          await applyRoot(root, cfg, epoch);
        }
      }
    })().finally(() => {
      if (running === work) running = undefined;
    });
    running = work;
    return work;
  };
  const schedule = (event?: NodeChangeEvent): void => {
    if (!enabled || disposed) return;
    const cfg = config;
    if (cfg === null || !current(generation, cfg)) return;
    if (event === undefined) collectCopies();
    if (event === undefined || event.nodeChanges.some(change => change.type === 'DELETE')) {
      for (const root of cfg.roots) pendingRoots.add(root.rootId);
    } else {
      const rootIds = new Set(cfg.roots.map(root => root.rootId));
      for (const change of event.nodeChanges) {
        let changed: BaseNode | null = change.node as SceneNode;
        while (changed !== null && changed.type !== 'PAGE') {
          if (rootIds.has(changed.id)) {
            pendingRoots.add(changed.id);
            break;
          }
          if (
            changed.type === 'FRAME' &&
            changed.parent?.id === cfg.pageId &&
            changed.getPluginData(COPY_KEY) !== ''
          ) {
            pendingCopies.add(changed);
            break;
          }
          changed = changed.parent;
        }
      }
    }
    if (pendingRoots.size === 0 && pendingCopies.size === 0) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void apply();
    }, 120);
  };
  const get = () => ({
    enabled,
    config,
    error: loadError,
    dependency: 'Figwright plugin must remain open',
    ...(copyErrors.size === 0
      ? {}
      : { copyErrors: [...copyErrors].map(([rootId, error]) => ({ rootId, error })) }),
    roots:
      config?.roots.map(
        (c): RootState =>
          states.get(c.rootId) ?? { rootId: c.rootId, status: enabled ? 'paused' : 'disabled' },
      ) ?? [],
  });
  const configure = async (params: unknown) => {
    if (disposed) throw new Error('Private responsive controller is disposed');
    const p = z
      .object({ enabled: z.boolean(), config: PrivateResponsiveLayoutConfigSchema.optional() })
      .parse(params);
    if (p.enabled && (figmaCtx.editorType !== 'figma' || figmaCtx.mode === 'inspect'))
      throw new Error('responsive layout: enabling requires writable Figma Design mode');
    const next = p.config ?? config;
    if (p.enabled && next === null)
      throw new Error('responsive layout: supply config before enabling');
    if (next !== null) {
      if (
        (p.config !== undefined || p.enabled) &&
        (next.fileName !== figmaCtx.root.name || next.pageId !== figmaCtx.currentPage.id)
      )
        throw new Error('responsive layout: configuration must name the current file/page');
      validateRules(next);
    }
    invalidate();
    enabled = p.enabled;
    config = next;
    loadError = undefined;
    states.clear();
    copyErrors.clear();
    pendingRoots.clear();
    refs.clear();
    tokens.clear();
    desktopVisibility.clear();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (next !== null) figmaCtx.root.setPluginData(KEY, JSON.stringify({ enabled, config: next }));
    updateWatch();
    if (enabled) {
      for (const root of next!.roots) pendingRoots.add(root.rootId);
      collectCopies();
      await apply();
    }
    return { ok: true, ...get() };
  };
  const updateWatch = (): void => {
    const page =
      started &&
      !disposed &&
      enabled &&
      config !== null &&
      figmaCtx.currentPage.id === config.pageId
        ? figmaCtx.currentPage
        : undefined;
    if (watchedPage === page) return;
    watchedPage?.off('nodechange', schedule);
    watchedPage = page;
    watchedPage?.on('nodechange', schedule);
  };
  const onPage = (): void => {
    invalidate();
    updateWatch();
    if (config !== null) {
      for (const c of config.roots) {
        const previous = states.get(c.rootId);
        if (previous?.status !== 'error')
          states.set(c.rootId, {
            ...previous,
            rootId: c.rootId,
            status: enabled ? 'paused' : 'disabled',
          });
      }
    }
    schedule();
  };
  const start = (): void => {
    if (started || disposed) return;
    started = true;
    const saved = figmaCtx.root.getPluginData(KEY);
    if (saved !== '') {
      try {
        const parsed = SavedSchema.parse(JSON.parse(saved));
        validateRules(parsed.config);
        config = parsed.config;
        enabled = parsed.enabled;
      } catch (error) {
        enabled = false;
        config = null;
        loadError = `Saved responsive configuration rejected: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (figmaCtx.editorType === 'figma') {
      figmaCtx.on('currentpagechange', onPage);
      updateWatch();
    }
    schedule();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    enabled = false;
    invalidate();
    updateWatch();
    if (started && figmaCtx.editorType === 'figma') figmaCtx.off('currentpagechange', onPage);
    for (const state of states.values()) if (state.status !== 'error') state.status = 'disabled';
  };
  return { configure, get, start, dispose };
};
