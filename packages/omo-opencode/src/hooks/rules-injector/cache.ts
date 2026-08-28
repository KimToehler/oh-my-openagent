import { clearInjectedRules, loadInjectedRules } from "./storage";
import {
	createRuleDiscoveryCache,
	type RuleDiscoveryCache,
} from "@oh-my-opencode/rules-engine/engine";

export type SessionInjectedRulesCache = {
  contentHashes: Set<string>;
  realPaths: Set<string>;
  compactionEpoch?: string;
};

export function createSessionCacheStore(): {
  getSessionCache: (sessionID: string) => SessionInjectedRulesCache;
  clearSessionCache: (sessionID: string) => void;
} {
  const sessionCaches = new Map<string, SessionInjectedRulesCache>();

  function getSessionCache(sessionID: string): SessionInjectedRulesCache {
    const existingCache = sessionCaches.get(sessionID);
    if (existingCache !== undefined) {
      return existingCache;
    }

    const cache = loadInjectedRules(sessionID);
    sessionCaches.set(sessionID, cache);
    return cache;
  }

  function clearSessionCache(sessionID: string): void {
    sessionCaches.delete(sessionID);
    clearInjectedRules(sessionID);
  }

  return { getSessionCache, clearSessionCache };
}

export function createSessionRuleScanCacheStore(): {
  getSessionRuleScanCache: (sessionID: string) => RuleDiscoveryCache;
  clearSessionRuleScanCache: (sessionID: string) => void;
} {
  const sessionCaches = new Map<string, RuleDiscoveryCache>();

  function getSessionRuleScanCache(sessionID: string): RuleDiscoveryCache {
    const existingCache = sessionCaches.get(sessionID);
    if (existingCache) {
      return existingCache;
    }

    const cache = createRuleDiscoveryCache();
    sessionCaches.set(sessionID, cache);
    return cache;
  }

  function clearSessionRuleScanCache(sessionID: string): void {
    const cache = sessionCaches.get(sessionID);
    cache?.scannedRuleFiles.clear();
    cache?.singleFileInfo.clear();
    sessionCaches.delete(sessionID);
  }

  return { getSessionRuleScanCache, clearSessionRuleScanCache };
}
