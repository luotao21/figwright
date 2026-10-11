import {
  PrivateResponsiveLayoutConfigSchema,
  ResponsiveLayoutConfigureInputSchema,
  SavedResponsiveLayoutSchema,
} from '@figwright/shared';
import { z } from 'zod';

import { createPrivateResponsiveLayoutController } from './private-responsive-layout.js';
import { createResponsiveLayoutController } from './responsive-layout.js';

type Source = 'public' | 'private' | 'none';
type Controller = {
  configure(params: unknown): Promise<unknown>;
  get(): object;
  start(): void;
  dispose(): void;
};
const OWNER_SLOT = 'responsive_layout_private_owner';
const OwnerSchema = z.strictObject({
  version: z.literal(1),
  source: z.enum(['public', 'private', 'none']),
});
const LegacySavedSchema = z.object({
  enabled: z.boolean(),
  config: PrivateResponsiveLayoutConfigSchema,
});

/** Local-only compatibility. The public tool schema remains unchanged. */
export const createPrivateResponsiveController = (api: typeof figma) => {
  let source: Source = 'none';
  let active: Controller | null = null;
  let activeStarted = false;
  let started = false;
  let disposed = false;
  let revision = 0;
  let error: { phase: 'load' | 'configure'; message: string } | undefined;
  const get = () => ({
    ...(active?.get() ?? { enabled: false, config: null, roots: [] }),
    source,
    ...(error === undefined ? {} : { error }),
  });
  const select = (next: Source, loadSaved = true): void => {
    if (source === next && active !== null) return;
    active?.dispose();
    active = null;
    activeStarted = false;
    source = next;
    if (next === 'public') active = createResponsiveLayoutController(api);
    if (next === 'private') active = createPrivateResponsiveLayoutController(api);
    if (started && loadSaved && active !== null) {
      active.start();
      activeStarted = true;
    }
  };
  const start = (): void => {
    if (started || disposed) return;
    started = true;
    const savedOwner = api.root.getPluginData(OWNER_SLOT);
    try {
      if (savedOwner !== '') {
        select(OwnerSchema.parse(JSON.parse(savedOwner)).source);
        return;
      }
      const publicData = api.root.getPluginData('responsive_layout');
      if (publicData !== '') {
        // A rejected public save is surfaced by the public controller; never silently fall back.
        const publicSave = SavedResponsiveLayoutSchema.safeParse(
          (() => {
            try {
              return JSON.parse(publicData) as unknown;
            } catch {
              return null;
            }
          })(),
        );
        if (!publicSave.success || publicSave.data.enabled) {
          select('public');
          return;
        }
      }
      const privateData = api.root.getPluginData('responsive_layout_v1');
      if (privateData !== '') {
        const parsed = LegacySavedSchema.parse(JSON.parse(privateData));
        if (parsed.enabled) select('private');
      }
    } catch (cause) {
      error = { phase: 'load', message: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  const configure = async (params: unknown): Promise<unknown> => {
    if (disposed) throw new Error('Private responsive facade is disposed');
    // Reject legacy/unknown product input before changing the active owner.
    const input = ResponsiveLayoutConfigureInputSchema.parse(params);
    start();
    const token = ++revision;
    error = undefined;
    if (input.config !== undefined && source !== 'public') {
      // A replacement must not temporarily activate the unselected public save.
      select('public', false);
      api.root.setPluginData(OWNER_SLOT, JSON.stringify({ version: 1, source: 'none' }));
    } else if (source === 'none' && input.enabled) select('public');
    try {
      const result = active === null ? {} : await active.configure(input);
      if (disposed || token !== revision)
        throw new Error('Responsive configuration was superseded');
      if (active !== null && !activeStarted) {
        if ((active.get() as { config: unknown }).config === null) select('none');
        else {
          active.start();
          activeStarted = true;
        }
      }
      // Persist only an explicit accepted choice; none cannot revive another saved config.
      api.root.setPluginData(OWNER_SLOT, JSON.stringify({ version: 1, source }));
      return { ...(result as object), ...get() };
    } catch (cause) {
      if (!disposed && token === revision) {
        if (active !== null && !activeStarted) {
          select('none');
          api.root.setPluginData(OWNER_SLOT, JSON.stringify({ version: 1, source }));
        }
        error = {
          phase: 'configure',
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      throw cause;
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    revision++;
    active?.dispose();
  };
  return { configure, get, start, dispose };
};
