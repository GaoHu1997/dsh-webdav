/**
 * dsh-webdav-sync browser half.
 *
 * Two seats, one card: the keyed `plugins.bundle.config` entry on the Plugins
 * page (keyed by this package's npm name, the key the page dispatches by) and a
 * `settings.section` page reachable from Settings directly. Both render
 * `WebdavSyncCard`'s body and both are fed by the host half's routes — the
 * browser half never reads a profile file and never speaks WebDAV.
 *
 * The bundle card is seated only once the Host serves this plugin's namespace,
 * so a deployment that did not compose the host half shows no trace of it. The
 * Settings page is registered unconditionally, because it is the page a user
 * opens when something is wrong and it must still be there to say so.
 *
 * @module webdav-sync/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-settings SlotMap merge ('settings.section') and the
// configForms service declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-plugin-manager keyed-slot declarations
// ('plugins.bundle.config' and siblings) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the ui-renderer merge (ctx.slots, the SlotRegistry) in.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { WebdavSyncBundleCard, WebdavSyncSection } from './WebdavSyncCard.tsx'
import { WebdavSyncCard as CardModel, type CardActions } from './card-store.ts'
import { directoryChooser } from './picker.ts'
import { en, NS, zh } from './locales.ts'

export type { WebdavSyncKey } from './locales.ts'
export type { CardActions, CardState, CardStore } from './card-store.ts'

/**
 * Host composition entry id from `cordis.patch.yml`.
 *
 * Configuration forms are addressed by it; the locale and route namespaces are
 * independent. Kept client-local because the browser bundle must not import the
 * host half.
 */
const PLUGIN_ENTRY_ID = 'dsh-webdav-sync'

/**
 * This package's own name — the key `plugins.bundle.config` dispatches by. It
 * matches the `cordis.patch.yml` entry's `name` verbatim.
 */
const PLUGIN_PACKAGE = 'dsh-webdav-sync'

/** The nav place of the Settings page. Deliberately near the top: the settings
 * nav column has no scrollbar and a fixed height, so a late order is clipped
 * out of reach in a short window. */
const SECTION_ORDER = 22

export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the card in both seats.
 *
 * @param ctx - the client context, with slots, locale and configForms injected.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'webdav-sync: dictionaries')

  const model = new CardModel(directoryChooser(ctx))
  const bound = model.actions()
  const t = ctx.locale.bind(NS)

  /**
   * The registration-side face both seats inject. The store rides the reserved
   * `hooks` compartment, so the renderer binds it as the `useWebdavSync` prop.
   */
  const face = (): { hooks: { webdavSync: CardModel } } & CardActions => ({
    ...bound,
    hooks: { webdavSync: model },
  })

  ctx.effect(
    () => ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'webdav-sync',
          order: SECTION_ORDER,
          label: () => t('sectionTitle'),
          locale: NS,
          inject: face,
        },
        WebdavSyncSection,
      )),
    'webdav-sync: settings page',
  )

  // The bundle card exists only while the Host serves this plugin's namespace:
  // a Plugins page with no bundle row must not sprout a card.
  let bundleCard: (() => void) | undefined
  const seatBundleCard = (): void => {
    const snapshot = describe.getSnapshot()
    const served = snapshot.status === 'ready'
      && (snapshot.view?.namespaces.some((entry) => entry.ns === PLUGIN_ENTRY_ID) ?? false)
    if (served && bundleCard === undefined) {
      bundleCard = ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: PLUGIN_PACKAGE, locale: NS, inject: face },
          WebdavSyncBundleCard,
        ))
      return
    }
    if (!served && bundleCard !== undefined) {
      bundleCard()
      bundleCard = undefined
    }
  }

  const describe = ctx.configForms.describe()
  const unsubscribe = describe.subscribe(seatBundleCard)
  void describe.ensure()
  seatBundleCard()

  ctx.effect(() => () => {
    unsubscribe()
    if (bundleCard !== undefined) bundleCard()
  }, 'webdav-sync: bundle card seat')
}
