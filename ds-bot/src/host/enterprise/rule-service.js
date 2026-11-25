import { absoluteRulePath, matchRules } from './file-authorization.js'
import { createEmployeeRuleReader } from './rule-store.js'

export function createRuleReservationGate({ ruleFile, resolveTarget, canReserve }) {
  const readRules = createEmployeeRuleReader(ruleFile)
  return scope => {
    try {
      if (canReserve && canReserve(scope) !== true) return false
      const path = resolveTarget?.(scope.targetId, scope)
      if (!absoluteRulePath(path)) return false
      const matched = matchRules(readRules(), { ...scope, path })
      return matched?.version === scope.ruleVersion && matched.rule.id === scope.ruleId
    } catch { return false }
  }
}
