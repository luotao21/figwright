import { z } from 'zod';

const id = z.string().min(1);

/** Opt-in layout ownership. No implicit page scan, component creation, or token creation. */
export const PrivateResponsiveLayoutConfigSchema = z.object({
  fileName: id,
  pageId: id,
  mobileBelow: z.number().positive(),
  gap: z.number().nonnegative(),
  gapVariableId: id.optional(),
  rules: z
    .array(
      z.object({
        minWidth: z.number().nonnegative(),
        columns: z.number().int().positive().max(24),
        paddingX: z.number().nonnegative(),
        paddingVariableId: id.optional(),
        maxContentWidth: z.number().positive(),
      }),
    )
    .min(1)
    .max(24),
  roots: z
    .array(
      z.object({
        rootId: id,
        mainId: id,
        bodyId: id,
        sectionIds: z.array(id).min(1),
        gridIds: z.array(id).min(1),
        sidebarId: id.optional(),
        mobileHeaderId: id.optional(),
        navigation: z
          .object({
            instanceId: id,
            tabsNodeId: id,
            tabsProperty: id,
            selectProperty: id,
          })
          .optional(),
      }),
    )
    .min(1)
    .max(32),
});

export type PrivateResponsiveLayoutConfig = z.infer<typeof PrivateResponsiveLayoutConfigSchema>;
