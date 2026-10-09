import { browserAPI } from './shared/browser-api.js';
import { DEBUG_MODE } from './shared/logger.js';
import {
  initializePlatform,
  loadCustomColors,
  createOrUpdateContextMenus,
} from './background/settings-service.js';
import { initContextMenus } from './background/context-menu.js';
import { registerMessageRouter } from './background/message-router.js';
import { initSiteRuleService, subscribeSitePolicyChanges } from './background/site-rule-service.js';
import { initBackupService } from './background/backup-service.js';
import { openGuideOnInstall } from './background/onboarding.js';

// ===================================================================
// Top-level listener registration
// Service worker may restart at any time; listeners must be registered
// synchronously at the top level to avoid event loss on restart.
// ===================================================================

registerMessageRouter();

initContextMenus();

// The backup alarm can be what wakes a service worker, so its listener has to
// be registered here rather than after the async startup below.
initBackupService();

// The menu items spell out what the site rules currently allow on the page on
// screen, so a rule change has to redraw them. Routing it through the service
// means the popup, the context menu and the settings page all get the redraw
// from their own write.
subscribeSitePolicyChanges(() => {
  createOrUpdateContextMenus().catch(e => console.error('Context menu refresh failed', e));
});

browserAPI.runtime.onInstalled.addListener(async (details) => {
  if (DEBUG_MODE) console.log('Extension installed/updated. Debug mode:', DEBUG_MODE);
  await openGuideOnInstall(details);
});

// ===================================================================
// Async initialization
// ===================================================================

(async () => {
  try {
    await initializePlatform();
    await loadCustomColors();
    await initSiteRuleService();
    await createOrUpdateContextMenus();
  } catch (e) {
    console.error('Initialization error in background script', e);
  }
})();
